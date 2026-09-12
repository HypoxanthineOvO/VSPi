import { appendFile, readFile } from 'node:fs/promises';

import { createKlient, probeKlientIpc, callKlientIpcControl } from '@moonshot-ai/klient/ipc';

import { resolveRuntimePaths } from './paths.js';
import {
  assertCompatibleRuntimeState,
  isProcessAlive,
  readRuntimeState,
  removeRuntimeState,
  readRuntimeShutdown,
} from './state.js';
import type {
  RuntimeConnection,
  RuntimeSpawner,
  RuntimeState,
} from './types.js';
import { parseRuntimeMigrationWarning } from './config-migration.js';
import { recoverRuntimeLease } from './lease.js';

export interface RuntimeConnectionOptions {
  readonly callTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

export interface EnsureRuntimeOptions extends RuntimeConnectionOptions {
  readonly homeDir?: string;
  readonly spawn: RuntimeSpawner;
  readonly timeoutMs?: number;
}

export async function inspectRuntime(homeDir?: string): Promise<RuntimeState | undefined> {
  const paths = resolveRuntimePaths(homeDir);
  const state = await readRuntimeState(paths.statePath);
  if (state === undefined) return undefined;
  if (isProcessAlive(state.pid)) return state;
  await appendFile(paths.logPath, `${JSON.stringify({
    event: 'runtime.stale-state-removed',
    time: new Date().toISOString(),
    previousPid: state.pid,
    previousVersion: state.version,
    previousStartedAt: state.startedAt,
  })}\n`, { mode: 0o600 }).catch(() => {});
  await removeRuntimeState(paths.statePath, state.pid);
  return undefined;
}

export async function connectRuntime(homeDir?: string, options: RuntimeConnectionOptions = {}): Promise<RuntimeConnection> {
  const deadline = Date.now() + (options.connectionTimeoutMs ?? 10_000);
  const paths = resolveRuntimePaths(homeDir);
  const state = await readRuntimeState(paths.statePath);
  if (state === undefined || !isProcessAlive(state.pid)) throw new Error('VSP runtime is not running');
  assertCompatibleRuntimeState(state);
  const token = (await readFile(paths.tokenPath, 'utf8')).trim();
  if (token.length === 0) throw new Error('VSP runtime token is empty');
  const handshake = await probeKlientIpc({ socketPath: state.ipcPath, token, handshakeTimeoutMs: remainingConnectionTime(deadline) });
  assertOwnedRuntime(state, handshake, paths.homeDir);
  const klient = createKlient({ socketPath: state.ipcPath, token, callTimeoutMs: options.callTimeoutMs, handshakeTimeoutMs: remainingConnectionTime(deadline) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const env = await Promise.race([
      klient.global.env(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('VSP runtime connection timed out')); }, remainingConnectionTime(deadline));
        timer.unref();
      }),
    ]);
    if (env.homeDir !== paths.homeDir) throw new Error(`VSP runtime home mismatch: ${env.homeDir}`);
    const migrationWarning = parseMigrationWarning(handshake) ?? state.migrationWarning;
    return { state, env, klient, migrationWarning, close: () => klient.close() };
  } catch (error) {
    await klient.close();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function ensureRuntime(options: EnsureRuntimeOptions): Promise<RuntimeConnection> {
  const paths = resolveRuntimePaths(options.homeDir);
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const connect = (connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000) => connectRuntime(paths.homeDir, {
    callTimeoutMs: options.callTimeoutMs,
    connectionTimeoutMs: Math.min(connectionTimeoutMs, remainingConnectionTime(deadline)),
  });
  if ((await inspectRuntime(paths.homeDir)) !== undefined) {
    try {
      return await connect(options.connectionTimeoutMs ?? 5_000);
    } catch {
      await delay(Math.max(0, Math.min(250, deadline - Date.now())));
      try {
        return await connect();
      } catch (connectError) {
        throw new Error('VSP runtime is alive but unreachable or incompatible; it has not been stopped. Existing tasks are preserved. Inspect the runtime or explicitly stop it after confirming no work will be lost.', { cause: connectError });
      }
    }
  }
  await options.spawn({ homeDir: paths.homeDir, logPath: paths.logPath });
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      await delay(Math.max(0, Math.min(50, deadline - Date.now())));
    }
  }
  throw new Error(
    `VSP runtime did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function stopRuntime(homeDir?: string, timeoutMs = 10_000, options: { requireIdle?: boolean; forceLegacy?: boolean } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const paths = resolveRuntimePaths(homeDir);
  const state = await inspectRuntime(paths.homeDir);
  if (state === undefined) return false;
  const token = (await readFile(paths.tokenPath, 'utf8')).trim();
  if (token.length === 0) throw new Error('VSP runtime ownership cannot be proven: token is empty');
  const handshake = await probeKlientIpc({ socketPath: state.ipcPath, token, handshakeTimeoutMs: Math.min(remainingConnectionTime(deadline), 5_000) });
  assertOwnedRuntime(state, handshake, paths.homeDir);
  await appendFile(paths.logPath, `${JSON.stringify({ event: 'runtime.stop-requested', time: new Date().toISOString(), callerPid: process.pid, targetPid: state.pid })}\n`, { mode: 0o600 }).catch(() => {});
  const graceful = (handshake as { controlProtocol?: number }).controlProtocol === 1;
  if (graceful) {
    await callKlientIpcControl({ socketPath: state.ipcPath, token, handshakeTimeoutMs: remainingConnectionTime(deadline), callTimeoutMs: remainingConnectionTime(deadline) }, 'shutdown', [{ ownerNonce: state.ownerNonce, requireIdle: options.requireIdle }]);
  } else {
    if (options.requireIdle || process.platform === 'win32' && !options.forceLegacy) throw new Error('Legacy runtime has no safe shutdown protocol; finish all its tasks before using vspi daemon stop --force-legacy. This explicitly permits termination of the authenticated old instance.');
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  }
  while (Date.now() < deadline) {
    if (graceful) {
      const receipt = await readRuntimeShutdown(paths.serverDir);
      if (receipt?.ownerNonce === state.ownerNonce) {
        if (!receipt.success) throw new Error(`Runtime cleanup failed: ${receipt.error ?? 'unknown failure'}`);
        return true;
      }
      if (!isProcessAlive(state.pid)) throw new Error('Runtime exited without a successful cleanup confirmation');
      await delay(50);
      continue;
    }
    if (!isProcessAlive(state.pid)) return true;
    const current = await readRuntimeState(paths.statePath);
    if (current?.ownerNonce !== state.ownerNonce) return true;
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

function remainingConnectionTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('VSP runtime connection timed out');
  return remaining;
}

export async function recoverRuntime(homeDir?: string): Promise<void> {
  const paths = resolveRuntimePaths(homeDir);
  const state = await readRuntimeState(paths.statePath);
  if (state && isProcessAlive(state.pid)) throw new Error('Runtime process is still alive; recovery refuses to remove its lock');
  await recoverRuntimeLease(paths.leasePath);
  if (state) await removeRuntimeState(paths.statePath, state.pid);
}
