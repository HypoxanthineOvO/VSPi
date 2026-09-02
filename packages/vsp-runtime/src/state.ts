import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseRuntimeMigrationWarning } from './config-migration.js';
import { VSP_RUNTIME_PROTOCOL_VERSION, type RuntimeState } from './types.js';

export async function readRuntimeState(statePath: string): Promise<RuntimeState | undefined> {
  let text: string;
  try {
    text = await readFile(statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return parseRuntimeState(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export async function writeRuntimeState(statePath: string, state: RuntimeState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(statePath), 0o700);
  const temporaryPath = `${statePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let handle: FileHandle | undefined;
  let completed = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, statePath);
    completed = true;
  } finally {
    await handle?.close().catch(() => {});
    if (!completed) await rm(temporaryPath, { force: true });
  }
}

export async function removeRuntimeState(statePath: string, pid?: number): Promise<void> {
  if (pid !== undefined) {
    const current = await readRuntimeState(statePath);
    if (current !== undefined && current.pid !== pid) return;
  }
  await rm(statePath, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRuntimeState(value: unknown): RuntimeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runtime state must be an object');
  }
  const state = value as Record<string, unknown>;
  const protocolVersion = integer(state['protocolVersion']);
  const pid = integer(state['pid']);
  const ownerNonce = string(state['ownerNonce']);
  const port = integer(state['port']);
  const host = string(state['host']);
  const ipcPath = string(state['ipcPath']);
  const startedAt = string(state['startedAt']);
  const version = string(state['version']);
  const migrationWarning = parseRuntimeMigrationWarning(state['migrationWarning']);
  if (protocolVersion < 1 || pid < 1 || port < 1 || port > 65535) {
    throw new Error('runtime state has invalid numeric fields');
  }
  return { protocolVersion, pid, ownerNonce, port, host, ipcPath, startedAt, version, migrationWarning };
}

function integer(value: unknown): number {
  if (!Number.isInteger(value)) throw new Error('expected integer');
  return value as number;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('expected string');
  return value;
}

export function assertCompatibleRuntimeState(state: RuntimeState): void {
  if (state.protocolVersion !== VSP_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `VSP runtime protocol ${String(state.protocolVersion)} is incompatible with client protocol ${String(VSP_RUNTIME_PROTOCOL_VERSION)}`,
    );
  }
}
