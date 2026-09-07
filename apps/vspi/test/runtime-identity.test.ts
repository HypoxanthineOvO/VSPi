import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatRuntimeMigrationWarning } from '../src/v1/run.js';
import {
  assertSupportedNodeVersion,
  createExpectedRuntimeIdentity,
  readRuntimeIdentity,
  runtimeIdentityMismatch,
  writeRuntimeIdentity,
} from '../src/runtime-identity.js';

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('VSPi startup runtime warning', () => {
  it('formats each migration reason as a stable user-facing warning', () => {
    expect(formatRuntimeMigrationWarning('bad-toml')).toContain('损坏');
    expect(formatRuntimeMigrationWarning('effort-repair')).toContain('Effort');
    expect(formatRuntimeMigrationWarning('default-model-repair')).toContain('默认模型');
    expect(formatRuntimeMigrationWarning('legacy-migration')).toContain('迁移');
    expect(formatRuntimeMigrationWarning('unknown')).toContain('迁移');
  });
});

describe('VSPi runtime identity', () => {
  it('enforces the repository Node.js floor', () => {
    expect(() => assertSupportedNodeVersion('24.15.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('25.0.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('24.14.9')).toThrow(/requires Node\.js >=24\.15\.0/u);
    expect(() => assertSupportedNodeVersion('22.22.3')).toThrow(/current version is 22\.22\.3/u);
  });

  it('binds daemon reuse to the executable bytes, Node version, and VSPI_HOME', async () => {
    const firstHome = await temporaryDirectory('vspi-runtime-first-');
    const secondHome = await temporaryDirectory('vspi-runtime-second-');
    const entry = join(firstHome, 'main.mjs');
    await writeFile(entry, 'first build');
    vi.stubEnv('VSPI_HOME', firstHome);

    const expected = await createExpectedRuntimeIdentity({
      entryPath: entry,
      productName: 'vspi',
      version: '2.0.0',
      platform: 'vspi',
      nodeVersion: '24.15.0',
    });
    expect(expected.homeDir).toBe(firstHome);
    await writeRuntimeIdentity(expected, 1234);
    const record = await readRuntimeIdentity(firstHome);
    expect(runtimeIdentityMismatch(expected, record, { ...runtimeState(), pid: 1234 })).toBeUndefined();

    await writeFile(entry, 'second build');
    const changedBuild = await createExpectedRuntimeIdentity({
      entryPath: entry,
      homeDir: firstHome,
      productName: 'vspi',
      version: '2.0.0',
      platform: 'vspi',
      nodeVersion: '24.15.0',
    });
    expect(runtimeIdentityMismatch(changedBuild, record)).toMatch(/build identity/u);
    expect(runtimeIdentityMismatch({ ...expected, nodeVersion: '24.16.0' }, record)).toBe(
      'daemon Node.js is 24.15.0',
    );
    expect(runtimeIdentityMismatch({ ...expected, homeDir: secondHome }, record)).toBe(`daemon home is ${firstHome}`);
    expect(JSON.parse(await readFile(join(firstHome, 'server', 'vspi-runtime.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      pid: 1234,
      buildId: expected.buildId,
    });
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function runtimeState() {
  return {
    protocolVersion: 1,
    pid: 1,
    ownerNonce: 'test-owner-nonce',
    host: '127.0.0.1',
    port: 1,
    ipcPath: '/tmp/vspi-test.sock',
    startedAt: '2026-08-30T00:00:00.000Z',
    version: '2.0.0',
  };
}
