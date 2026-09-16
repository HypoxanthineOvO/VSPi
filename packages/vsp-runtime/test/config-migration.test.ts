/**
 * Scenario: VSPi owns its config and no longer imports Pi state.
 * Responsibilities: safe migration, user overrides, backup and rollback.
 * Wiring: real files and isolated homes; injected write failures only.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateRuntimeConfig, resolveRuntimePaths, startRuntimeDaemon } from '../src/index.js';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vsp-config-migration-'));
  homes.push(root);
  const homeDir = join(root, '.vspi');
  const agentDir = join(root, '.pi', 'agent');
  await mkdir(homeDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, homeDir, agentDir, path: resolveRuntimePaths(homeDir).configPath };
}

describe('VSPi-owned config migration', () => {
  it('ignores Pi models and credentials even when legacy paths are supplied', async () => {
    const f = await fixture();
    await writeFile(join(f.agentDir, 'models.json'), JSON.stringify({ providers: { example: { api: 'openai', models: [{ id: 'legacy-model' }] } } }));
    await writeFile(join(f.agentDir, 'auth.json'), JSON.stringify({ example: { type: 'api_key', key: 'YOUR_API_KEY' } }));
    await migrateRuntimeConfig({ homeDir: f.homeDir, osHomeDir: f.root, agentDir: f.agentDir });
    expect(parse(await readFile(f.path, 'utf8'))).toEqual({});
    await writeFile(join(f.agentDir, 'models.json'), 'invalid changed legacy data');
    expect(await migrateRuntimeConfig({ homeDir: f.homeDir, osHomeDir: f.root, agentDir: f.agentDir })).toMatchObject({ status: 'unchanged' });
  });

  it('ignores old runtime defaults rather than importing a model or effort', async () => {
    const f = await fixture();
    const dir = join(f.root, '.config', 'vspi');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'runtime-defaults.json'), JSON.stringify({ model: 'example/old', effort: 'high' }));
    await migrateRuntimeConfig({ homeDir: f.homeDir, osHomeDir: f.root });
    expect(parse(await readFile(f.path, 'utf8'))).toEqual({});
  });

  it('preserves malformed VSPi config and refuses to start instead of replacing it', async () => {
    const f = await fixture();
    await writeFile(f.path, '[broken');
    await expect(migrateRuntimeConfig({ homeDir: f.homeDir })).rejects.toThrow('Invalid VSPi config.toml');
    expect(await readFile(f.path, 'utf8')).toBe('[broken');
  });

  it('retires expired references without touching history or user overrides', async () => {
    const f = await fixture();
    const old = 'vsplab/deepseek-v4.1-flash-expires-on-0910';
    const current = 'vsplab/deepseek-flash';
    await writeFile(f.path, stringify({
      providers: { vsplab: { type: 'openai' } },
      models: { [old]: { provider: 'vsplab', model: 'deepseek-v4.1-flash-expires-on-0910', overrides: { display_name: 'My Flash' } } },
      default_model: old, thinking: { model_efforts: { [old]: 'high' } },
      secondary_model: { default_model: old, models: { [old]: 'Review' } },
    }));
    const history = join(f.homeDir, 'history.jsonl');
    await writeFile(history, old);
    await migrateRuntimeConfig({ homeDir: f.homeDir });
    expect(parse(await readFile(f.path, 'utf8'))).toMatchObject({
      default_model: current, models: { [current]: { overrides: { display_name: 'My Flash' } } },
      thinking: { model_efforts: { [current]: 'high' } },
      secondary_model: { default_model: current, models: { [current]: 'Review' } },
    });
    expect(await readFile(history, 'utf8')).toBe(old);
  });

  it('backs up stale generated names while preserving unrelated explicit fields', async () => {
    const f = await fixture();
    const original = stringify({
      providers: { vsplab: { type: 'openai', api_key: 'YOUR_API_KEY' } },
      models: { 'vsplab/deepseek-flash': { provider: 'vsplab', model: 'deepseek-flash', display_name: 'DeepSeek V4 Flash', max_context_size: 4096 } },
      default_model: 'vsplab/gpt-6-astra',
    });
    await writeFile(f.path, original);
    const result = await migrateRuntimeConfig({ homeDir: f.homeDir });
    const data = parse(await readFile(f.path, 'utf8'));
    expect(data).toMatchObject({ default_model: 'vsplab/gpt-6-astra', models: { 'vsplab/deepseek-flash': { max_context_size: 4096 } } });
    expect((data['models'] as Record<string, unknown>)['vsplab/deepseek-flash']).not.toHaveProperty('display_name');
    expect(await readFile(result.report!.backupPath, 'utf8')).toBe(original);
    expect(JSON.stringify(result.report)).not.toContain('YOUR_API_KEY');
  });

  it('preserves an existing canonical entry when retiring a duplicate alias', async () => {
    const f = await fixture();
    await writeFile(f.path, stringify({
      providers: { vsplab: { type: 'openai' } },
      models: {
        'vsplab/deepseek-v4.1-flash': { provider: 'vsplab', model: 'deepseek-v4.1-flash', max_context_size: 2000 },
        'vsplab/deepseek-flash': { provider: 'vsplab', model: 'deepseek-flash', max_context_size: 4096 },
      },
      default_model: 'vsplab/deepseek-v4.1-flash',
    }));
    await migrateRuntimeConfig({ homeDir: f.homeDir });
    expect(parse(await readFile(f.path, 'utf8'))).toMatchObject({ default_model: 'vsplab/deepseek-flash', models: { 'vsplab/deepseek-flash': { max_context_size: 4096 } } });
  });

  it('does not reinterpret explicit edits after the one-time snapshot migration', async () => {
    const f = await fixture();
    await migrateRuntimeConfig({ homeDir: f.homeDir });
    const edited = stringify({ providers: { vsplab: { type: 'openai' } }, models: { 'vsplab/deepseek-flash': { display_name: 'My model' } } }) + '\n';
    await writeFile(f.path, edited);
    await migrateRuntimeConfig({ homeDir: f.homeDir });
    expect(await readFile(f.path, 'utf8')).toBe(edited);
    expect(await migrateRuntimeConfig({ homeDir: f.homeDir })).toMatchObject({ status: 'unchanged' });
  });

  it.each(['after-target-write', 'after-report-write'] as const)('rolls back when a migration fails at %s', async (stage) => {
    const f = await fixture();
    const original = 'default_model = "example/model"';
    await writeFile(f.path, original);
    await expect(migrateRuntimeConfig({ homeDir: f.homeDir, faultInjector: { reach(point) { if (point === stage) throw new Error('injected'); } } })).rejects.toThrow('injected');
    expect(await readFile(f.path, 'utf8')).toBe(original);
    await expect(readFile(resolveRuntimePaths(f.homeDir).configMigrationMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a completed transaction after a post-marker failure', async () => {
    const f = await fixture();
    await expect(migrateRuntimeConfig({ homeDir: f.homeDir, faultInjector: { reach(point) { if (point === 'after-marker-write') throw new Error('injected'); } } })).rejects.toThrow('injected');
    expect(await migrateRuntimeConfig({ homeDir: f.homeDir })).toMatchObject({ status: 'unchanged' });
  });

  it('does not start Core and releases the lease when migration fails', async () => {
    const f = await fixture();
    await writeFile(f.path, '[broken');
    const startServer = vi.fn();
    const options = { homeDir: f.homeDir, hostIdentity: { productName: 'test', version: 'test', platform: 'test' }, startServer };
    await expect(startRuntimeDaemon(options)).rejects.toThrow('Invalid VSPi config.toml');
    await expect(startRuntimeDaemon(options)).rejects.toThrow('Invalid VSPi config.toml');
    expect(startServer).not.toHaveBeenCalled();
  });
});
