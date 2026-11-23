import catalog from '../../../../../ops/vsplab/model-catalog.json' with { type: 'json' };
import { mergeRelayCatalog } from '#/app/kosongConfig/relayCatalog';
import { modelEffortProfile } from '#/llm-adapter/provider/effortProfiles';
import { findPiModel, listPiProviders, piModelOutputLimit, piModelRecord, piProtocolForApi, relayNativeProvider } from '#/llm-adapter/provider/pi/catalog';
import { normalizeIdentity, resolveCanonicalModel } from './canonical';
import { applyModelEffortProfile } from './effortProfiles';
import type { BuiltinModelMetadata, ModelMetadataLookupOptions } from './model-metadata-contract';
import type { ModelRecord } from './model';
import { defaultRelayProtocol } from './relayDefaults';

const relayModels = Object.values(mergeRelayCatalog({}, 'vsplab', { type: 'openai' }, catalog));
const nativeByCanonical = new Map<string, ReturnType<typeof listPiProviders>[number]['models']>();
for (const { models } of listPiProviders()) {
  for (const model of models) {
    const key = normalizeIdentity(model.id.split('/').at(-1) ?? model.id);
    const matches = nativeByCanonical.get(key);
    if (matches) matches.push(model);
    else nativeByCanonical.set(key, [model]);
  }
}

export function lookupBuiltinModelMetadata(
  modelId: string,
  options: ModelMetadataLookupOptions = {},
): BuiltinModelMetadata | undefined {
  const parts = modelId.trim().split('/');
  const id = parts.at(-1) ?? '';
  if (!id) return undefined;
  const providerType = options.providerType ?? (parts[0] === 'vsplab' ? 'vsplab' : undefined);
  const identity = normalizeIdentity(id);
  const preferredProvider = providerType ?? relayNativeProvider(id);
  const exact = findPiModel(preferredProvider, id, options.protocol, { allowFallback: false });
  const matches = nativeByCanonical.get(identity) ?? [];
  const piModel = exact ?? matches.find(model => model.provider === preferredProvider && piProtocolForApi(model.api) === options.protocol)
    ?? matches.find(model => model.provider === preferredProvider)
    ?? findPiModel(undefined, id, options.protocol)
    ?? matches.find(model => piProtocolForApi(model.api) === options.protocol)
    ?? matches[0];
  const relay = options.allowRelayFallback === false ? undefined : relayModels.find(model =>
    [model.model, ...model.aliases ?? []].some(alias => alias !== undefined && normalizeIdentity(alias) === identity),
  );
  const known: ModelRecord | undefined = piModel ? piModelRecord(piModel, piModel.provider) : relay;
  if (!known?.maxContextSize) return undefined;
  const profile = modelEffortProfile(id) ?? modelEffortProfile(known.model ?? '');
  const record = profile && piModel ? applyModelEffortProfile(known, profile) : known;
  const canonical = resolveCanonicalModel(id, record);
  const thinking = record.thinking ?? { availability: 'none', canDisable: false, controls: [] };
  const capabilities = new Set(record.capabilities);
  if (thinking.availability !== 'none') capabilities.add('thinking');
  const pricing = record.pricing;
  const hasPricing = pricing !== undefined && (pricing.inputUsdPerMillion > 0 || pricing.outputUsdPerMillion > 0);
  return {
    canonical,
    modelId: id,
    displayName: record.displayName ?? canonical.displayName,
    maxContextSize: known.maxContextSize,
    maxOutputSize: (piModel === undefined ? record.maxOutputSize : piModelOutputLimit(piModel, providerType)) ?? relay?.maxOutputSize,
    capabilities: [...capabilities],
    thinking: structuredClone(thinking),
    defaultProtocol: (providerType === 'vsplab' ? relay?.defaultProtocol : undefined) ?? defaultRelayProtocol(id) ?? record.defaultProtocol ?? record.protocol,
    pricing: hasPricing ? structuredClone(pricing) : undefined,
    pricingSource: hasPricing ? record.pricingSource : undefined,
    supportEfforts: thinking.efforts === undefined ? undefined : [...thinking.efforts],
    defaultEffort: thinking.defaultEffort,
    effortMapping: record.effortMapping === undefined ? undefined : { ...record.effortMapping },
    effortProfileRevision: record.effortProfileRevision,
    adaptiveThinking: piModel?.compat && 'forceAdaptiveThinking' in piModel.compat ? piModel.compat.forceAdaptiveThinking : record.adaptiveThinking,
    source: piModel ? 'pi-catalog' : 'vsplab-catalog',
  };
}
