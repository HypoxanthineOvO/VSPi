import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { isPlainObject } from '#/app/config/toml';

export const VSPLAB_SECTION = 'vsplab';
export const VsplabConfigSchema = z.object({ endpoint: z.enum(['cn', 'tech']).default('cn') }).default({ endpoint: 'cn' });

registerConfigSection(VSPLAB_SECTION, VsplabConfigSchema, { defaultValue: { endpoint: 'cn' } });

function address(value: unknown, endpoint: 'cn' | 'tech'): unknown {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !['api.vsplab.cn', 'api.vsplab.tech'].includes(url.hostname)) return value;
    url.hostname = `api.vsplab.${endpoint}`;
    return url.toString();
  } catch { return value; }
}

registerConfigOverlay({
  apply(effective, getEnv, validate) {
    const { endpoint } = VsplabConfigSchema.parse(effective[VSPLAB_SECTION]);
    const providers = isPlainObject(effective['providers']) ? effective['providers'] : {};
    const models = isPlainObject(effective['models']) ? effective['models'] : {};
    const relays = new Set<string>();
    const nextProviders = { ...providers };
    const nextModels = { ...models };
    let providerChanged = false;
    let modelChanged = false;
    for (const [id, provider] of Object.entries(providers)) {
      if (!isPlainObject(provider)) continue;
      const source = isPlainObject(provider['source']) ? provider['source'] : undefined;
      if (id !== 'vsplab' && provider['type'] !== 'vsplab' && source?.['kind'] !== 'vsp-models') continue;
      relays.add(id);
      const environment = isPlainObject(provider['env']) ? provider['env'] : {};
      const openaiEnvironment = provider['type'] === 'openai' || provider['type'] === 'openai_responses'
        ? environment['OPENAI_BASE_URL'] ?? getEnv('OPENAI_BASE_URL') : undefined;
      const environmentUrl = environment['VSPLAB_BASE_URL'] ?? getEnv('VSPLAB_BASE_URL') ?? openaiEnvironment;
      const fallback = typeof environmentUrl === 'string' && environmentUrl.trim().length > 0 ? environmentUrl : `https://api.vsplab.${endpoint}/v1`;
      const baseUrl = provider['baseUrl'] === undefined ? fallback : address(provider['baseUrl'], endpoint);
      const catalogUrl = address(source?.['url'], endpoint);
      if (baseUrl === provider['baseUrl'] && catalogUrl === source?.['url']) continue;
      nextProviders[id] = { ...provider, baseUrl, source: source === undefined ? undefined : { ...source, url: catalogUrl } };
      providerChanged = true;
    }
    for (const [id, model] of Object.entries(models)) {
      if (!isPlainObject(model)) continue;
      const provider = model['providerId'] ?? model['provider'] ?? id.split('/')[0];
      if (typeof provider !== 'string' || !relays.has(provider)) continue;
      const baseUrl = address(model['baseUrl'], endpoint);
      if (baseUrl === model['baseUrl']) continue;
      nextModels[id] = { ...model, baseUrl };
      modelChanged = true;
    }
    const changed: string[] = [];
    if (providerChanged) { effective['providers'] = validate('providers', nextProviders); changed.push('providers'); }
    if (modelChanged) { effective['models'] = validate('models', nextModels); changed.push('models'); }
    return changed;
  },
});
