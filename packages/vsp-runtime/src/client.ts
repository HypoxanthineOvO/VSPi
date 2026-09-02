import { readFile } from 'node:fs/promises';

import { createKlient, probeKlientIpc } from '@moonshot-ai/klient/ipc';

import { resolveRuntimePaths } from './paths.js';
import {
  assertCompatibleRuntimeState,
  isProcessAlive,
  readRuntimeState,
  removeRuntimeState,
} from './state.js';
import type {
  RuntimeConnection,
  RuntimeSpawner,
  RuntimeState,
} from './types.js';
import { parseRuntimeMigrationWarning } from './config-migration.js';

export interface EnsureRuntimeOptions {
  readonly homeDir?: string;
  readonly spawn: RuntimeSpawner;
  readonly timeoutMs?: number;
}

export async function inspectRuntime(homeDir?: string): Promise<RuntimeState | undefined> {
  const paths = resolveRuntimePaths(homeDir);
  const state = await readRuntimeState(paths.statePath);
  if (state === undefined) return undefined;
  if (isProcessAlive(state.pid)) return state;
  await removeRuntimeState(paths.statePath, state.pid);
  return undefined;
}

export async function connectRuntime(homeDir?: string, callTimeoutMs = 10_000): Promise<RuntimeConnection> {
  const paths = resolveRuntimePaths(homeDir);
  const state = await inspectRuntime(paths.homeDir);
  if (state === undefined) throw new Error('VSP runtime is not running');
  assertCompatibleRuntimeState(state);
  const token = (await readFile(paths.tokenPath, 'utf8')).trim();
  if (token.length === 0) throw new Error('VSP runtime token is empty');
  const handshake = await probeKlientIpc({ socketPath: state.ipcPath, token, callTimeoutMs });
  assertOwnedRuntime(state, handshake, paths.homeDir);
  const klient = createKlient({ socketPath: state.ipcPath, token, callTimeoutMs });
  try {
    const env = await klient.global.env();
    if (env.homeDir !== paths.homeDir) throw new Error(`VSP runtime home mismatch: ${env.homeDir}`);
    const migrationWarning = parseMigrationWarning(handshake) ?? state.migrationWarning;
    return { state, env, klient, migrationWarning, close: () => klient.close() };
  } catch (error) {
    await klient.close();
    throw error;
  }
}

export async function ensureRuntime(options: EnsureRuntimeOptions): Promise<RuntimeConnection> {
  const paths = resolveRuntimePaths(options.homeDir);
  if ((await inspectRuntime(paths.homeDir)) !== undefined) {
    try {
      return await connectRuntime(paths.homeDir, 5_000);
    } catch {
      await delay(250);
      try {
        return await connectRuntime(paths.homeDir);
      } catch (connectError) {
        try {
          await stopRuntime(paths.homeDir, 5_000);
        } catch (stopError) {
          throw new AggregateError(
            [connectError, stopError],
            'VSP runtime is unreachable and could not be restarted',
          );
        }
      }
    }
  }
  await options.spawn({ homeDir: paths.homeDir, logPath: paths.logPath });
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectRuntime(paths.homeDir);
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw new Error(
    `VSP runtime did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function stopRuntime(homeDir?: string, timeoutMs = 10_000): Promise<boolean> {
  const paths = resolveRuntimePaths(homeDir);
  const state = await inspectRuntime(paths.homeDir);
  if (state === undefined) return false;
  const token = (await readFile(paths.tokenPath, 'utf8')).trim();
  if (token.length === 0) throw new Error('VSP runtime ownership cannot be proven: token is empty');
  const handshake = await probeKlientIpc({ socketPath: state.ipcPath, token, callTimeoutMs: Math.min(timeoutMs, 5_000) });
  assertOwnedRuntime(state, handshake, paths.homeDir);
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) return true;
    await delay(50);
  }
  throw new Error(`VSP runtime pid ${String(state.pid)} did not stop within ${String(timeoutMs)}ms`);
}

function assertOwnedRuntime(state: RuntimeState, handshake: unknown, homeDir: string): void {
  if (
    typeof handshake !== 'object' ||
    handshake === null ||
    (handshake as Record<string, unknown>)['pid'] !== state.pid ||
    (handshake as Record<string, unknown>)['ownerNonce'] !== state.ownerNonce ||
    (handshake as Record<string, unknown>)['homeDir'] !== homeDir
  ) {
    throw new Error('VSP runtime ownership cannot be proven');
  }
}

function parseMigrationWarning(handshake: unknown) {
  if (typeof handshake !== 'object' || handshake === null) return undefined;
  return parseRuntimeMigrationWarning((handshake as Record<string, unknown>)['migrationWarning']);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
