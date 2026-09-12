import { Error2 } from '#/_base/errors/errors';
import {
  normalizeThinkingCapability,
  thinkingEffortsForProvider,
} from '#/kosong/contract/capability';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import type { InspectionSource, ResolutionTrace } from '#/kosong/contract/inspection';
import { ProtocolSchema, type Protocol } from '#/kosong/protocol/protocol';

import type { ProviderConfig } from '../provider/provider';
import { explainProviderEndpoint, getProviderDefinition } from '../provider/providerDefinition';
import { findPiModel, piModelRecord } from '../provider/pi/catalog';

import type { ModelRecord } from './model';
import type { ResolvedModelAuthMaterial } from './model.types';
import { defaultRelayProtocol, isRelayModel } from './relayDefaults';
import { applyModelEffortProfile } from './effortProfiles';
import { EFFORT_PROFILE_REVISION, modelEffortProfile } from '#/kosong/provider/effortProfiles';

export function resolveModelAuthMaterial(
  args: {
    readonly modelId: string;
    readonly model: ModelRecord;
    readonly provider: ProviderConfig | undefined;
    readonly providerName: string;
  },
  trace?: ResolutionTrace,
): ResolvedModelAuthMaterial {
  const modelApiKey = nonEmpty(args.model.apiKey);
  if (modelApiKey !== undefined && args.model.oauth !== undefined) {
    throw authConflictError('Model', args.modelId);
  }
  if (modelApiKey !== undefined) {
    trace?.record('resolved.auth', { kind: 'config', detail: 'model.apiKey' });
    return { apiKey: modelApiKey };
  }
  if (args.model.oauth !== undefined) {
    trace?.record('resolved.auth', { kind: 'config', detail: 'model.oauth' });
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
  const providerApiKey = nonEmpty(args.provider?.apiKey) ?? (args.provider?.oauth === undefined ? nonEmpty(providerEndpoint.apiKey) : undefined);
  if (providerApiKey !== undefined && args.provider?.oauth !== undefined) {
    throw authConflictError('Provider', args.providerName);
  }
  if (providerApiKey !== undefined) {
    trace?.record(
      'resolved.auth',
      nonEmpty(args.provider?.apiKey) !== undefined
        ? { kind: 'config', detail: `provider '${args.providerName}' apiKey` }
        : {
            kind: 'env',
            detail: `${providerEndpoint.apiKeyEnvName ?? '?'} (provider '${args.providerName}' env bag)`,
          },
    );
    return { apiKey: providerApiKey };
  }
  if (args.provider?.oauth !== undefined) {
    trace?.record('resolved.auth', {
      kind: 'config',
      detail: `provider '${args.providerName}' oauth`,
    });
    return {
      oauth: args.provider.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }
  trace?.record('resolved.auth', {
    kind: 'none',
    detail: 'no credential resolved at any layer (adapter construction may still read process.env)',
  });
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
  const managed = !customEndpoint && model.apiKey === undefined && model.oauth === undefined &&
    (isRelayModel(model, provider) || profile?.providers.includes(providerId));
  const resolved = profile && managed && (model.effortProfileRevision ?? 0) < EFFORT_PROFILE_REVISION
    ? applyModelEffortProfile(model, profile) : model;
  const { overrides, ...base } = resolved;
  const piModel = findPiModel(providerType ?? base.providerId ?? base.provider, base.name ?? base.model ?? '', base.protocol);
  const defaults = piModel === undefined ? undefined : {
    ...piModelRecord(piModel, base.providerId ?? base.provider ?? piModel.provider),
    baseUrl: base.baseUrl,
    protocol: base.protocol,
    provider: base.provider,
  };
  const effective: ModelRecord = { ...defaults, ...base, ...overrides };
  if (defaults !== undefined || base.thinking !== undefined || overrides?.thinking !== undefined) {
    effective.thinking = {
      ...defaults?.thinking,
      ...base.thinking,
      ...overrides?.thinking,
      efforts: overrides?.thinking?.efforts ?? overrides?.supportEfforts ?? base.thinking?.efforts ?? base.supportEfforts ?? defaults?.thinking.efforts,
      defaultEffort: overrides?.thinking?.defaultEffort ?? overrides?.defaultEffort ?? base.thinking?.defaultEffort ?? base.defaultEffort ?? defaults?.thinking.defaultEffort,
    };
    const controls = overrides?.thinking?.controls ?? base.thinking?.controls;
    if (controls !== undefined && !controls.includes('effort')) {
      effective.thinking.efforts = undefined;
      effective.thinking.providerEfforts = undefined;
      effective.thinking.defaultEffort = undefined;
      effective.supportEfforts = undefined;
      effective.defaultEffort = undefined;
    }
    if ((overrides?.capabilities ?? base.capabilities)?.includes('always_thinking') && overrides?.thinking?.availability === undefined && base.thinking?.availability === undefined) {
      effective.thinking.availability = 'always';
      effective.thinking.canDisable = false;
    }
  }
  if (effective.effortMapping && effective.thinking && effective.thinking.availability !== 'none') {
    effective.thinking.efforts = effective.thinking.efforts?.filter((level) => effective.effortMapping?.[level] !== null);
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

function normalizeModelThinking(model: ModelRecord, providerType?: string): ModelRecord {
  const normalizedCapabilities = (model.capabilities ?? []).map((value) => value.trim().toLowerCase()).map((value) => value === 'vision' ? 'image_in' : value);
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
  const capabilities = normalizedCapabilities.filter((value) => !['thinking', 'always_thinking'].includes(value));
  if (thinking.availability !== 'none') {
    const capability = thinking.availability === 'always' ? 'always_thinking' : 'thinking';
    capabilities.push(capability);
  }
  return {
    ...model,
    capabilities: model.capabilities === undefined && capabilities.length === 0 ? undefined : capabilities,
    thinking,
    supportEfforts: supportEfforts.length === 0 ? undefined : [...supportEfforts],
    defaultEffort: thinking.defaultEffort,
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

export interface ModelProtocolResolution {
  readonly protocol: Protocol;
  readonly source: InspectionSource;
}

export function resolveModelProtocol(
  model: ModelRecord,
  provider: ProviderConfig | undefined,
): ModelProtocolResolution | undefined {
  if (model.protocol !== undefined) {
    return { protocol: model.protocol, source: { kind: 'config', detail: 'model.protocol' } };
  }
  if (model.defaultProtocol !== undefined) {
    return { protocol: model.defaultProtocol, source: { kind: 'config', detail: 'model.defaultProtocol (catalog default)' } };
  }
  const relayProtocol = isRelayModel(model, provider) ? defaultRelayProtocol(model.name ?? model.model ?? '') : undefined;
  if (relayProtocol !== undefined) {
    return { protocol: relayProtocol, source: { kind: 'builtin', detail: 'relay model-family protocol default' } };
  }
  const providerType = provider?.type;
  if (providerType !== undefined) {
    const asProtocol = ProtocolSchema.safeParse(providerType);
    if (asProtocol.success) {
      return {
        protocol: asProtocol.data,
        source: {
          kind: 'config',
          detail: `provider type '${providerType}' is itself a wire protocol`,
        },
      };
    }
    const definition = getProviderDefinition(providerType);
    if (definition !== undefined) {
      return {
        protocol: definition.baseProtocol,
        source: { kind: 'builtin', detail: `vendor '${providerType}' declared baseProtocol` },
      };
    }
  }
  return undefined;
}

export interface EndpointBaseUrlResolution {
  readonly baseUrl: string | undefined;
  readonly source?: InspectionSource;
}

export function resolveEndpointBaseUrl(
  model: ModelRecord,
  provider: ProviderConfig,
  providerId: string,
): EndpointBaseUrlResolution {
  const fromModel = nonEmpty(model.baseUrl);
  if (fromModel !== undefined) {
    return { baseUrl: fromModel, source: { kind: 'config', detail: 'model.baseUrl' } };
  }
  const fromProvider = nonEmpty(provider.baseUrl);
  if (fromProvider !== undefined) {
    return {
      baseUrl: fromProvider,
      source: { kind: 'config', detail: `provider '${providerId}' baseUrl` },
    };
  }
  const endpointType = provider.type ?? model.protocol;
  const endpoint =
    endpointType === undefined ? {} : explainProviderEndpoint(endpointType, provider.env ?? {});
  const baseUrl = nonEmpty(endpoint.baseUrl);
  if (endpoint.baseUrlEnvName !== undefined) {
    return {
      baseUrl,
      source: {
        kind: 'env',
        detail: `${endpoint.baseUrlEnvName} (provider '${providerId}' env bag)`,
      },
    };
  }
  if (endpoint.baseUrlIsDefault === true) {
    return {
      baseUrl,
      source: { kind: 'builtin', detail: `provider definition '${endpointType}' defaultBaseUrl` },
    };
  }
  return { baseUrl };
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
    defaultProvider === undefined || defaultProvider.trim().length === 0 ? undefined : defaultProvider;
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

function authConflictError(kind: string, name: string): Error2 {
  return new Error2(
    CONFIG_INVALID_ERROR_CODE,
    `${kind} "${name}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`,
  );
}
