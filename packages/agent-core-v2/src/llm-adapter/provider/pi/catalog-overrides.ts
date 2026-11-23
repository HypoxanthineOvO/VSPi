import type { Api, Model, ThinkingLevelMap } from '@earendil-works/pi-ai';

type CatalogPatch = Partial<Omit<Model<Api>, 'id' | 'api' | 'provider' | 'baseUrl'>>;
type CatalogEntry = readonly [id: string, template: string, patch: CatalogPatch];

const five: ThinkingLevelMap = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const three: ThinkingLevelMap = { ...five, medium: null, xhigh: null };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function openAICost(input: number, output: number, cacheRead: number): Model<Api>['cost'] {
  return {
    input, output, cacheRead, cacheWrite: input * 1.25,
    tiers: [{ inputTokensAbove: 272000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: input * 2.5 }],
  };
}

const gpt = [
  ['gpt-6.2-sol', 'GPT 6.2 Sol', 500000, null, openAICost(2, 10, 0.1)],
  ['gpt-6.2-astra', 'GPT 6.2 Astra', 272000, null, openAICost(8, 40, 0.4)],
  ['gpt-6.1-terra', 'GPT 6.1 Terra', 500000, 'none', openAICost(1, 5, 0.05)],
] as const;

const gemini = [
  ['gemini-4-argon', 'Gemini 4 Argon', 32768, 2, 10, 0.1, false],
  ['gemini-4-carbon', 'Gemini 4 Carbon', 32768, 2, 10, 0.1, false],
  ['gemini-4-neon', 'Gemini 4 Neon', 65536, 3, 15, 0.15, true],
  ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', 65536, 1.5, 7.5, 0.075, true],
] as const;

const kimi = [
  ['k3.1-pro', 'Kimi K3.1 Pro', 2, 10, 1.9437, 10.1671],
  ['k3.1-pro-highspeed', 'Kimi K3.1 Pro Highspeed', 4, 20, 3.8874, 20.3342],
] as const;

function kimiEntries(cn: boolean): CatalogEntry[] {
  return kimi.map(([id, name, input, output, inputCn, outputCn]) => [`kimi-${id}`, 'kimi-k3', {
    name, contextWindow: 1048576, maxTokens: 1048576, thinkingLevelMap: { ...three, medium: null },
    cost: { ...zero, input: cn ? inputCn : input, output: cn ? outputCn : output, cacheRead: cn ? 0.1944 : 0.2 },
  }]);
}

const CATALOG_PATCHES: Readonly<Record<string, readonly CatalogEntry[]>> = {
  openai: gpt.map(([id, name, , off, cost]) => [id, 'gpt-6.1-sol', {
    name, contextWindow: 1050000, maxTokens: 128000, cost, thinkingLevelMap: { ...five, off },
  }]),
  'openai-codex': [
    ...gpt.map(([id, name, contextWindow, off, cost]): CatalogEntry => [id, 'gpt-6.1-sol', {
      name, contextWindow, maxTokens: 128000, cost, thinkingLevelMap: { ...five, off },
    }]),
    ['gpt-6.1-sol', 'gpt-6.1-sol', { contextWindow: 500000, thinkingLevelMap: five }],
    ['codex-auto-review', 'gpt-6.1-sol', { name: 'Codex Auto Review', contextWindow: 272000, cost: zero, thinkingLevelMap: five }],
  ],
  anthropic: [
    ['claude-fable-5-2', 'claude-fable-5-1', {
      name: 'Claude Fable 5.2', cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, thinkingLevelMap: five,
    }],
  ],
  google: gemini.map(([id, name, maxTokens, input, output, cacheRead, xhigh]) => [id, 'gemini-3.8-flash', {
    name, maxTokens, cost: { ...zero, input, output, cacheRead }, thinkingLevelMap: { ...five, xhigh: xhigh ? 'xhigh' : null, max: null },
  }]),
  'google-vertex': gemini.map(([id, name, , input, output, cacheRead, xhigh]) => [id, 'gemini-3.8-flash', {
    name, maxTokens: 65536, cost: { ...zero, input, output, cacheRead }, thinkingLevelMap: { ...five, xhigh: xhigh ? 'xhigh' : null, max: null },
  }]),
  'kimi-coding': kimi.map(([id, name, input, output]) => [id, 'k3', {
    name, maxTokens: 1048576, cost: { ...zero, input, output, cacheRead: 0.2 },
  }]),
  moonshotai: kimiEntries(false),
  'moonshotai-cn': kimiEntries(true),
  minimax: [
    ['MiniMax-M3.1-Flash', 'MiniMax-M3', { name: 'MiniMax M3.1 Flash', maxTokens: 524288, cost: { ...zero, input: 0.15, output: 0.6, cacheRead: 0.015 }, thinkingLevelMap: five, compat: { forceAdaptiveThinking: true } }],
    ['MiniMax-M3', 'MiniMax-M3', { maxTokens: 524288 }],
  ],
  'minimax-cn': [
    ['MiniMax-M3.1-Flash', 'MiniMax-M3', { name: 'MiniMax M3.1 Flash', maxTokens: 524288, cost: { ...zero, input: 0.1494, output: 0.5976, cacheRead: 0.0149 }, thinkingLevelMap: five, compat: { forceAdaptiveThinking: true } }],
    ['MiniMax-M3', 'MiniMax-M3', { maxTokens: 524288 }],
  ],
  deepseek: [
    ['deepseek-flash', 'deepseek-flash', { cost: { ...zero, input: 0.15, output: 0.6, cacheRead: 0.003 } }],
    ['deepseek-v4-pro', 'deepseek-v4-pro', { cost: { ...zero, input: 0.66, output: 1.98, cacheRead: 0.022 } }],
  ],
};

const volcenginePlan = 'volcengine-token-plan';
const volcengineBaseUrl = 'https://ark.cn-beijing.volces.com/api/coding/v3';

export const ADDITIONAL_PI_CATALOGS = [{
  id: volcenginePlan, protocol: 'openai' as const, baseUrl: volcengineBaseUrl, envKey: 'ARK_CODING_PLAN_API_KEY',
  models: [{
    id: 'doubao-seed-2.1-pro', name: 'Doubao Seed 2.1 Pro', provider: volcenginePlan, api: 'openai-completions', baseUrl: volcengineBaseUrl,
    reasoning: true, input: ['text', 'image'], contextWindow: 1024000, maxTokens: 256000, cost: zero,
    thinkingLevelMap: { ...three, off: 'none', max: null },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true },
  }] satisfies Model<Api>[],
}];

export function extendPiCatalog(provider: string, builtins: readonly Model<Api>[]): Model<Api>[] {
  const models = [...builtins];
  for (const [id, baseId, patch] of CATALOG_PATCHES[provider] ?? []) {
    const index = models.findIndex(model => model.id === id);
    const template = index < 0 ? builtins.find(model => model.id === baseId) : models[index];
    if (!template) throw new Error(`Missing model catalog template ${provider}/${baseId}`);
    const model = { ...template, ...patch, id };
    if (index < 0) models.push(model);
    else models[index] = model;
  }
  return models;
}
