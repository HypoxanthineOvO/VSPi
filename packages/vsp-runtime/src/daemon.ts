import { randomUUID } from 'node:crypto';

import { startServer } from '@moonshot-ai/kap-server';
import { serveKlientIpc } from '@moonshot-ai/klient/ipc';
import { ISessionManager, IAgentLifecycleService, IAgentActivityView, IAgentTaskService, AgentCron, AgentGoal } from '@moonshot-ai/agent-core-v2';

import './feature-defaults.js';

import {
  migrateRuntimeConfig,
  type MigrateRuntimeConfigOptions,
} from './config-migration.js';
import { acquireRuntimeLease } from './lease.js';
import { resolveRuntimePaths } from './paths.js';
import { removeRuntimeState, writeRuntimeState, writeRuntimeShutdown, writeRuntimeShutdownIntent, type RuntimeShutdownIntent } from './state.js';
import {
  VSP_RUNTIME_PROTOCOL_VERSION,
  type RuntimeDaemon,
  type RuntimeHostIdentity,
  type RuntimeState,
} from './types.js';

export interface StartRuntimeDaemonOptions {
  readonly homeDir?: string;
  readonly hostIdentity: RuntimeHostIdentity;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly skillDirs?: readonly string[];
  readonly configMigration?: Omit<MigrateRuntimeConfigOptions, 'homeDir' | 'env' | 'osHomeDir' | 'agentDir'>;
  readonly startServer?: typeof startServer;
  readonly idleTimeoutMs?: number;
}

export async function startRuntimeDaemon(options: StartRuntimeDaemonOptions): Promise<RuntimeDaemon> {
  const idleTimeoutMs = options.idleTimeoutMs ?? Number(options.env?.['VSPI_DAEMON_IDLE_TIMEOUT_MS'] ?? 5000);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2_147_483_647) throw new Error('VSPI_DAEMON_IDLE_TIMEOUT_MS must be an integer between 0 and 2147483647');
  const paths = resolveRuntimePaths(options.homeDir);
  const ownerNonce = randomUUID();
  const lease = await acquireRuntimeLease(paths.leasePath, ownerNonce);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let ipc: Awaited<ReturnType<typeof serveKlientIpc>> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  let closePromise: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const close = (reason: RuntimeShutdownIntent['reason'] = 'stop'): Promise<void> => {
    ipc?.beginShutdown();
    clearInterval(idleTimer);
    closePromise ??= (async () => {
      try { await writeRuntimeShutdownIntent(paths.serverDir, { ownerNonce, reason }); }
      finally {
        try { await ipc?.close(); }
        finally {
          try { await server?.close(); }
          finally {
            try { await removeRuntimeState(paths.statePath, process.pid); }
            finally { await lease.release(); }
          }
        }
      }
    })().then(async () => {
      await writeRuntimeShutdown(paths.serverDir, { ownerNonce, success: true });
      resolveClosed();
    }).catch(async (error: unknown) => {
      await writeRuntimeShutdown(paths.serverDir, { ownerNonce, success: false, error: error instanceof Error ? error.message.slice(0, 512) : 'Runtime cleanup failed' }).catch(() => {});
      rejectClosed(error);
      throw error;
    });
    return closePromise;
  };
  const inspectWork = () => {
    const busyAgents: string[] = [];
    const scheduledAgents: string[] = [];
    for (const session of server!.core.accessor.get(ISessionManager).list()) {
      const agents = session.accessor.get(IAgentLifecycleService);
      for (const agent of agents.list()) {
        const handle = agents.handleOf(agent.agentId);
        if (!handle) continue;
        const id = `${session.id}/${agent.agentId}`;
        const activity = handle.accessor.get(IAgentActivityView).state();
        if (activity.turn || activity.background.length > 0 || handle.accessor.get(IAgentTaskService).list(true).length > 0) busyAgents.push(id);
        if (agents.resolve(agent, AgentCron).list().length > 0 || agents.resolve(agent, AgentGoal).getGoal().goal?.status === 'active') scheduledAgents.push(id);
      }
    }
    return { busyAgents, scheduledAgents };
  };
  try {
    const migration = await migrateRuntimeConfig({
      ...options.configMigration,
      homeDir: paths.homeDir,
      osHomeDir: options.env?.['HOME'],
      agentDir: options.env?.['PI_CODING_AGENT_DIR'],
      env: options.env ?? process.env,
    });
    server = await (options.startServer ?? startServer)({
      host: '127.0.0.1',
      port: options.port ?? 0,
      homeDir: paths.homeDir,
      env: options.env ?? process.env,
      hostIdentity: options.hostIdentity,
      skillDirs: options.skillDirs,
      serverVersion: options.hostIdentity.version,
      telemetry: false,
    });
    ipc = await serveKlientIpc({
      scope: server.core,
      socketPath: paths.ipcPath,
      token: server.authTokenService.getToken(),
      handshakeData: {
        pid: process.pid,
        ownerNonce,
        homeDir: paths.homeDir,
        migrationWarning: migration.warning,
        controlProtocol: 1,
      },
      control: (method, args, peers, calls, streams) => {
        const request = args[0] as { ownerNonce?: unknown; requireIdle?: unknown } | undefined;
        if (!request || request.ownerNonce !== ownerNonce) throw new Error('Runtime control ownership mismatch');
        const { busyAgents, scheduledAgents } = inspectWork();
        const data = { busyAgents, scheduledAgents, clients: Math.max(0, peers - 1), pendingCalls: calls, pendingStreams: streams };
        if (method === 'inspect') return { data };
        if (method !== 'shutdown') throw new Error('Unknown runtime control method');
        if (request.requireIdle === true && (busyAgents.length > 0 || scheduledAgents.length > 0 || calls > 0 || streams > 0)) throw new Error(`Runtime has active work (${busyAgents.length} agents, ${scheduledAgents.length} scheduled agents, ${calls} calls, ${streams} streams); confirm interruption before updating`);
        return { data: { accepted: true }, afterReply: () => close(request.requireIdle === true ? 'update' : 'stop') };
      },
    });
    const state: RuntimeState = {
      protocolVersion: VSP_RUNTIME_PROTOCOL_VERSION,
      pid: process.pid,
      ownerNonce,
      host: server.host,
      port: server.port,
      ipcPath: ipc.socketPath,
      startedAt: new Date().toISOString(),
      version: options.hostIdentity.version,
      migrationWarning: migration.warning,
    };
    await writeRuntimeState(paths.statePath, state);
    if (idleTimeoutMs > 0) {
      let idleSince = Date.now();
      idleTimer = setInterval(() => {
        const activity = ipc!.activity();
        if (activity.clients > 0 || activity.pendingCalls > 0 || activity.pendingStreams > 0) { idleSince = Date.now(); return; }
        if (Date.now() - idleSince < idleTimeoutMs) return;
        try {
          const work = inspectWork();
          if (work.busyAgents.length > 0 || work.scheduledAgents.length > 0) { idleSince = Date.now(); return; }
          void close('idle').catch(() => {});
        } catch { idleSince = Date.now(); }
      }, Math.min(1000, Math.max(10, Math.floor(idleTimeoutMs / 4))));
      idleTimer.unref();
    }
    return {
      state,
      closed,
      close,
    };
  } catch (error) {
    await ipc?.close().catch(() => {});
    await server?.close().catch(() => {});
    await removeRuntimeState(paths.statePath, process.pid).catch(() => {});
    await lease.release().catch(() => {});
    throw error;
  }
}
