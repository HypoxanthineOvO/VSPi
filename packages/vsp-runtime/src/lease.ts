import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, link, rename, lstat } from 'node:fs/promises';
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

interface LeaseOwner {
  readonly pid: number;
  readonly ownerNonce: string;
}

interface LeaseSnapshot {
  readonly owner?: LeaseOwner;
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedMs: bigint;
  readonly content: string;
}

export async function acquireRuntimeLease(leasePath: string, ownerNonce = randomUUID()): Promise<RuntimeLease> {
  const published = await withLeaseClaim(leasePath, ownerNonce, async (candidate, snapshot) => {
    const previous = await readLeaseSnapshot(leasePath);
    if (previous) await quarantineDeadLease(leasePath, previous);
    try {
      await link(candidate, leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new RuntimeAlreadyRunningError((await readLeaseSnapshot(leasePath))?.owner?.pid);
    }
    return snapshot;
  });
  let released = false;
  return {
    ownerNonce,
    release: async () => {
      if (released) return;
      await removeOwnedClaim(leasePath, published);
      released = true;
    },
  };
}

export async function recoverRuntimeLease(leasePath: string): Promise<void> {
  await withLeaseClaim(leasePath, randomUUID(), async () => {
    const previous = await readLeaseSnapshot(leasePath);
    if (previous) await quarantineDeadLease(leasePath, previous, true);
  });
}

async function withLeaseClaim<T>(
  leasePath: string,
  ownerNonce: string,
  action: (candidate: string, snapshot: LeaseSnapshot) => Promise<T>,
): Promise<T> {
  if (ownerNonce.length === 0 || ownerNonce.length > 256) throw new Error('Invalid runtime lock owner nonce');
  await mkdir(dirname(leasePath), { recursive: true, mode: 0o700 });
  const candidate = `${leasePath}.${process.pid}.${randomUUID()}.owner`;
  try {
    const handle = await open(candidate, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, ownerNonce })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const snapshot = await readLeaseSnapshot(candidate);
    if (!snapshot?.owner) throw new Error('Runtime lock candidate failed ownership validation');
    const claimPath = `${leasePath}.recovery`;
    await acquireClaim(claimPath, candidate, snapshot);
    try {
      return await action(candidate, snapshot);
    } finally {
      await removeOwnedClaim(claimPath, snapshot);
    }
  } finally {
    await rm(candidate, { force: true });
  }
}

async function acquireClaim(claimPath: string, candidate: string, snapshot: LeaseSnapshot): Promise<void> {
  try {
    await link(candidate, claimPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const previous = await readLeaseSnapshot(claimPath);
  if (!previous) throw new Error('Runtime recovery ownership changed; retry without removing lock files');
  assertDeadOwner(previous);
  const reclaimPath = `${claimPath}.reclaim`;
  try {
    await link(candidate, reclaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('Runtime recovery claim is already being reclaimed or its reclamation owner cannot be verified; existing files were preserved for manual inspection', { cause: error });
  }
  try {
    await quarantineDeadLease(claimPath, previous);
    try {
      await link(candidate, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new RuntimeAlreadyRunningError((await readLeaseSnapshot(claimPath))?.owner?.pid);
    }
  } finally {
    await removeOwnedClaim(reclaimPath, snapshot);
  }
}

function assertDeadOwner(snapshot: LeaseSnapshot, confirmedPrimaryRecovery = false): void {
  if (!snapshot.owner) {
    if (!confirmedPrimaryRecovery) throw new Error('Runtime lock owner cannot be verified; existing files were preserved. A corrupt primary lock requires vspi daemon recover --confirm-stopped; an unknown recovery-claim owner requires manual inspection');
    if (Date.now() - Number(snapshot.modifiedMs) < 30_000) throw new Error('Runtime lock may still be initializing; wait at least 30 seconds before confirmed recovery');
    return;
  }
  if (isProcessAlive(snapshot.owner.pid)) throw new RuntimeAlreadyRunningError(snapshot.owner.pid);
}

function sameLease(left: LeaseSnapshot | undefined, right: LeaseSnapshot): boolean {
  return left?.device === right.device && left.inode === right.inode &&
    left.modifiedMs === right.modifiedMs && left.content === right.content &&
    left.owner?.pid === right.owner?.pid && left.owner?.ownerNonce === right.owner?.ownerNonce;
}

async function quarantineDeadLease(path: string, previous: LeaseSnapshot, confirmedPrimaryRecovery = false): Promise<void> {
  assertDeadOwner(previous, confirmedPrimaryRecovery);
  const current = await readLeaseSnapshot(path);
  if (!current || !sameLease(current, previous)) throw new Error('Runtime lock ownership changed; existing files were preserved');
  assertDeadOwner(current, confirmedPrimaryRecovery);
  await rename(path, `${path}.recovered.${Date.now()}.${randomUUID()}`);
}

async function removeOwnedClaim(path: string, snapshot: LeaseSnapshot): Promise<void> {
  const current = await readLeaseSnapshot(path);
  if (!current) return;
  if (!sameLease(current, snapshot) || current.owner?.pid !== process.pid) throw new Error('Runtime lock ownership changed; refusing to remove another owner');
  await rm(path, { force: true });
}

async function readLeaseSnapshot(path: string): Promise<LeaseSnapshot | undefined> {
  let entry;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!entry.isFile() || entry.size > 16_384n) throw new Error('Runtime lock is not a bounded regular file; existing entry was preserved');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error('Runtime lock changed while reading its owner; retry without removing lock files');
    if (opened.size > 16_384n) throw new Error('Runtime lock exceeds its size limit; existing file was preserved');
    const text = await handle.readFile('utf8');
    let owner: LeaseOwner | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record['pid'] === 'number' && Number.isInteger(record['pid']) && record['pid'] > 0 && record['pid'] <= 2 ** 31 - 1 &&
            typeof record['ownerNonce'] === 'string' && record['ownerNonce'].length > 0 && record['ownerNonce'].length <= 256) {
          owner = { pid: record['pid'], ownerNonce: record['ownerNonce'] };
        }
      }
    } catch {}
    return { owner, device: opened.dev, inode: opened.ino, modifiedMs: opened.mtimeMs, content: text };
  } finally {
    await handle.close();
  }
}
