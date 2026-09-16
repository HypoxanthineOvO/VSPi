import { isDeepStrictEqual } from 'node:util';
import catalog from '../../../ops/vsplab/model-catalog.json' with { type: 'json' };
import { registerConfigOverlay } from '@moonshot-ai/agent-core-v2/app/config/configOverlayContributions';
import { modelsFromToml, modelsToToml, providersFromToml } from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import { mergeRelayCatalog } from '@moonshot-ai/agent-core-v2/app/kosongConfig/relayCatalog';
import { listPiModelRecords, listPiProviders } from '@moonshot-ai/agent-core-v2/kosong/provider/pi/catalog';
import { applyModelEffortProfile } from '@moonshot-ai/agent-core-v2/kosong/model/effortProfiles';
import { modelEffortProfile } from '@moonshot-ai/agent-core-v2/kosong/provider/effortProfiles';
import type { ModelsSection } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type { ProvidersSection } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';

const nativeProviders = new Set(listPiProviders().map((provider) => provider.id));
const nativeDefaults = new Map([...nativeProviders].map((id) => [id, Object.fromEntries(
  Object.entries(listPiModelRecords(id)).map(([alias, model]) => {
    const profile = modelEffortProfile(model.model);
    return [alias, profile?.providers.includes(id) ? applyModelEffortProfile(model, profile) : model];
  }),
)]));
const relayDefaults = mergeRelayCatalog({}, 'vsplab', { type: 'openai' }, catalog);

export function builtinModelDefaults(providers: ProvidersSection): ModelsSection {
  const result: ModelsSection = {};
  for (const [id, provider] of Object.entries(providers)) {
    if (id === 'vsplab' || provider.type === 'vsplab') {
      Object.assign(result, id === 'vsplab' ? relayDefaults : Object.fromEntries(Object.entries(relayDefaults).map(([alias, model]) => [
        `${id}/${alias.slice('vsplab/'.length)}`, { ...model, provider: id },
      ])));
    } else if (nativeProviders.has(id)) {
      Object.assign(result, nativeDefaults.get(id));
    }
  }
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function merge(base: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(user)) {
    const nested = object(value);
    result[key] = nested && object(base[key]) ? merge(object(base[key])!, nested) : value;
  }
  return result;
}

function difference(value: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isDeepStrictEqual(item, defaults[key])) continue;
    const nested = object(item);
    const delta = nested && object(defaults[key]) ? difference(nested, object(defaults[key])!) : item;
    if (!object(delta) || Object.keys(object(delta)!).length > 0) result[key] = delta;
  }
  return result;
}

export function compactModelSnapshots(config: Record<string, unknown>): void {
  const providers = providersFromToml(config['providers'] ?? {}) as ProvidersSection;
  const defaults = builtinModelDefaults(providers);
  const models = modelsFromToml(config['models'] ?? {}) as ModelsSection;
  for (const [alias, model] of Object.entries(models)) {
    if (!defaults[alias]) continue;
    if (model.model === 'deepseek-flash' && model.displayName === 'DeepSeek V4 Flash') delete model.displayName;
    models[alias] = difference(model, defaults[alias]);
    if (!Object.keys(models[alias]!).length) delete models[alias];
  }
  if (Object.keys(models).length) config['models'] = modelsToToml(models, {});
  else delete config['models'];
}

registerConfigOverlay({
  apply(effective, _getEnv, validate) {
    const providers = structuredClone(effective['providers'] ?? {}) as ProvidersSection;
    for (const [id, provider] of Object.entries(providers)) {
      if (id === 'vsplab' || provider.type === 'vsplab' || nativeProviders.has(id)) provider.modelSource = 'static';
    }
    effective['providers'] = validate('providers', providers);
    effective['models'] = validate('models', merge(builtinModelDefaults(providers), object(effective['models']) ?? {}));
    return ['providers', 'models'];
  },
  strip(domain, value, raw) {
    if (domain !== 'models') return value;
    const defaults = builtinModelDefaults(providersFromToml(raw['providers'] ?? {}) as ProvidersSection);
    const previous = modelsFromToml(raw['models'] ?? {}) as ModelsSection;
    const result: ModelsSection = {};
    for (const [alias, model] of Object.entries(value as ModelsSection)) {
      if (!defaults[alias]) { result[alias] = model; continue; }
      const delta = difference(model, defaults[alias]);
      for (const key of Object.keys(previous[alias] ?? {})) {
        if (Object.hasOwn(model, key)) delta[key] = model[key];
      }
      if (Object.keys(delta).length) result[alias] = delta;
    }
    return result;
  },
});
