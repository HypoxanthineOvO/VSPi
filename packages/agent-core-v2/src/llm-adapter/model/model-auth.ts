import { resolveDeepSeekCapabilities } from '../provider/deepseek/capabilities';
import { findPiModel, piModelRecord } from '../provider/pi/catalog';
import { defaultRelayProtocol, isRelayModel } from './relayDefaults';
import { applyModelEffortProfile } from './effortProfiles';
import { EFFORT_PROFILE_REVISION, modelEffortProfile } from '../provider/effortProfiles';
import { normalizeThinkingCapability, thinkingEffortsForProvider } from '../contract/capability';
import { Error2 } from '#/_base/errors/errors';
import {
  credentialConflictMessage,
  declaredProviderCredential,
} from '@moonshot-ai/kimi-code-oauth/provider-credential';
import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '#human/llm/requester/bases/anthropic/profile';

import { CONFIG_INVALID_ERROR_CODE } from '../contract/errors';
import { ProtocolSchema, type Protocol } from '../protocol/protocol';
import type { ProviderConfig } from '../provider/provider';
import { explainProviderEndpoint, getProviderDefinition } from '../provider/provider-definition';

import type { ModelRecord } from './model';
import type { ResolvedModelAuthMaterial } from './model.types';
import { drivesThinkingThroughTraits } from './thinking';

export function resolveModelAuthMaterial(args: {
  readonly modelId: string;
  readonly model: ModelRecord;
  readonly provider: ProviderConfig | undefined;
  readonly providerName: string;
}): ResolvedModelAuthMaterial {
  const modelApiKey = nonEmpty(args.model.apiKey);
  if (modelApiKey !== undefined && args.model.oauth !== undefined) {
    throw new Error2(
      CONFIG_INVALID_ERROR_CODE,
      credentialConflictMessage('Model', args.modelId, 'apiKey', 'oauth'),
    );
  }
  if (modelApiKey !== undefined) {
    return { apiKey: modelApiKey };
  }
  if (args.model.oauth !== undefined) {
    return {
      oauth: args.model.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }

  const providerAuthType = args.provider?.type ?? args.model.protocol;
  const providerEndpoint =
    providerAuthType === undefined
      ? {}
      : explainProviderEndpoint(providerAuthType, args.provider?.env ?? {});
  const declared = declaredProviderCredential(args.provider ?? {}, args.providerName);
  if (declared.kind === 'conflict') {
    throw new Error2(CONFIG_INVALID_ERROR_CODE, declared.message);
  }
  if (declared.kind === 'inline') {
    return { apiKey: declared.apiKey };
  }
  if (declared.kind === 'env') {
    return { apiKeyEnv: declared.apiKeyEnv };
  }
  const endpointApiKey =
    args.provider?.oauth === undefined ? nonEmpty(providerEndpoint.apiKey) : undefined;
  if (endpointApiKey !== undefined && args.provider?.oauth !== undefined) {
    throw new Error2(
      CONFIG_INVALID_ERROR_CODE,
      credentialConflictMessage('Provider', args.providerName, 'apiKey', 'oauth'),
    );
  }
  if (endpointApiKey !== undefined) {
    return { apiKey: endpointApiKey };
  }
  if (args.provider?.oauth !== undefined) {
    return {
      oauth: args.provider.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }
  return {};
}

export function effectiveModelConfig(
  model: ModelRecord,
  providerType?: string,
  provider?: ProviderConfig,
): ModelRecord {
  const profile = modelEffortProfile(model.name ?? model.model ?? '');
  const providerId = model.providerId ?? model.provider ?? '';
  const customEndpoint = model.baseUrl !== undefined && model.baseUrl !== provider?.baseUrl;
  const managed =
    !customEndpoint &&
    model.apiKey === undefined &&
    model.oauth === undefined &&
    (isRelayModel(model, provider) || profile?.providers.includes(providerId));
  const resolved =
    profile && managed && (model.effortProfileRevision ?? 0) < EFFORT_PROFILE_REVISION
      ? applyModelEffortProfile(model, profile)
      : model;
  const { overrides, ...base } = resolved;
  const deepseek = overrides?.deepseek === undefined ? base.deepseek : { ...base.deepseek, ...overrides.deepseek };
  const nativeDeepSeek = base.protocol === 'anthropic' && resolveDeepSeekCapabilities({ protocol: 'anthropic', providerType, modelName: base.name ?? base.model ?? '', baseUrl: base.baseUrl ?? provider?.baseUrl }, deepseek).nativeMessages;
  const piModel = findPiModel(
    providerType ?? base.providerId ?? base.provider,
    base.name ?? base.model ?? '',
    nativeDeepSeek ? 'openai' : base.protocol,
  );
  const defaults =
    piModel === undefined
      ? undefined
      : {
          ...piModelRecord(piModel, base.providerId ?? base.provider ?? piModel.provider),
          baseUrl: base.baseUrl,
          protocol: base.protocol,
          provider: base.provider,
        };
  const effective: ModelRecord = {
    ...defaults,
    ...Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined)),
    ...overrides,
  };

  if (deepseek !== undefined) effective.deepseek = deepseek;

  if (defaults !== undefined || base.thinking !== undefined || overrides?.thinking !== undefined) {
    effective.thinking = {
      ...defaults?.thinking,
      ...base.thinking,
      ...overrides?.thinking,
      efforts:
        overrides?.thinking?.efforts ??
        overrides?.supportEfforts ??
        base.thinking?.efforts ??
        base.supportEfforts ??
        defaults?.thinking.efforts,
      defaultEffort:
        overrides?.thinking?.defaultEffort ??
        overrides?.defaultEffort ??
        base.thinking?.defaultEffort ??
        base.defaultEffort ??
        defaults?.thinking.defaultEffort,
    };
    const controls = overrides?.thinking?.controls ?? base.thinking?.controls;
    if (controls !== undefined && !controls.includes('effort')) {
      effective.thinking.efforts = undefined;
      effective.thinking.providerEfforts = undefined;
      effective.thinking.defaultEffort = undefined;
      effective.supportEfforts = undefined;
      effective.defaultEffort = undefined;
    }
    if (
      (overrides?.capabilities ?? base.capabilities)?.includes('always_thinking') &&
      overrides?.thinking?.availability === undefined &&
      base.thinking?.availability === undefined
    ) {
      effective.thinking.availability = 'always';
      effective.thinking.canDisable = false;
    }
  }
  if (effective.effortMapping && effective.thinking && effective.thinking.availability !== 'none') {
    effective.thinking.efforts = effective.thinking.efforts?.filter(
      (level) => effective.effortMapping?.[level] !== null,
    );
    if (effective.effortMapping['off'] === null) {
      effective.thinking.canDisable = false;
      effective.thinking.availability = 'always';
    }
  }
  const clamped =
    effective.maxInputSize !== undefined &&
    effective.maxContextSize !== undefined &&
    effective.maxInputSize > effective.maxContextSize
      ? { ...effective, maxInputSize: effective.maxContextSize }
      : effective;
  return normalizeModelThinking(clamped, providerType);
}

export function withAnthropicProfile(model: ModelRecord, providerType?: string): ModelRecord {
  const wireName = model.name ?? model.model;
  const protocol = model.protocol ?? providerType;
  const profile =
    wireName === undefined
      ? undefined
      : providerType !== undefined &&
          !drivesThinkingThroughTraits(providerType) &&
          protocol === 'anthropic'
        ? (matchKnownAnthropicModelProfile(wireName) ?? matchUnknownClaudeProfile(wireName))
        : matchKnownAnthropicModelProfile(wireName);
  if (profile === undefined) return model;
  const capability = profile.canDisableThinking ? 'thinking' : 'always_thinking';
  const capabilities = model.capabilities ?? [];
  const hasCapability = capabilities.some(
    (candidate) => candidate.trim().toLowerCase() === capability,
  );
  const supportEfforts =
    model.supportEfforts ??
    (model.adaptiveThinking === false ? [...BUDGET_THINKING_EFFORTS] : [...profile.efforts]);
  return {
    ...model,
    capabilities: hasCapability ? capabilities : [...capabilities, capability],
    supportEfforts,
    defaultEffort: model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
  };
}

export function deriveProviderId(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    return baseUrl;
  }
}

export function providerNameFromFlatModel(model: ModelRecord): string | undefined {
  const baseUrl = nonEmpty(model.baseUrl);
  return baseUrl === undefined ? undefined : deriveProviderId(baseUrl);
}

export function resolveModelProtocol(
  model: ModelRecord,
  provider: ProviderConfig | undefined,
): Protocol | undefined {
  if (model.protocol !== undefined) {
    return model.protocol;
  }
  if (model.defaultProtocol !== undefined) return model.defaultProtocol;
  const relayProtocol = isRelayModel(model, provider)
    ? defaultRelayProtocol(model.name ?? model.model ?? '')
    : undefined;
  if (relayProtocol !== undefined) return relayProtocol;
  const providerType = provider?.type;
  if (providerType !== undefined) {
    const asProtocol = ProtocolSchema.safeParse(providerType);
    if (asProtocol.success) {
      return asProtocol.data;
    }
    const definition = getProviderDefinition(providerType);
    if (definition !== undefined) {
      return definition.baseProtocol;
    }
  }
  return undefined;
}

export function resolveEndpointBaseUrl(
  model: ModelRecord,
  provider: ProviderConfig,
): string | undefined {
  const fromModel = nonEmpty(model.baseUrl);
  if (fromModel !== undefined) {
    return fromModel;
  }
  const fromProvider = nonEmpty(provider.baseUrl);
  if (fromProvider !== undefined) {
    return fromProvider;
  }
  const endpointType = provider.type ?? model.protocol;
  const endpoint =
    endpointType === undefined ? {} : explainProviderEndpoint(endpointType, provider.env ?? {});
  return nonEmpty(endpoint.baseUrl);
}

export type ModelReadyFailureReason =
  | 'no-default'
  | 'dangling-alias'
  | 'provider-missing'
  | 'unresolvable';

export type ModelReadyResolution =
  | { readonly resolved: true }
  | { readonly resolved: false; readonly reason: ModelReadyFailureReason };

export function resolveModelForReady(
  modelId: string | undefined,
  models: Readonly<Record<string, ModelRecord>>,
  providers: Readonly<Record<string, ProviderConfig>>,
  defaultProvider?: string,
): ModelReadyResolution {
  if (modelId === undefined || modelId.trim().length === 0) {
    return { resolved: false, reason: 'no-default' };
  }
  const configured = models[modelId];
  if (configured === undefined) {
    return { resolved: false, reason: 'dangling-alias' };
  }
  const model = effectiveModelConfig(configured);
  const fallbackProvider =
    defaultProvider === undefined || defaultProvider.trim().length === 0
      ? undefined
      : defaultProvider;
  const providerId = model.providerId ?? model.provider ?? fallbackProvider;
  const provider = providerId === undefined ? undefined : providers[providerId];
  if (providerId !== undefined && provider === undefined) {
    return { resolved: false, reason: 'provider-missing' };
  }
  const providerName = providerId ?? providerNameFromFlatModel(model);
  if (providerName === undefined) {
    return { resolved: false, reason: 'unresolvable' };
  }
  if (nonEmpty(model.name ?? model.model) === undefined) {
    return { resolved: false, reason: 'unresolvable' };
  }
  const maxContextSize = model.maxContextSize;
  if (maxContextSize === undefined || maxContextSize <= 0) {
    return { resolved: false, reason: 'unresolvable' };
  }
  if (resolveModelProtocol(model, provider) === undefined) {
    return { resolved: false, reason: 'unresolvable' };
  }
  return { resolved: true };
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalizeModelThinking(model: ModelRecord, providerType?: string): ModelRecord {
  const normalizedCapabilities = (model.capabilities ?? [])
    .map((value) => value.trim().toLowerCase())
    .map((value) => (value === 'vision' ? 'image_in' : value));
  const declared = new Set(normalizedCapabilities);
  const thinking = normalizeThinkingCapability(model.thinking, {
    thinking: declared.has('thinking'),
    alwaysThinking: declared.has('always_thinking'),
    adaptiveThinking: model.adaptiveThinking,
    canDisable: model.offEffort !== undefined,
    supportEfforts: model.supportEfforts,
    defaultEffort: model.defaultEffort,
  });
  const supportEfforts = thinkingEffortsForProvider(thinking, providerType);
  const capabilities = normalizedCapabilities.filter(
    (value) => !['thinking', 'always_thinking'].includes(value),
  );
  if (thinking.availability !== 'none') {
    const capability = thinking.availability === 'always' ? 'always_thinking' : 'thinking';
    capabilities.push(capability);
  }
  return {
    ...model,
    capabilities:
      model.capabilities === undefined && capabilities.length === 0 ? undefined : capabilities,
    thinking,
    supportEfforts: supportEfforts.length === 0 ? undefined : [...supportEfforts],
    defaultEffort: thinking.defaultEffort,
  };
}
