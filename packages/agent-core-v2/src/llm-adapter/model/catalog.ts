import type { ThinkingCapability } from '#human/llm/capability';
import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ModelCapability } from '../contract/capability';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';
import type { TokenUsage } from '#human/llm/usage';
import type { Protocol, ProtocolProviderOptions } from '../protocol/protocol';
import type { ProviderConfig } from '../provider/provider';

import type { ModelRecord } from './model';
import { effectiveModelConfig, resolveModelProtocol } from './model-auth';
import { ProtocolSchema } from '../protocol/protocol';
import { normalizeThinkingCapability, thinkingEffortsForProvider } from '../contract/capability';
import type {
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
} from './model-requester';

export interface Model {
  readonly thinking?: ThinkingCapability;
  readonly effortMapping?: Readonly<Record<string, string | null>>;
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;

  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking: boolean;
  readonly adaptiveThinking?: boolean;
  readonly providerType?: string;
  readonly providerName: string;

  readonly credentialProvider?: LlmCredentialProvider;
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface ModelPingResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
}

const thinkingCapabilityWireSchema = z.object({
  availability: z.enum(['none', 'always', 'dynamic']),
  can_disable: z.boolean(),
  controls: z.array(z.enum(['toggle', 'effort', 'budget'])),
  efforts: z.array(z.string()).optional(),
  provider_efforts: z.record(z.string(), z.array(z.string())).optional(),
  default_effort: z.string().optional(),
});

export const modelCatalogItemSchema = z.object({
  protocol: ProtocolSchema.optional(),
  pricing_source: z.enum(['official', 'provider']).optional(),
  curated: z.boolean().optional(),
  released_at: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  wire_model: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  base_url: z.string().optional(),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
  thinking: thinkingCapabilityWireSchema,
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
  pricing: z.object({
    input_usd_per_million: z.number().nonnegative(),
    output_usd_per_million: z.number().nonnegative(),
    cache_read_usd_per_million: z.number().nonnegative().optional(),
    cache_write_usd_per_million: z.number().nonnegative().optional(),
    context_tiers: z.array(z.object({
      context_tokens_above: z.number().int().positive(),
      input_usd_per_million: z.number().nonnegative(),
      output_usd_per_million: z.number().nonnegative(),
    })).optional(),
  }).optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const providerCatalogStatusSchema = z.enum([
  'connected',
  'error',
  'unconfigured',
]);
export type ProviderCatalogStatus = z.infer<typeof providerCatalogStatusSchema>;

export const providerCatalogItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  base_url: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  api_key_env: z.string().optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
});
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string().min(1),
  model: modelCatalogItemSchema,
});
export type SetDefaultModelResponse = z.infer<typeof setDefaultModelResponseSchema>;

export interface ProviderCredentialState {
  readonly hasApiKey: boolean;
  readonly hasOAuthToken: boolean;
  readonly hasCredentialConflict: boolean;
}

export function toProtocolModel(
  model: Model,
  record: ModelRecord,
  providerType?: string,
): ModelCatalogItem {
  const effective = effectiveModelConfig(record, providerType ?? model.providerType);
  const thinking = normalizeThinkingCapability(model.thinking ?? effective.thinking);
  const efforts = thinkingEffortsForProvider(thinking, providerType ?? model.providerType);
  return {
    provider: model.providerName,
    protocol: model.protocol,
    curated: effective.curated,
    pricing_source: record.pricing === undefined ? effective.pricingSource : record.pricingSource ?? 'provider',
    released_at: effective.releasedAt,
    model: model.id,
    wire_model: model.name,
    aliases: model.aliases.length > 0 ? [...model.aliases] : undefined,
    base_url: model.baseUrl,
    display_name: model.displayName ?? model.name ?? model.id,
    max_context_size: model.maxContextSize,
    capabilities: Object.entries(model.capabilities).flatMap(([key, value]) => value === true ? [key] : []),
    thinking: toProtocolThinking(thinking),
    support_efforts: efforts.length === 0 ? undefined : [...efforts],
    default_effort: thinking.defaultEffort,
    pricing: toProtocolPricing(effective),
  };
}

export function toProtocolModelFallback(
  modelId: string,
  record: ModelRecord,
  providerType?: string,
): ModelCatalogItem {
  const effective = effectiveModelConfig(record, providerType);
  const thinking = normalizeThinkingCapability(effective.thinking);
  const efforts = thinkingEffortsForProvider(thinking, providerType);
  return {
    provider: effective.provider ?? '',
    protocol: resolveModelProtocol(effective, { type: providerType }),
    pricing_source: record.pricing === undefined ? effective.pricingSource : record.pricingSource ?? 'provider',
    curated: effective.curated,
    released_at: effective.releasedAt,
    model: modelId,
    wire_model: effective.name ?? effective.model,
    aliases: effective.aliases,
    base_url: effective.baseUrl,
    display_name: effective.displayName ?? effective.model ?? modelId,
    max_context_size: effective.maxContextSize ?? 0,
    capabilities: effective.capabilities,
    thinking: toProtocolThinking(thinking),
    support_efforts: efforts.length === 0 ? undefined : [...efforts],
    default_effort: thinking.defaultEffort,
    pricing: toProtocolPricing(effective),
  };
}

function toProtocolThinking(thinking: ThinkingCapability): z.infer<typeof thinkingCapabilityWireSchema> {
  return {
    availability: thinking.availability,
    can_disable: thinking.canDisable,
    controls: [...thinking.controls],
    efforts: thinking.efforts === undefined ? undefined : [...thinking.efforts],
    provider_efforts:
      thinking.providerEfforts === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(thinking.providerEfforts).map(([provider, efforts]) => [
              provider,
              [...efforts],
            ]),
          ),
    default_effort: thinking.defaultEffort,
  };
}

function toProtocolPricing(record: ModelRecord): ModelCatalogItem['pricing'] {
  if (record.pricing === undefined) return undefined;
  return {
    input_usd_per_million: record.pricing.inputUsdPerMillion,
    output_usd_per_million: record.pricing.outputUsdPerMillion,
    cache_read_usd_per_million: record.pricing.cacheReadUsdPerMillion,
    cache_write_usd_per_million: record.pricing.cacheWriteUsdPerMillion,
    context_tiers: record.pricing.contextTiers?.map((tier) => ({
      context_tokens_above: tier.contextTokensAbove,
      input_usd_per_million: tier.inputUsdPerMillion,
      output_usd_per_million: tier.outputUsdPerMillion,
    })),
  };
}

export function toProtocolProvider(
  providerId: string,
  provider: ProviderConfig,
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
  credential: ProviderCredentialState,
): ProviderCatalogItem {
  const providerModels = modelIdsForProvider(models, providerId);
  const defaultModel =
    provider.defaultModel ?? globalDefaultForProvider(models, globalDefaultModel, providerId);
  return {
    id: providerId,
    type: provider.type ?? 'openai',
    base_url: provider.baseUrl,
    default_model: defaultModel,
    api_key_env: provider.apiKeyEnv,
    has_api_key: credential.hasApiKey,
    status: credential.hasCredentialConflict
      ? 'error'
      : credential.hasApiKey || credential.hasOAuthToken
        ? 'connected'
        : 'unconfigured',
    models: providerModels,
  };
}

export function modelIdsForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  providerId: string,
): string[] {
  return Object.entries(models)
    .filter(([, record]) => record.provider === providerId)
    .map(([modelId]) => modelId);
}

export function globalDefaultForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
  providerId: string,
): string | undefined {
  if (globalDefaultModel === undefined) return undefined;
  const record = models[globalDefaultModel];
  return record?.provider === providerId ? globalDefaultModel : undefined;
}

export interface IModelCatalog {
  listBuiltinProviders(): Promise<readonly ProviderCatalogItem[]>;
  configureBuiltinProvider(providerId: string, apiKey: string): Promise<void>;
  readonly _serviceBrand: undefined;

  get(id: string): Model;
  getRequester(id: string): ModelRequester;
  generate(
    id: string,
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent>;
  ping(id: string): Promise<ModelPingResult>;
  findByName(name: string): readonly string[];

  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
}

export const IModelCatalog: ServiceIdentifier<IModelCatalog> =
  createDecorator<IModelCatalog>('modelResolver');
