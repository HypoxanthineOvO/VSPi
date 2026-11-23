import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ModelCapability, ThinkingCapability } from '#/llm-adapter/contract/capability';
import type { Protocol } from '#/llm-adapter/protocol/protocol';
import { normalizeIdentity } from '#/llm-adapter/model/canonical';
import { ADDITIONAL_PI_CATALOGS, extendPiCatalog } from './catalog-overrides';

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  openai_responses: 'openai',
  'google-genai': 'google',
  zhipu: 'zai',
  mimo: 'xiaomi',
  kimi: 'moonshotai',
};

const providers = builtinProviders();

export function relayNativeProvider(name: string): string | undefined {
  const id = name.split('/').at(-1)?.toLowerCase() ?? '';
  if (/^(?:gpt-|o\d(?:-|$)|codex-)/u.test(id)) return 'openai';
  if (id.startsWith('claude-')) return 'anthropic';
  if (/^(?:kimi-|k[23](?:[.-]|$))/u.test(id)) return 'moonshotai';
  if (id.startsWith('glm-')) return 'zai';
  if (id.startsWith('deepseek-')) return 'deepseek';
  if (id.startsWith('mimo-')) return 'xiaomi';
  if (id.startsWith('minimax-')) return 'minimax';
  if (id.startsWith('gemini-')) return 'google';
  if (id.startsWith('doubao-')) return 'volcengine-token-plan';
  if (/^qwen3\.8-(?:max|flash)$/u.test(id)) return 'qwen-token-plan-cn';
  if (id.startsWith('qwen')) return 'alibaba';
  if (id.startsWith('hy4')) return 'tencent';
  return undefined;
}

export function piProtocolForApi(api: Api): Protocol | undefined {
  switch (api) {
    case 'openai-completions': return 'openai';
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'azure-openai-responses': return 'openai_responses';
    case 'anthropic-messages': return 'anthropic';
    case 'google-generative-ai':
    case 'google-vertex': return 'google-genai';
    default: return undefined;
  }
}

interface PiProviderCatalog {
  readonly id: string;
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly envKey?: string;
  readonly models: Model<Api>[];
}

const catalogOnly = new Set(['codex-auto-review']);
const catalogs: readonly PiProviderCatalog[] = [
  ...providers.flatMap((provider) => {
    const models = extendPiCatalog(provider.id, provider.getModels().filter(model => piProtocolForApi(model.api) !== undefined));
    const first = models[0];
    return first === undefined ? [] : [{ id: provider.id, protocol: piProtocolForApi(first.api)!, baseUrl: first.baseUrl, models }];
  }),
  ...ADDITIONAL_PI_CATALOGS,
];
const selectableCatalogs = catalogs.map(provider => ({ ...provider, models: provider.models.filter(model => !catalogOnly.has(model.id)) }));

export function listPiProviders(): readonly PiProviderCatalog[] {
  return selectableCatalogs;
}

export function findPiModel(providerType: string | undefined, modelName: string, protocol?: Protocol, options: { allowFallback?: boolean } = {}): Model<Api> | undefined {
  if (providerType === 'devin') return undefined;
  const provider = PROVIDER_ALIASES[providerType ?? ''] ?? providerType;
  const protocolMatches = (model: Model<Api>) => protocol === undefined || piProtocolForApi(model.api) === protocol;
  const exactMatch = (model: Model<Api>) => model.id === modelName && protocolMatches(model);
  const exact = catalogs.find(entry => entry.id === provider)?.models.find(exactMatch);
  if (exact !== undefined) return structuredClone(exact);
  if (options.allowFallback === false) return undefined;
  const nativeModels = catalogs.find(entry => entry.id === relayNativeProvider(modelName))?.models;
  const id = normalizeIdentity(modelName.split('/').at(-1) ?? '');
  const native = nativeModels?.find(exactMatch) ?? nativeModels?.find(model => protocolMatches(model) && normalizeIdentity(model.id) === id);
  if (native !== undefined) return structuredClone(native);
  const candidates = catalogs.flatMap(entry => entry.models.filter(model => model.api !== 'openai-codex-responses' && exactMatch(model)));
  const direct = candidates.filter(model => !['openrouter', 'vercel-ai-gateway', 'github-copilot', 'opencode', 'opencode-go'].includes(model.provider));
  const picked = direct[0] ?? candidates[0];
  if (picked === undefined) return undefined;
  const signature = (model: Model<Api>) => JSON.stringify([model.input, getSupportedThinkingLevels(model), model.thinkingLevelMap]);
  const peers = direct.length > 0 ? direct : candidates;
  return peers.every(model => signature(model) === signature(picked)) ? structuredClone(picked) : undefined;
}

export function piThinking(model: Model<Api>): ThinkingCapability {
  if (!model.reasoning) return { availability: 'none', canDisable: false, controls: [] };
  const levels = getSupportedThinkingLevels(model);
  const canDisable = levels.includes('off');
  const efforts = levels.filter((level) => level !== 'off');
  return {
    availability: canDisable ? 'dynamic' : 'always',
    canDisable,
    controls: canDisable ? ['toggle', 'effort'] : ['effort'],
    efforts,
    defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0],
  };
}

export function piCapability(model: Model<Api>): ModelCapability {
  return {
    image_in: model.input.includes('image'),
    video_in: false,
    audio_in: false,
    thinking: model.reasoning,
    tool_use: true,
    max_context_tokens: model.contextWindow,
  };
}

export function piModelRecord(model: Model<Api>, provider: string) {
  return {
    pricingSource: 'official' as const,
    provider,
    model: model.id,
    protocol: piProtocolForApi(model.api),
    displayName: model.name,
    maxContextSize: model.contextWindow,
    maxOutputSize: model.maxTokens,
    capabilities: ['tool_use', ...model.input.includes('image') ? ['image_in'] : [], ...model.reasoning ? ['thinking'] : []],
    thinking: piThinking(model),
    pricing: {
      inputUsdPerMillion: model.cost.input,
      outputUsdPerMillion: model.cost.output,
      cacheReadUsdPerMillion: model.cost.cacheRead,
      cacheWriteUsdPerMillion: model.cost.cacheWrite,
      contextTiers: model.cost.tiers?.map((tier) => ({
        contextTokensAbove: tier.inputTokensAbove,
        inputUsdPerMillion: tier.input,
        outputUsdPerMillion: tier.output,
      })),
    },
  };
}

export function listPiModelRecords(providerType: string, configProviderId = providerType) {
  const provider = listPiProviders().find((entry) => entry.id === providerType);
  return Object.fromEntries((provider?.models ?? []).map((model) => [
    `${configProviderId}/${model.id}`,
    piModelRecord(model, configProviderId),
  ]));
}
