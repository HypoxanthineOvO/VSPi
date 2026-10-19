import type { ModelRecord } from './model';

export interface CanonicalModel {
  id: string;
  company: string;
  displayName: string;
}

export interface CanonicalModelInput {
  id: string;
  company?: string;
  displayName?: string;
}

const FAMILIES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^claude-(?:[a-z]+-)*\d/u, 'anthropic', 'Anthropic'],
  [/^(?:gpt-\d|o\d(?:-|$)|codex(?:-|$))/u, 'openai', 'OpenAI'],
  [/^gemini-\d/u, 'google', 'Google'],
  [/^deepseek-(?:v\d|r\d|chat(?:-|$)|reasoner(?:-|$)|flash(?:-|$)|pro(?:-|$))/u, 'deepseek', 'DeepSeek'],
  [/^kimi-(?:k\d|thinking|latest|for-coding)/u, 'moonshot', 'Moonshot'],
  [/^glm-\d/u, 'zhipu', 'Zhipu'],
  [/^minimax-(?:m\d|text)/u, 'minimax', 'MiniMax'],
  [/^mimo-v\d/u, 'xiaomi', 'Xiaomi'],
  [/^swe-\d/u, 'cognition', 'Cognition'],
  [/^qwen(?:\d|-\d)/u, 'alibaba', 'Alibaba'],
  [/^grok-\d/u, 'xai', 'xAI'],
  [/^(?:hunyuan(?:-|\d)|hy\d)/u, 'tencent', 'Tencent'],
  [/^longcat-\d/u, 'meituan', 'Meituan'],
  [/^step-\d/u, 'stepfun', 'StepFun'],
];

const VENDOR_PREFIX = /^(?:devin|claude|anthropic|openai|moonshotai|moonshot|google|deepseek|zhipu|z-ai|minimax|xiaomi|cognition|alibaba|qwen|x-ai|xai|tencent)\//u;
const REVIEWED_ALIASES: Readonly<Record<string, string>> = { 'deepseek-flash': 'deepseek-v4.1-flash' };

function normalizeIdentity(value: string): string {
  let id = value.trim().toLowerCase().replace(VENDOR_PREFIX, '')
    .replace(/\s*\((?:official|官方)\)$/u, '')
    .replace(/[ _]+/gu, '-').replace(/-+/gu, '-');
  id = id.replace(/^k(\d)/u, 'kimi-k$1');
  if (id.startsWith('claude-')) id = id.replace(/-(?:low|medium|high|max)$/u, '');
  id = id.replace(/-\d{8}$/u, '');
  id = id.replace(/(\d)[.-](?=\d+(?:[.-]|$))/gu, '$1.');
  return REVIEWED_ALIASES[id] ?? id;
}

function identify(value: string): CanonicalModel | undefined {
  const normalized = normalizeIdentity(value);
  const family = FAMILIES.find(([pattern]) => pattern.test(normalized));
  if (!family) return undefined;
  const [, vendor, company] = family;
  return { id: `${vendor}/${normalized}`, company, displayName: displayName(normalized) };
}

function displayName(id: string): string {
  return id.split('-').map((part, index) => {
    if (index === 0) return ({ gpt: 'GPT', glm: 'GLM', mimo: 'MiMo', minimax: 'MiniMax', deepseek: 'DeepSeek', swe: 'SWE' } as Record<string, string>)[part] ?? part[0]!.toUpperCase() + part.slice(1);
    if (/^(?:k|m|v)\d/u.test(part)) return part.toUpperCase();
    return part[0]!.toUpperCase() + part.slice(1);
  }).join(' ');
}

export function resolveCanonicalModel(alias: string, record: ModelRecord, provider?: string): CanonicalModel {
  const override = record.overrides?.canonical ?? record.canonical;
  if (override) {
    const inferred = identify(override.id);
    return {
      id: override.id,
      company: override.company ?? inferred?.company ?? '未归类',
      displayName: override.displayName ?? inferred?.displayName ?? override.id,
    };
  }
  const providerId = provider || record.provider || record.providerId;
  const aliasModel = providerId && alias.startsWith(`${providerId}/`) ? alias.slice(providerId.length + 1) : alias.slice(alias.indexOf('/') + 1);
  for (const value of [record.name, record.model, record.displayName, aliasModel]) {
    if (!value) continue;
    const match = identify(value);
    if (match) return match;
  }
  return {
    id: `unclassified/${encodeURIComponent(provider ?? record.provider ?? record.providerId ?? '')}/${encodeURIComponent(alias)}`,
    company: '未归类',
    displayName: record.displayName ?? record.name ?? record.model ?? alias,
  };
}
