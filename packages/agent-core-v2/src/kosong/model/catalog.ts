import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import {
  normalizeThinkingCapability,
  thinkingEffortsForProvider,
  type ModelCapability,
  type ThinkingCapability,
} from '#/kosong/contract/capability';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { Protocol, ProtocolProviderOptions } from '#/kosong/protocol/protocol';

import type { ProviderConfig } from '../provider/provider';

import type { ModelInspection } from './inspection';
import type { ModelRecord } from './model';
import { effectiveModelConfig } from './modelAuth';
import type { ModelRequester } from './modelRequester';

export interface AuthProvider {
  readonly canRefresh?: boolean;

  getAuth(options?: { readonly force?: boolean }): Promise<ProviderRequestAuth | undefined>;
}

export class StaticAuthProvider implements AuthProvider {
  readonly canRefresh = false;

  constructor(private readonly apiKey: string | undefined) {}
  async getAuth(): Promise<ProviderRequestAuth | undefined> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) return undefined;
    return { apiKey: this.apiKey };
  }
}

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;

  readonly capabilities: ModelCapability;
  readonly thinking?: ThinkingCapability;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking: boolean;
  readonly providerType?: string;
  readonly providerName: string;

  readonly authProvider: AuthProvider;
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
  provider: z.string().min(1),
  model: z.string().min(1),
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
    model: model.id,
    display_name: model.displayName ?? model.name ?? model.id,
    max_context_size: model.maxContextSize,
    capabilities: effective.capabilities,
    thinking: toProtocolThinking(thinking),
    support_efforts: efforts.length === 0 ? undefined : [...efforts],
    default_effort: thinking.defaultEffort,
    pricing: toProtocolPricing(record),
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
    model: modelId,
    display_name: effective.displayName ?? effective.model ?? modelId,
    max_context_size: effective.maxContextSize ?? 0,
    capabilities: effective.capabilities,
    thinking: toProtocolThinking(thinking),
    support_efforts: efforts.length === 0 ? undefined : [...efforts],
    default_effort: thinking.defaultEffort,
    pricing: toProtocolPricing(record),
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
    has_api_key: credential.hasApiKey,
    status: credential.hasApiKey || credential.hasOAuthToken ? 'connected' : 'unconfigured',
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
  readonly _serviceBrand: undefined;

  get(id: string): Model;
  getRequester(id: string): ModelRequester;
  inspect(id: string): ModelInspection;
  ping(id: string): Promise<ModelPingResult>;
  findByName(name: string): readonly string[];

  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
}

export const IModelCatalog: ServiceIdentifier<IModelCatalog> =
  createDecorator<IModelCatalog>('modelResolver');
