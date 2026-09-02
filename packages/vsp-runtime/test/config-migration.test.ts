import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  migrateRuntimeConfig,
  resolveRuntimePaths,
  startRuntimeDaemon,
} from '../src/index.js';

const identity = {
  productName: 'vspi-test',
  version: '0.1.0-test',
  platform: 'vspi_test',
};

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('pre-bootstrap config migration', () => {
  it('merges valid entries independently with target-wins and repairs a dangling default', async () => {
    const { root, homeDir, agentDir } = await fixture();
    await writeFile(join(homeDir, 'config.toml'), [
      'default_model = "missing/model"',
      '',
      '[providers.relay]',
      'type = "anthropic"',
      'api_key = "target-key"',
      '',
      '[models."relay/existing"]',
      'provider = "relay"',
      'model = "existing"',
      'protocol = "anthropic"',
      'max_context_size = 64000',
      '',
      '[models."relay/new"]',
      'provider = "relay"',
      'model = "new"',
      'protocol = "anthropic"',
      'max_context_size = 200000',
      '',
      '[models."relay/new".thinking]',
      'availability = "always"',
      'efforts = ["low", "medium", "high"]',
      'default_effort = "medium"',
      '',
      '[unrelated]',
      'preserved = true',
      '',
    ].join('\n'));
    await writeLegacy(agentDir, {
      providers: {
        relay: {
          api: 'openai-responses',
          baseUrl: 'https://legacy.example/v1',
          models: [
            { id: 'existing', contextWindow: 1 },
            { id: 'new', contextWindow: 200_000 },
            { id: 'bad', api: 'mystery-protocol' },
          ],
        },
        unknown: { api: 'mystery-protocol', models: [{ id: 'ignored' }] },
      },
    });
    await mkdir(join(root, '.config', 'vspi'), { recursive: true });
    await writeFile(join(root, '.config', 'vspi', 'runtime-defaults.json'), JSON.stringify({
      model: { provider: 'relay', id: 'new' },
      effort: 'high',
    }));

    const result = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    const config = parse(await readFile(join(homeDir, 'config.toml'), 'utf8')) as Record<string, unknown>;
    const providers = config['providers'] as Record<string, Record<string, unknown>>;
    const models = config['models'] as Record<string, Record<string, unknown>>;

    expect(result.status).toBe('migrated');
    expect(result.warning).toEqual({ status: 'repaired', reason: 'default-model-repair' });
    expect(providers['relay']).toMatchObject({ type: 'anthropic', api_key: 'target-key' });
    expect(providers['unknown']).toBeUndefined();
    expect(models['relay/existing']).toMatchObject({ protocol: 'anthropic', max_context_size: 64_000 });
    expect(models['relay/new']).toMatchObject({ protocol: 'anthropic', max_context_size: 200_000 });
    expect(models['relay/bad']).toBeUndefined();
    expect(config['default_model']).toBe('relay/new');
    expect(config['thinking']).toEqual({ effort: 'high' });
    expect(result.report?.effortRepair).toEqual({
      status: 'applied',
      reason: 'effort-supported',
      changed: false,
    });
    expect(config['unrelated']).toEqual({ preserved: true });
    expect(result.report?.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('unknown protocol'),
    ]));
  });

  it('normalizes old localized defaults and records a redacted conservative action', async () => {
    const { root, homeDir, agentDir } = await fixture();
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'safe' }] } } });
    await mkdir(join(root, '.config', 'vspi'), { recursive: true });
    await writeFile(join(root, '.config', 'vspi', 'runtime-defaults.json'), JSON.stringify({
      model: { provider: 'relay', id: 'safe' },
      effort: '高',
      apiKey: 'DEFAULTS-SECRET',
    }));

    const result = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    const paths = resolveRuntimePaths(homeDir);
    const config = parse(await readFile(paths.configPath, 'utf8')) as Record<string, unknown>;
    const reportText = await readFile(paths.configMigrationReportPath, 'utf8');

    expect(config['thinking']).toEqual({ effort: 'off' });
    expect(result.report?.effortRepair).toEqual({
      status: 'applied',
      reason: 'missing-capability',
      changed: true,
    });
    expect(result.warning).toEqual({ status: 'repaired', reason: 'effort-repair' });
    expect(result.report?.diagnostics).toContain(
      'thinking effort repaired to off because the default model has no structured thinking capability',
    );
    expect(reportText).not.toContain('DEFAULTS-SECRET');
  });

  it('preserves an existing target thinking section over legacy defaults', async () => {
    const { root, homeDir, agentDir } = await fixture();
    await writeFile(join(homeDir, 'config.toml'), '[thinking]\neffort = "vendor-custom"\n');
    await mkdir(join(root, '.config', 'vspi'), { recursive: true });
    await writeFile(join(root, '.config', 'vspi', 'runtime-defaults.json'), JSON.stringify({ effort: 'off' }));

    const result = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    const paths = resolveRuntimePaths(homeDir);
    const config = parse(await readFile(paths.configPath, 'utf8')) as Record<string, unknown>;
    const reportText = await readFile(paths.configMigrationReportPath, 'utf8');

    expect(config['thinking']).toEqual({ effort: 'vendor-custom' });
    expect(result.report?.effortRepair).toEqual({
      status: 'preserved',
      reason: 'target-preserved',
      changed: false,
    });
    expect(reportText).not.toContain('vendor-custom');
  });

  it('ignores malformed old defaults without breaking bad TOML repair', async () => {
    const { root, homeDir, agentDir } = await fixture();
    await writeFile(join(homeDir, 'config.toml'), '[broken\n');
    await mkdir(join(root, '.config', 'vspi'), { recursive: true });
    await writeFile(join(root, '.config', 'vspi', 'runtime-defaults.json'), '{ invalid');
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'safe' }] } } });

    const result = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    const configText = await readFile(join(homeDir, 'config.toml'), 'utf8');

    expect(result.status).toBe('repaired');
    expect(result.warning).toEqual({ status: 'repaired', reason: 'bad-toml' });
    expect(JSON.stringify(result.warning)).not.toContain(homeDir);
    expect(() => parse(configText)).not.toThrow();
    expect(result.report?.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining('invalid JSON')]));
    expect(result.report?.effortRepair).toBeUndefined();
  });

  it('backs up bad TOML and writes a parseable repair, marker, and redacted report', async () => {
    const { root, homeDir, agentDir } = await fixture();
    const broken = 'api_key = "TOP-SECRET"\n[broken\n';
    await writeFile(join(homeDir, 'config.toml'), broken);
    await writeLegacy(agentDir, {
      providers: {
        relay: {
          api: 'openai',
          headers: { Authorization: 'Bearer HEADER-SECRET' },
          models: [{ id: 'safe' }],
        },
      },
    });
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      relay: { type: 'api_key', key: 'AUTH-SECRET' },
    }));

    const result = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    const paths = resolveRuntimePaths(homeDir);
    const repaired = await readFile(paths.configPath, 'utf8');
    const marker = JSON.parse(await readFile(paths.configMigrationMarkerPath, 'utf8')) as Record<string, unknown>;
    const reportText = await readFile(paths.configMigrationReportPath, 'utf8');
    const report = JSON.parse(reportText) as Record<string, unknown>;
    const backupPath = report['backupPath'] as string;
    const backup = await readFile(backupPath, 'utf8');

    expect(result.status).toBe('repaired');
    expect(backup).toBe(broken);
    expect(() => parse(repaired)).not.toThrow();
    expect(marker['targetFingerprint']).toBe(createHash('sha256').update(repaired).digest('hex'));
    expect(report['status']).toBe('repaired');
    expect(reportText).not.toContain('AUTH-SECRET');
    expect(reportText).not.toContain('HEADER-SECRET');
    expect(reportText).not.toContain('TOP-SECRET');
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it('is idempotent when source and target fingerprints are unchanged', async () => {
    const { root, homeDir, agentDir } = await fixture();
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'safe' }] } } });
    const first = await migrateRuntimeConfig({
      homeDir,
      osHomeDir: root,
      agentDir,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const paths = resolveRuntimePaths(homeDir);
    const markerBefore = await readFile(paths.configMigrationMarkerPath, 'utf8');
    const configBefore = await readFile(paths.configPath, 'utf8');

    const second = await migrateRuntimeConfig({
      homeDir,
      osHomeDir: root,
      agentDir,
      now: () => new Date('2027-01-01T00:00:00.000Z'),
    });

    expect(first.status).toBe('migrated');
    expect(second.status).toBe('unchanged');
    expect(await readFile(paths.configMigrationMarkerPath, 'utf8')).toBe(markerBefore);
    expect(await readFile(paths.configPath, 'utf8')).toBe(configBefore);
  });

  it('keeps content-addressed backups immutable across source changes', async () => {
    const { root, homeDir, agentDir } = await fixture();
    const original = 'default_permission_mode = "manual"\n';
    const paths = resolveRuntimePaths(homeDir);
    await writeFile(paths.configPath, original);
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'first' }] } } });

    const first = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    const firstBackupPath = first.report?.backupPath as string;
    const firstBackup = await readFile(firstBackupPath, 'utf8');
    await writeLegacy(agentDir, { providers: { second: { api: 'anthropic', models: [{ id: 'second' }] } } });

    const second = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    const secondBackupPath = second.report?.backupPath as string;

    expect(secondBackupPath).not.toBe(firstBackupPath);
    expect(await readFile(firstBackupPath, 'utf8')).toBe(firstBackup);
    expect(await readFile(secondBackupPath, 'utf8')).toContain('[models."relay/first"]');
  });

  it('recovers target and report without a marker, then completes one consistent transaction', async () => {
    const { root, homeDir, agentDir } = await fixture();
    const original = 'default_permission_mode = "manual"\n';
    const paths = resolveRuntimePaths(homeDir);
    await writeFile(paths.configPath, original);
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'safe' }] } } });
    await migrateRuntimeConfig({
      homeDir,
      osHomeDir: root,
      agentDir,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const interruptedTarget = await readFile(paths.configPath, 'utf8');
    const interruptedReport = JSON.parse(await readFile(paths.configMigrationReportPath, 'utf8')) as Record<string, unknown>;
    await rm(paths.configMigrationMarkerPath);

    const recovered = await migrateRuntimeConfig({
      homeDir,
      osHomeDir: root,
      agentDir,
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    });
    const finalConfig = await readFile(paths.configPath, 'utf8');
    const finalReport = JSON.parse(await readFile(paths.configMigrationReportPath, 'utf8')) as Record<string, unknown>;
    const finalMarker = JSON.parse(await readFile(paths.configMigrationMarkerPath, 'utf8')) as Record<string, unknown>;

    expect(recovered.status).toBe('migrated');
    expect(finalConfig).toBe(interruptedTarget);
    expect(finalReport['completedAt']).not.toBe(interruptedReport['completedAt']);
    expect(finalMarker['completedAt']).toBe(finalReport['completedAt']);
    expect(finalMarker['sourceFingerprint']).toBe(finalReport['sourceFingerprint']);
    expect(finalMarker['targetFingerprint']).toBe(finalReport['targetFingerprint']);
    expect(finalMarker['targetFingerprint']).toBe(createHash('sha256').update(finalConfig).digest('hex'));
    expect(await readFile(finalReport['backupPath'] as string, 'utf8')).toBe(original);
  });

  it('rolls back config and completion files when a post-write stage fails', async () => {
    const { root, homeDir, agentDir } = await fixture();
    const original = 'default_permission_mode = "manual"\n';
    const oldMarker = '{"old":true}\n';
    const oldReport = '{"oldReport":true}\n';
    const paths = resolveRuntimePaths(homeDir);
    await writeFile(paths.configPath, original);
    await mkdir(paths.serverDir, { recursive: true });
    await writeFile(paths.configMigrationMarkerPath, oldMarker);
    await writeFile(paths.configMigrationReportPath, oldReport);
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'safe' }] } } });

    await expect(migrateRuntimeConfig({
      homeDir,
      osHomeDir: root,
      agentDir,
      faultInjector: {
        reach(stage) {
          if (stage === 'after-report-write') throw new Error('injected report failure');
        },
      },
    })).rejects.toThrow('injected report failure');

    const beforeFingerprint = createHash('sha256').update(original).digest('hex');
    const backupPath = join(paths.configMigrationBackupDir, `config.${beforeFingerprint}.backup`);
    expect(await readFile(paths.configPath, 'utf8')).toBe(original);
    expect(await readFile(backupPath, 'utf8')).toBe(original);
    expect(await readFile(paths.configMigrationMarkerPath, 'utf8')).toBe(oldMarker);
    expect(await readFile(paths.configMigrationReportPath, 'utf8')).toBe(oldReport);
  });

  it('keeps the transaction committed when a post-marker hook fails', async () => {
    const { root, homeDir, agentDir } = await fixture();
    const paths = resolveRuntimePaths(homeDir);
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'safe' }] } } });

    await expect(migrateRuntimeConfig({
      homeDir,
      osHomeDir: root,
      agentDir,
      faultInjector: {
        reach(stage) {
          if (stage === 'after-marker-write') throw new Error('post-commit failure');
        },
      },
    })).rejects.toThrow('post-commit failure');

    const config = await readFile(paths.configPath, 'utf8');
    const report = JSON.parse(await readFile(paths.configMigrationReportPath, 'utf8')) as Record<string, unknown>;
    const marker = JSON.parse(await readFile(paths.configMigrationMarkerPath, 'utf8')) as Record<string, unknown>;
    expect(marker['completedAt']).toBe(report['completedAt']);
    expect(marker['targetFingerprint']).toBe(report['targetFingerprint']);
    expect(marker['targetFingerprint']).toBe(createHash('sha256').update(config).digest('hex'));
    await expect(migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir })).resolves.toMatchObject({ status: 'unchanged' });
  });

  it('does not report a warning for a normal unchanged config', async () => {
    const { root, homeDir, agentDir } = await fixture();
    const result = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    expect(result.status).toBe('migrated');
    expect(result.warning).toBeUndefined();
    const unchanged = await migrateRuntimeConfig({ homeDir, osHomeDir: root, agentDir });
    expect(unchanged.status).toBe('unchanged');
    expect(unchanged.warning).toBeUndefined();
  });

  it('does not start Core and releases the lease when migration fails', async () => {
    const { root, homeDir, agentDir } = await fixture();
    await writeLegacy(agentDir, { providers: { relay: { api: 'openai', models: [{ id: 'safe' }] } } });
    const startServer = vi.fn();
    const options = {
      homeDir,
      hostIdentity: identity,
      env: { ...process.env, HOME: root },
      startServer,
      configMigration: {
        faultInjector: {
          reach(stage: 'after-target-write' | 'after-marker-write' | 'after-report-write') {
            if (stage === 'after-target-write') throw new Error('injected migration failure');
          },
        },
      },
    };

    await expect(startRuntimeDaemon(options)).rejects.toThrow('injected migration failure');
    expect(startServer).not.toHaveBeenCalled();
    await expect(startRuntimeDaemon(options)).rejects.toThrow('injected migration failure');
    expect(startServer).not.toHaveBeenCalled();
  });
});

async function fixture(): Promise<{ root: string; homeDir: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vsp-config-migration-'));
  homes.push(root);
  const homeDir = join(root, '.vspi');
  const agentDir = join(root, '.pi', 'agent');
  await mkdir(homeDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, homeDir, agentDir };
}

async function writeLegacy(agentDir: string, models: unknown): Promise<void> {
  await writeFile(join(agentDir, 'models.json'), JSON.stringify(models));
}
