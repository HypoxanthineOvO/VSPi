import { randomUUID } from 'node:crypto';

import { startServer } from '@moonshot-ai/kap-server';
import { serveKlientIpc } from '@moonshot-ai/klient/ipc';

import './feature-defaults.js';

import {
  migrateRuntimeConfig,
  type MigrateRuntimeConfigOptions,
} from './config-migration.js';
import { acquireRuntimeLease } from './lease.js';
import { resolveRuntimePaths } from './paths.js';
import { removeRuntimeState, writeRuntimeState } from './state.js';
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
  readonly configMigration?: Omit<MigrateRuntimeConfigOptions, 'homeDir' | 'env' | 'osHomeDir' | 'agentDir'>;
  readonly startServer?: typeof startServer;
}

export async function startRuntimeDaemon(options: StartRuntimeDaemonOptions): Promise<RuntimeDaemon> {
  const paths = resolveRuntimePaths(options.homeDir);
  const ownerNonce = randomUUID();
  const lease = await acquireRuntimeLease(paths.leasePath, ownerNonce);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let ipc: Awaited<ReturnType<typeof serveKlientIpc>> | undefined;
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
    let closed = false;
    return {
      state,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await ipc?.close();
        } finally {
          try {
            await server?.close();
          } finally {
            try {
              await removeRuntimeState(paths.statePath, process.pid);
            } finally {
              await lease.release();
            }
          }
        }
      },
    };
  } catch (error) {
    await ipc?.close().catch(() => {});
    await server?.close().catch(() => {});
    await removeRuntimeState(paths.statePath, process.pid).catch(() => {});
    await lease.release().catch(() => {});
    throw error;
  }
}
