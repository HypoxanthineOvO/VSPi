import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { modelsToToml } from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import type { ModelsSection } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';
import { startServer } from '@moonshot-ai/kap-server';
import { parse, stringify } from 'smol-toml';
import { afterEach, expect, it, vi } from 'vitest';

import { migrateRuntimeConfig } from '../src/config-migration.js';
import { builtinModelDefaults } from '../src/model-defaults.js';
import { resolveRuntimePaths } from '../src/paths.js';

const alias = 'vsplab/glm-5.3';
const unchangedAlias = 'vsplab/glm-5.3-flash';
const providers = { vsplab: { type: 'openai' }, example: { type: 'openai', model_source: 'static' } };
const defaults = builtinModelDefaults(providers);
const custom = { provider: 'example', model: 'custom', displayName: 'Custom model' };
const customAlias = 'example/custom';
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture(models: ModelsSection) {
  const homeDir = await mkdtemp(join(tmpdir(), 'vsp-model-pricing-'));
  homes.push(homeDir);
  const paths = resolveRuntimePaths(homeDir);
  await writeFile(paths.configPath, stringify({ providers, models: modelsToToml(models, {}) }));
  return paths;
}

async function startCore(homeDir: string) {
  return startServer({
    homeDir, host: '127.0.0.1', port: 0, env: { HOME: homeDir }, telemetry: false,
    hostIdentity: { productName: 'vspi-test', version: 'test', platform: 'test' },
  });
}

it.each([undefined, 1])('migrates full prices and keeps custom aliases with defaults marker %s', async (modelDefaultsVersion) => {
  const model = defaults[alias]!;
  const pricing = { ...model.pricing!, outputUsdPerMillion: 99 };
  const paths = await fixture({ [alias]: { ...model, pricing }, [unchangedAlias]: defaults[unchangedAlias]!, [customAlias]: custom });
  if (modelDefaultsVersion !== undefined) {
    await migrateRuntimeConfig({ homeDir: paths.homeDir, cleanProtocolDefaults: false });
    const marker = JSON.parse(await readFile(paths.configMigrationMarkerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(paths.configMigrationMarkerPath, JSON.stringify({ ...marker, modelDefaultsVersion }));
  }

  expect(await migrateRuntimeConfig({ homeDir: paths.homeDir })).toMatchObject({ status: 'migrated' });
  const saved = parse(await readFile(paths.configPath, 'utf8'))['models'];
  expect(saved).toEqual(modelsToToml({ [alias]: { pricing }, [customAlias]: custom }, {}));
  const server = await startCore(paths.homeDir);
  try {
    const config = server.core.accessor.get(IConfigService);
    await config.ready;
    const models = config.get<ModelsSection>('models');
    expect(models[alias]?.pricing).toEqual(pricing);
    expect(models[customAlias]).toEqual(custom);
    expect(config.diagnostics().some(diagnostic => diagnostic.message.startsWith("Ignored invalid config section 'models'"))).toBe(false);
  } finally {
    await server.close();
  }
});

it('persists the full price on the first config edit and reloads the custom alias', async () => {
  const paths = await fixture({ [customAlias]: custom });
  const server = await startCore(paths.homeDir);
  try {
    const config = server.core.accessor.get(IConfigService);
    await config.ready;
    const originalPricing = config.get<ModelsSection>('models')[alias]!.pricing!;
    expect(originalPricing).toMatchObject({ inputUsdPerMillion: 1.4, outputUsdPerMillion: 4.4 });
    const pricing = { ...originalPricing, outputUsdPerMillion: 99 };

    await config.set('models', { [alias]: { pricing } });
    expect(parse(await readFile(paths.configPath, 'utf8'))['models']).toEqual(
      modelsToToml({ [alias]: { pricing }, [customAlias]: custom }, {}),
    );
    await config.reload();
    expect(config.get<ModelsSection>('models')[alias]?.pricing).toEqual(pricing);
    expect(config.get<ModelsSection>('models')[customAlias]).toEqual(custom);
  } finally {
    await server.close();
  }
});

it('leaves config and migration marker alone when candidate models fail schema validation', async () => {
  const paths = await fixture({ [customAlias]: custom });
  const original = `${await readFile(paths.configPath, 'utf8')}\n# Keep this original text\n[models."${alias}".pricing]\noutputUsdPerMillion = 99\n`;
  await writeFile(paths.configPath, original);
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

  expect(await migrateRuntimeConfig({ homeDir: paths.homeDir })).toMatchObject({ status: 'unchanged' });
  expect(await readFile(paths.configPath, 'utf8')).toBe(original);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('invalid [models]'));
  await expect(readFile(paths.configMigrationMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' });
});
