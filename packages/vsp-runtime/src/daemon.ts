import { randomUUID } from 'node:crypto';

import { startServer } from '@moonshot-ai/kap-server';
import { serveKlientIpc } from '@moonshot-ai/klient/ipc';
import { ISessionManager, IAgentLifecycleService, IAgentActivityView, IAgentTaskService } from '@moonshot-ai/agent-core-v2';

import './feature-defaults.js';

import {
  migrateRuntimeConfig,
  type MigrateRuntimeConfigOptions,
} from './config-migration.js';
import { acquireRuntimeLease } from './lease.js';
import { resolveRuntimePaths } from './paths.js';
import { removeRuntimeState, writeRuntimeState, writeRuntimeShutdown } from './state.js';
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
}

export async function startRuntimeDaemon(options: StartRuntimeDaemonOptions): Promise<RuntimeDaemon> {
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
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try { await ipc?.close(); }
      finally {
        try { await server?.close(); }
        finally {
          try { await removeRuntimeState(paths.statePath, process.pid); }
          finally { await lease.release(); }
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
      control: (method, args, peers, calls) => {
        const request = args[0] as { ownerNonce?: unknown; requireIdle?: unknown } | undefined;
        if (!request || request.ownerNonce !== ownerNonce) throw new Error('Runtime control ownership mismatch');
        const busyAgents: string[] = [];
        for (const session of server!.core.accessor.get(ISessionManager).list()) {
          const agents = session.accessor.get(IAgentLifecycleService);
          for (const agent of agents.list()) {
            const handle = agents.handleOf(agent.agentId);
            if (!handle) continue;
            const activity = handle.accessor.get(IAgentActivityView).state();
            if (activity.turn || activity.background.length > 0 || handle.accessor.get(IAgentTaskService).list(true).length > 0) busyAgents.push(`${session.id}/${agent.agentId}`);
          }
        }
        const data = { busyAgents, clients: Math.max(0, peers - 1), pendingCalls: calls };
        if (method === 'inspect') return { data };
        if (method !== 'shutdown') throw new Error('Unknown runtime control method');
        if (request.requireIdle === true && (busyAgents.length > 0 || peers > 1 || calls > 0)) throw new Error('Runtime is in use; finish tasks and close connected clients before updating');
        return { data: { accepted: true }, afterReply: close };
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
