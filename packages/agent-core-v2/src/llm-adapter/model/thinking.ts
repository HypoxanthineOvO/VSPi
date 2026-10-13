import {
  normalizeThinkingCapability,
  thinkingEffortsForProvider,
  type ModelCapability,
  type ThinkingCapability,
} from '#/llm-adapter/contract/capability';
import type { ThinkingEffort } from '#human/llm/thinking';

import type { IProtocolAdapterRegistry, Protocol } from '../protocol/protocol';
import { getProviderDefinitions } from '../provider/provider-definition';

import type { ModelThinkingMetadata, ThinkingDefaults } from './model.types';

export interface ThinkingConfig {
  enabled?: boolean;
  effort?: string;
  forcedEffort?: string;
  keep?: string;
  modelEfforts?: Record<string, string>;
}

export { resolveThinkingKeep } from '#human/llm/thinking';

export function drivesThinkingThroughTraits(providerType: string | undefined): boolean {
  if (providerType === undefined) return false;
  return getProviderDefinitions(providerType).some(
    (definition) => definition.trait?.thinking !== undefined,
  );
}

export function usesTraitDrivenThinking(
  registry: IProtocolAdapterRegistry,
  protocol: Protocol,
  providerType?: string,
): boolean {
  return (
    registry.resolveAdapterIdentity(protocol, providerType).trait?.thinking !== undefined
  );
}

export function requiresStrictThinkingValidation(
  registry: IProtocolAdapterRegistry,
  protocol: Protocol,
  providerType?: string,
): boolean {
  if (providerType === undefined) return false;
  const trait = registry.resolveAdapterIdentity(protocol, providerType).trait;
  if (trait === undefined || trait.thinking === undefined) return false;
  return 'strictThinkingValidation' in trait && trait.strictThinkingValidation === true;
}

export function wireHasProtocolThinkingDisable(protocol: string | undefined): boolean {
  return protocol === 'anthropic' || protocol === 'kimi';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeRequestedThinkingEffort(
  requested: string | undefined,
): ThinkingEffort | undefined {
  return nonEmpty(requested)?.toLowerCase() as ThinkingEffort | undefined;
}

export function resolveForcedThinkingEffort(
  forced: string | undefined,
  effective: ThinkingEffort,
  traitDriven: boolean,
): ThinkingEffort | undefined {
  if (!traitDriven || effective === 'off') return undefined;
  return nonEmpty(forced)?.toLowerCase() as ThinkingEffort | undefined;
}

function middleOf(values: readonly string[]): string {
  return values[Math.floor(values.length / 2)]!;
}

function normalizedThinking(
  model: ModelThinkingMetadata | undefined,
): ThinkingCapability | undefined {
  if (model === undefined) return undefined;
  if (model.thinking !== undefined) return model.thinking;
  const capabilities = model.capabilities;
  const declared = Array.isArray(capabilities)
    ? new Set(capabilities.map((value) => value.trim().toLowerCase()))
    : undefined;
  return normalizeThinkingCapability(undefined, {
    thinking:
      declared?.has('thinking') === true ||
      (!Array.isArray(capabilities) &&
        (capabilities as ModelCapability | undefined)?.thinking === true),
    alwaysThinking: model.alwaysThinking === true || declared?.has('always_thinking') === true,
    adaptiveThinking: model.adaptiveThinking,
    supportEfforts: model.supportEfforts,
    defaultEffort: model.defaultEffort,
  });
}

function effortsFor(model: ModelThinkingMetadata | undefined): readonly string[] {
  const thinking = normalizedThinking(model);
  return thinking === undefined ? [] : thinkingEffortsForProvider(thinking, model?.providerType);
}

export function modelSupportsThinking(model: ModelThinkingMetadata | undefined): boolean {
  const thinking = normalizedThinking(model);
  return thinking !== undefined && thinking.availability !== 'none';
}

export function defaultThinkingEffortForModel(
  model: ModelThinkingMetadata | undefined,
): ThinkingEffort {
  if (model === undefined || !modelSupportsThinking(model)) return 'off';
  const efforts = effortsFor(model);
  if (efforts.length > 0) {
    const declaredDefault = nonEmpty(normalizedThinking(model)?.defaultEffort);
    return (declaredDefault !== undefined && efforts.includes(declaredDefault)
      ? declaredDefault
      : middleOf(efforts)) as ThinkingEffort;
  }
  return 'on';
}

export function declaredDefaultEffortForModel(
  model: ModelThinkingMetadata | undefined,
): ThinkingEffort | undefined {
  if (!modelSupportsThinking(model)) return undefined;
  const declared = nonEmpty(normalizedThinking(model)?.defaultEffort);
  if (declared === undefined) return undefined;
  return effortsFor(model).includes(declared) ? (declared as ThinkingEffort) : undefined;
}

export function modelSupportsThinkingEffort(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  strictValidation: boolean,
): boolean {
  const thinking = normalizedThinking(model);
  if (thinking === undefined || thinking.availability === 'none') return effort === 'off';
  if (effort === 'off') return thinking.availability === 'dynamic' && thinking.canDisable;
  if (!strictValidation) return true;
  const efforts = effortsFor(model);
  return efforts.length === 0 || effort === 'on' || efforts.includes(effort);
}

function normalizeThinkingEffortForModel(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  strictValidation: boolean,
): ThinkingEffort {
  const thinking = normalizedThinking(model);
  if (
    effort === 'off' &&
    (thinking === undefined ||
      thinking.availability === 'none' ||
      (thinking.availability === 'dynamic' && thinking.canDisable))
  ) {
    return 'off';
  }
  if (effort === 'off') return defaultThinkingEffortForModel(model);
  const efforts = effortsFor(model);
  if (!strictValidation) {
    return effort === 'on' && efforts.length > 0
      ? defaultThinkingEffortForModel(model)
      : effort;
  }
  if (!modelSupportsThinking(model)) return 'off';
  if (efforts.length === 0) return 'on';
  if (effort === 'on' || !efforts.includes(effort)) {
    return defaultThinkingEffortForModel(model);
  }
  return effort;
}

export function resolveThinkingEffortForModel(
  requested: string | undefined,
  defaults: ThinkingDefaults | undefined,
  model: ModelThinkingMetadata | undefined,
  strictValidation = false,
): ThinkingEffort {
  const configured = normalizeRequestedThinkingEffort(defaults?.effort);
  const normalized = normalizeRequestedThinkingEffort(requested);
  let effort: ThinkingEffort;
  if (normalized !== undefined) {
    effort = normalized;
  } else if (defaults?.enabled === false) {
    effort = 'off';
  } else {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }

  if (effort === 'off' && normalizedThinking(model)?.availability === 'always') {
    effort =
      configured !== undefined && configured !== 'off'
        ? configured
        : defaultThinkingEffortForModel(model);
  }
  return normalizeThinkingEffortForModel(effort, model, strictValidation);
}
