import { groupModelAliases, modelIdentityKey } from './model-presentation.js';
import type { ModelOption } from './types.js';

export const DEFAULT_SOURCE_PRIORITY = ['devin', 'openai-codex', 'github-copilot', 'anthropic', 'kimi-coding', 'opencode-go', 'openai', 'deepseek', 'moonshotai', 'moonshotai-cn', 'moonshot', 'google', 'zai', 'zhipu', 'minimax', 'xiaomi', 'vsplab'];

export function defaultProviderPriority(providers: readonly { id: string; status: string; has_api_key: boolean }[]): string[] {
  const rank = (id: string) => {
    const index = DEFAULT_SOURCE_PRIORITY.indexOf(id);
    return index < 0 ? DEFAULT_SOURCE_PRIORITY.length : index;
  };
  return [...providers].filter(provider => provider.status === 'connected')
    .sort((left, right) => Number(left.has_api_key) - Number(right.has_api_key) || rank(left.id) - rank(right.id) || left.id.localeCompare(right.id))
    .map(provider => provider.id);
}
export const COMPANY_ORDER = ['Anthropic', 'OpenAI', 'DeepSeek', 'Google', 'Moonshot', 'Zhipu', 'MiniMax', 'Xiaomi', 'Cognition', 'Alibaba', 'xAI', 'Tencent', '未归类'];

export interface CanonicalModelGroup {
  id: string;
  company: string;
  label: string;
  sources: ModelOption[];
  defaultSource?: ModelOption;
}

export function sourceUnhealthy(model: Pick<ModelOption, 'health'>, now = Date.now()): boolean {
  const health = model.health;
  return health !== undefined && health.expiresAt > now && health.lastFailure !== undefined && health.lastFailure.at > (health.lastSuccess ?? 0);
}

export function sourceHealthLabel(model: Pick<ModelOption, 'health'>, now = Date.now()): string {
  if (!model.health) return '未测试';
  if (model.health.expiresAt <= now) return '记录已过期';
  if (!sourceUnhealthy(model, now)) return '✓ 最近成功';
  return ({ auth: '⚠ 凭据被拒绝 (401/403)', not_found: '⚠ 模型不存在 (404)', rate_limit: '⚠ 请求限流 (429)', network: '⚠ 网络异常', other: '⚠ 请求失败' })[model.health.lastFailure!.category];
}

export function canonicalModelGroups(models: readonly ModelOption[], remembered: Readonly<Record<string, string>> = {}, selectedKey = '', now = Date.now()): CanonicalModelGroup[] {
  const groups = new Map<string, CanonicalModelGroup>();
  for (const model of models) {
    const canonical = model.canonical;
    const id = canonical?.id ?? `unclassified/${modelIdentityKey(model)}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, company: canonical?.company ?? '未归类', label: canonical?.displayName ?? model.label, sources: [] };
      groups.set(id, group);
    }
    group.sources.push(model);
  }
  for (const group of groups.values()) {
    group.sources = groupModelAliases(group.sources, remembered[group.id] ?? selectedKey);
    const rank = (model: ModelOption) => {
      const index = DEFAULT_SOURCE_PRIORITY.indexOf(model.provider ?? '');
      return model.sourcePriority ?? (index < 0 ? DEFAULT_SOURCE_PRIORITY.length : index);
    };
    group.sources.sort((left, right) => Number(sourceUnhealthy(left, now)) - Number(sourceUnhealthy(right, now)) || Number(modelIdentityKey(right) === remembered[group.id]) - Number(modelIdentityKey(left) === remembered[group.id]) || rank(left) - rank(right) || left.brand.localeCompare(right.brand) || left.id.localeCompare(right.id));
    group.defaultSource = group.sources.find(source => !sourceUnhealthy(source, now));
  }
  const rank = (company: string) => {
    const index = COMPANY_ORDER.indexOf(company);
    return index < 0 ? COMPANY_ORDER.length - 1 : index;
  };
  return [...groups.values()].sort((left, right) => rank(left.company) - rank(right.company) || left.company.localeCompare(right.company) || left.label.localeCompare(right.label, undefined, { numeric: true }));
}

export function searchCanonicalModels(groups: CanonicalModelGroup[], query: string): CanonicalModelGroup[] {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return groups.flatMap(group => {
    const providers = tokens.filter(token => token.startsWith('@')).map(token => token.slice(1));
    const names = tokens.filter(token => !token.startsWith('@'));
    const sources = group.sources.filter(source => providers.every(provider => `${source.provider ?? ''} ${source.brand}`.toLowerCase().includes(provider)));
    if (!sources.length || !names.every(token => `${group.id} ${group.label} ${group.company} ${sources.flatMap(source => [source.id, source.wireId, source.label, ...source.modelAliases ?? []]).join(' ')}`.toLowerCase().includes(token))) return [];
    return [{ ...group, sources, defaultSource: sources.find(source => source === group.defaultSource) ?? sources.find(source => !sourceUnhealthy(source)) }];
  });
}
