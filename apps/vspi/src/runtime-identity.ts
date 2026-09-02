import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveRuntimePaths, type RuntimeConnection, type RuntimeState } from '@vsp/vsp-runtime';

export const MINIMUM_NODE_VERSION = '24.15.0';

export interface ExpectedRuntimeIdentity {
  readonly productName: string;
  readonly version: string;
  readonly platform: string;
  readonly buildId: string;
  readonly nodeVersion: string;
  readonly homeDir: string;
}

export interface RuntimeIdentityRecord extends ExpectedRuntimeIdentity {
  readonly schemaVersion: 1;
  readonly pid: number;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (compareVersions(version, MINIMUM_NODE_VERSION) < 0) {
    throw new Error(`VSPi requires Node.js >=${MINIMUM_NODE_VERSION}; current version is ${version}`);
  }
}

export async function createExpectedRuntimeIdentity(options: {
  readonly entryPath: string;
  readonly homeDir?: string;
  readonly productName: string;
  readonly version: string;
  readonly platform: string;
  readonly nodeVersion?: string;
}): Promise<ExpectedRuntimeIdentity> {
  const bytes = await readFile(options.entryPath);
  return {
    productName: options.productName,
    version: options.version,
    platform: options.platform,
    buildId: createHash('sha256').update(bytes).digest('hex'),
    nodeVersion: options.nodeVersion ?? process.versions.node,
    homeDir: resolveRuntimePaths(options.homeDir).homeDir,
  };
}

export function runtimeIdentityPath(homeDir?: string): string {
  return join(resolveRuntimePaths(homeDir).serverDir, 'vspi-runtime.json');
}

export async function writeRuntimeIdentity(
  expected: ExpectedRuntimeIdentity,
  pid: number,
): Promise<RuntimeIdentityRecord> {
  const record: RuntimeIdentityRecord = { schemaVersion: 1, pid, ...expected };
  const path = runtimeIdentityPath(expected.homeDir);
  const temporary = `${path}.${String(pid)}.${randomUUID()}.tmp`;
  await mkdir(resolveRuntimePaths(expected.homeDir).serverDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return record;
}

export async function readRuntimeIdentity(homeDir?: string): Promise<RuntimeIdentityRecord | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runtimeIdentityPath(homeDir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
  return isRuntimeIdentityRecord(parsed) ? parsed : undefined;
}

export async function removeRuntimeIdentity(homeDir: string, pid: number): Promise<void> {
  const current = await readRuntimeIdentity(homeDir);
  if (current?.pid === pid) await rm(runtimeIdentityPath(homeDir), { force: true });
}

export function runtimeIdentityMismatch(
  expected: ExpectedRuntimeIdentity,
  actual: RuntimeIdentityRecord | undefined,
  state?: RuntimeState,
): string | undefined {
  if (actual === undefined) return 'daemon identity metadata is missing';
  if (state !== undefined && actual.pid !== state.pid) return 'daemon identity PID does not match runtime state';
  if (actual.productName !== expected.productName) return `daemon product is ${actual.productName}`;
  if (actual.version !== expected.version) return `daemon version is ${actual.version}`;
  if (actual.platform !== expected.platform) return `daemon platform is ${actual.platform}`;
  if (actual.buildId !== expected.buildId) return 'daemon build identity differs from this executable';
  if (actual.nodeVersion !== expected.nodeVersion) return `daemon Node.js is ${actual.nodeVersion}`;
  if (resolve(actual.homeDir) !== resolve(expected.homeDir)) return `daemon home is ${actual.homeDir}`;
  if (state !== undefined && state.version !== expected.version) return `runtime state version is ${state.version}`;
  return undefined;
}

export function assertCompatibleConnection(
  expected: ExpectedRuntimeIdentity,
  actual: RuntimeIdentityRecord | undefined,
  connection: RuntimeConnection,
): void {
  const mismatch = runtimeIdentityMismatch(expected, actual, connection.state);
  if (mismatch !== undefined) throw new Error(`Incompatible VSPi daemon: ${mismatch}`);
  if (connection.env.clientVersion !== expected.version) {
    throw new Error(`Incompatible VSPi daemon: server reports version ${connection.env.clientVersion}`);
  }
  if (resolve(connection.env.homeDir) !== resolve(expected.homeDir)) {
    throw new Error(`Incompatible VSPi daemon: server home is ${connection.env.homeDir}`);
  }
}

function isRuntimeIdentityRecord(value: unknown): value is RuntimeIdentityRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.productName === 'string' &&
    typeof record.version === 'string' &&
    typeof record.platform === 'string' &&
    typeof record.buildId === 'string' &&
    /^[a-f0-9]{64}$/u.test(record.buildId) &&
    typeof record.nodeVersion === 'string' &&
    typeof record.homeDir === 'string'
  );
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(value: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (match === null) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
