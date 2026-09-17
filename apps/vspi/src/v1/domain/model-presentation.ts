import type { ModelOption } from './types.js';

const FAMILY_ORDER = ['gpt', 'claude', 'kimi', 'glm', 'deepseek', 'minimax', 'mimo', 'qwen', 'gemini', 'hunyuan'];

export function modelIdentityKey(model: { provider?: string; id: string } | undefined): string {
  return model ? `${model.provider ?? ''}\u0000${model.id}` : '';
}

export function modelHasIdentity(model: ModelOption, key: string): boolean {
  return (model.displayIds ?? [model.id]).some(id => modelIdentityKey({ provider: model.provider, id }) === key);
}

export function groupModelAliases(models: readonly ModelOption[], selectedKey: string): ModelOption[] {
  const parent = models.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]!]!; index = parent[index]!; }
    return index;
  };
  const identities = new Map<string, number>();
  models.forEach((model, index) => {
    for (const id of [model.wireId ?? model.id, ...model.modelAliases ?? []]) {
      const canonical = id.replace(/^kimi-(k3(?:-256k)?)$/u, '$1');
      const key = JSON.stringify([model.provider ?? model.brand, model.protocol, model.endpoint, canonical]);
      const previous = identities.get(key);
      if (previous !== undefined) parent[root(index)] = root(previous);
      identities.set(key, index);
    }
  });
  const groups = new Map<number, ModelOption[]>();
  models.forEach((model, index) => {
    const key = root(index);
    const entries = groups.get(key) ?? [];
    entries.push(model);
    groups.set(key, entries);
  });
  return [...groups.values()].map(entries => {
    const preferred = entries.find(model => /^kimi-k3(?:-256k)?$/u.test(model.id)) ?? entries[0]!;
    const selected = entries.find(model => modelIdentityKey(model) === selectedKey) ?? preferred;
    const displayIds = [...new Set([preferred.id, ...entries.flatMap(modelIds)])];
    return { ...selected, displayIds, curated: entries.some(model => model.curated) };
  });
}

function modelIds(model: ModelOption): string[] {
  return [model.id, model.wireId, ...model.modelAliases ?? []].filter((id): id is string => id !== undefined && id !== '');
}

function modelFamily(model: ModelOption): string {
  const id = model.id.split('/').at(-1)?.toLowerCase() ?? '';
  const identities = [model.wireId?.split('/').at(-1)?.toLowerCase() ?? '', id, model.label.toLowerCase()];
  for (const value of identities) {
    if (/^(?:gpt(?:[-\s\d]|$)|o\d)/u.test(value)) return 'gpt';
    if (/^(?:kimi(?:[-\s]|$)|k\d)/u.test(value)) return 'kimi';
    if (/^(?:hunyuan|hy\d)/u.test(value)) return 'hunyuan';
    const family = FAMILY_ORDER.find(name => value.startsWith(name));
    if (family) return family;
  }
  return id.split(/[-_.\s\d]/u)[0] || model.brand.toLowerCase();
}

export function compareModelFamily(left: ModelOption, right: ModelOption): number {
  const a = modelFamily(left);
  const b = modelFamily(right);
  const rank = (family: string) => {
    const index = FAMILY_ORDER.indexOf(family);
    return index < 0 ? FAMILY_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
