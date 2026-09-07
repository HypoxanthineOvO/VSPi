import {
  normalizeThinkingCapability,
  thinkingEffortsForProvider,
  type ThinkingCapabilityInput,
  type ThinkingControl,
} from '@moonshot-ai/agent-core-v2/kosong/contract/capability';

export type ThinkingEffortRepairReason =
  | 'target-preserved'
  | 'missing-default-model'
  | 'missing-capability'
  | 'invalid-capability'
  | 'thinking-unavailable'
  | 'off-supported'
  | 'effort-supported'
  | 'default-effort'
  | 'middle-effort'
  | 'thinking-on';

export interface ThinkingEffortRepairAction {
  readonly status: 'applied' | 'preserved';
  readonly reason: ThinkingEffortRepairReason;
  readonly before: string;
  readonly after: string;
}

export interface ThinkingEffortRepairResult {
  readonly effort: string;
  readonly action: ThinkingEffortRepairAction;
  readonly diagnostic?: string;
}

export function preserveThinkingEffort(effort: string): ThinkingEffortRepairAction {
  return { status: 'preserved', reason: 'target-preserved', before: effort, after: effort };
}

export function repairThinkingEffort(
  effort: string,
  defaultModel: unknown,
  modelsValue: unknown,
  providersValue: unknown,
): ThinkingEffortRepairResult {
  const models = record(modelsValue);
  const model = models === undefined || typeof defaultModel !== 'string'
    ? undefined
    : record(models[defaultModel]);
  if (model === undefined) {
    return conservative(effort, 'missing-default-model', 'thinking effort repaired to off because the default model is unavailable');
  }
  const rawThinking = record(model['thinking']);
  if (rawThinking === undefined) {
    return conservative(effort, 'missing-capability', 'thinking effort repaired to off because the default model has no structured thinking capability');
  }
  const input = thinkingInput(rawThinking);
  if (input === undefined) {
    return conservative(effort, 'invalid-capability', 'thinking effort repaired to off because the default model thinking capability is invalid');
  }
  const thinking = normalizeThinkingCapability(input);
  if (thinking.availability === 'none') {
    return applied(effort, 'off', 'thinking-unavailable');
  }
  const providerType = resolveProviderType(model, providersValue);
  const efforts = thinkingEffortsForProvider(thinking, providerType);
  if (effort === 'off' && thinking.availability === 'dynamic' && thinking.canDisable) {
    return applied(effort, effort, 'off-supported');
  }
  if (effort !== 'off' && efforts.includes(effort)) {
    return applied(effort, effort, 'effort-supported');
  }
  if (thinking.defaultEffort !== undefined && efforts.includes(thinking.defaultEffort)) {
    return applied(effort, thinking.defaultEffort, 'default-effort');
  }
  if (efforts.length > 0) {
    return applied(effort, efforts[Math.floor(efforts.length / 2)] as string, 'middle-effort');
  }
  return applied(effort, 'on', 'thinking-on');
}

function thinkingInput(value: Record<string, unknown>): ThinkingCapabilityInput | undefined {
  const availability = value['availability'];
  if (availability !== 'none' && availability !== 'always' && availability !== 'dynamic') return undefined;
  const canDisable = optionalBoolean(value['can_disable']);
  const controls = optionalControls(value['controls']);
  const efforts = optionalStrings(value['efforts']);
  const providerEfforts = optionalProviderEfforts(value['provider_efforts']);
  const defaultEffort = optionalString(value['default_effort']);
  if (
    canDisable === null || controls === null || efforts === null || providerEfforts === null ||
    defaultEffort === null
  ) return undefined;
  return {
    availability,
    canDisable: canDisable ?? undefined,
    controls: controls ?? undefined,
    efforts: efforts ?? undefined,
    providerEfforts: providerEfforts ?? undefined,
    defaultEffort: defaultEffort ?? undefined,
  };
}

function resolveProviderType(model: Record<string, unknown>, providersValue: unknown): string | undefined {
  const providerId = nonEmptyString(model['provider']) ?? nonEmptyString(model['provider_id']);
  const providers = record(providersValue);
  const provider = providerId === undefined || providers === undefined ? undefined : record(providers[providerId]);
  return nonEmptyString(provider?.['type']);
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  return value === undefined ? undefined : typeof value === 'boolean' ? value : null;
}

function optionalControls(value: unknown): ThinkingControl[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const controls = value.filter((entry): entry is ThinkingControl =>
    entry === 'toggle' || entry === 'effort' || entry === 'budget');
  return controls.length === value.length ? controls : null;
}

function optionalStrings(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : null;
}

function optionalProviderEfforts(value: unknown): Record<string, string[]> | undefined | null {
  if (value === undefined) return undefined;
  const providers = record(value);
  if (providers === undefined) return null;
  const entries: [string, string[]][] = [];
  for (const [provider, efforts] of Object.entries(providers)) {
    const parsed = optionalStrings(efforts);
    if (parsed === null || parsed === undefined) return null;
    entries.push([provider, parsed]);
  }
  return Object.fromEntries(entries);
}

function optionalString(value: unknown): string | undefined | null {
  return value === undefined ? undefined : typeof value === 'string' ? value : null;
}

function conservative(
  effort: string,
  reason: 'missing-default-model' | 'missing-capability' | 'invalid-capability',
  diagnostic: string,
): ThinkingEffortRepairResult {
  return { effort: 'off', action: { status: 'applied', reason, before: effort, after: 'off' }, diagnostic };
}

function applied(
  before: string,
  after: string,
  reason: Exclude<ThinkingEffortRepairReason, 'target-preserved' | 'missing-default-model' | 'missing-capability' | 'invalid-capability'>,
): ThinkingEffortRepairResult {
  return { effort: after, action: { status: 'applied', reason, before, after } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
