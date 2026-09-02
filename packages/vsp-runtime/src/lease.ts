import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isProcessAlive } from './state.js';

export class RuntimeAlreadyRunningError extends Error {
  constructor(readonly pid: number | undefined) {
    super(pid === undefined ? 'VSP runtime is already starting' : `VSP runtime is already running as pid ${String(pid)}`);
    this.name = 'RuntimeAlreadyRunningError';
  }
}

export interface RuntimeLease {
  readonly ownerNonce: string;
  release(): Promise<void>;
}

export async function acquireRuntimeLease(leasePath: string, ownerNonce = randomUUID()): Promise<RuntimeLease> {
  await mkdir(dirname(leasePath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(leasePath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readLeaseOwner(leasePath);
      if (owner === undefined) throw new RuntimeAlreadyRunningError(undefined);
      if (isProcessAlive(owner.pid)) throw new RuntimeAlreadyRunningError(owner.pid);
      await rm(leasePath, { force: true });
      continue;
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, ownerNonce })}\n`);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(leasePath, { force: true });
      throw error;
    }
    let released = false;
    return {
      ownerNonce,
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
        const current = await readLeaseOwner(leasePath);
        if (current?.pid === process.pid && current.ownerNonce === ownerNonce) {
          await rm(leasePath, { force: true });
        }
      },
    };
  }
  throw new RuntimeAlreadyRunningError(undefined);
}

async function readLeaseOwner(leasePath: string): Promise<{ pid: number; ownerNonce: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(leasePath, 'utf8')) as { pid?: unknown; ownerNonce?: unknown };
    return Number.isInteger(parsed.pid) && typeof parsed.ownerNonce === 'string'
      ? { pid: parsed.pid as number, ownerNonce: parsed.ownerNonce }
      : undefined;
  } catch {
    return undefined;
  }
}
