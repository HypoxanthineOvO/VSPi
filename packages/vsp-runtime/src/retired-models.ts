import { currentModelId } from '@moonshot-ai/agent-core-v2/kosong/model/retiredModelIds';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function retireModelReferences(
  config: Record<string, unknown>,
  models: Record<string, unknown>,
  providers: Record<string, unknown>,
  diagnostics: string[],
): Map<string, string> {
  const renamed = new Map<string, string>();
  const relay = (id: string) => id === 'vsplab' || object(providers[id])?.['type'] === 'vsplab' ||
    object(object(providers[id])?.['source'])?.['kind'] === 'vsp-models';
  for (const [alias, value] of Object.entries(models)) {
    const model = object(value);
    const provider = model?.['provider'];
    const wire = model?.['name'] ?? model?.['model'];
    if (!model || typeof provider !== 'string' || !relay(provider) || typeof wire !== 'string') continue;
    const name = currentModelId(wire);
    const nextAlias = currentModelId(alias);
    if (name === wire && nextAlias === alias) continue;
    const next: Record<string, unknown> = { ...model, model: name };
    if (typeof model['name'] === 'string') next['name'] = name;
    if (name.split('/').at(-1) === 'deepseek-flash') next['display_name'] = 'DeepSeek V4.1 Flash';
    if (nextAlias === alias || !Object.hasOwn(models, nextAlias)) models[nextAlias] = next;
    if (nextAlias !== alias) delete models[alias];
    renamed.set(alias, nextAlias);
    diagnostics.push(`model ${alias}: retired identifier migrated to ${nextAlias}`);
  }
  const reference = (value: string) => {
    if (renamed.has(value)) return renamed.get(value)!;
    return relay(value.split('/')[0] ?? '') ? currentModelId(value) : value;
  };
  const pointer = (target: Record<string, unknown> | undefined, key: string) => {
    if (target && typeof target[key] === 'string') target[key] = reference(target[key]);
  };
  const keys = (target: Record<string, unknown> | undefined) => {
    if (!target) return;
    for (const [key, value] of Object.entries(target)) {
      const next = reference(key);
      if (next === key) continue;
      if (!Object.hasOwn(target, next)) target[next] = value;
      delete target[key];
    }
  };
  pointer(config, 'default_model');
  keys(object(object(config['thinking'])?.['model_efforts']));
  const secondary = object(config['secondary_model']);
  pointer(secondary, 'default_model');
  keys(object(secondary?.['models']));
  return renamed;
}
