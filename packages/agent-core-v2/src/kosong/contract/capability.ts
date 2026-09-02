export type ThinkingAvailability = 'none' | 'always' | 'dynamic';
export type ThinkingControl = 'toggle' | 'effort' | 'budget';

export interface ThinkingCapability {
  availability: ThinkingAvailability;
  canDisable: boolean;
  controls: ThinkingControl[];
  efforts?: string[];
  providerEfforts?: Record<string, string[]>;
  defaultEffort?: string;
}

export interface ThinkingCapabilityInput {
  availability?: ThinkingAvailability;
  canDisable?: boolean;
  controls?: ThinkingControl[];
  efforts?: string[];
  providerEfforts?: Record<string, string[]>;
  defaultEffort?: string;
}

export interface LegacyThinkingCapabilityInput {
  readonly thinking?: boolean;
  readonly alwaysThinking?: boolean;
  readonly adaptiveThinking?: boolean;
  readonly canDisable?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
  readonly max_input_tokens?: number;
  readonly dynamically_loaded_tools?: boolean;
}

const THINKING_CONTROLS = new Set<ThinkingControl>(['toggle', 'effort', 'budget']);

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalizeEfforts(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map(nonEmpty).filter((value): value is string => value !== undefined))];
  return normalized.length === 0 ? undefined : normalized;
}

export function thinkingEffortsForProvider(
  thinking: ThinkingCapability,
  providerType?: string,
): readonly string[] {
  const providerEfforts = providerType === undefined ? undefined : thinking.providerEfforts?.[providerType];
  return providerEfforts ?? thinking.efforts ?? [];
}

export function normalizeThinkingCapability(
  input: ThinkingCapabilityInput | undefined,
  legacy: LegacyThinkingCapabilityInput = {},
): ThinkingCapability {
  const availability =
    input?.availability ??
    (legacy.alwaysThinking === true
      ? 'always'
      : legacy.adaptiveThinking === true || legacy.thinking === true
        ? 'dynamic'
        : 'none');
  if (availability === 'none') return { availability, canDisable: false, controls: [] };

  const efforts = normalizeEfforts(input?.efforts ?? legacy.supportEfforts);
  const providerEffortsEntries = Object.entries(input?.providerEfforts ?? {}).flatMap(
    ([provider, values]) => {
      const key = nonEmpty(provider);
      const normalized = normalizeEfforts(values);
      return key === undefined || normalized === undefined ? [] : [[key, normalized] as const];
    },
  );
  const providerEfforts =
    providerEffortsEntries.length === 0 ? undefined : Object.fromEntries(providerEffortsEntries);
  const controls = [...new Set(input?.controls ?? [])].filter((control) =>
    THINKING_CONTROLS.has(control),
  );
  if ((efforts !== undefined || providerEfforts !== undefined) && !controls.includes('effort')) {
    controls.push('effort');
  }
  const canDisable =
    availability === 'dynamic' &&
    (input?.canDisable ??
      (input?.controls?.includes('toggle') === true || legacy.canDisable === true));
  const toggleIndex = controls.indexOf('toggle');
  if (canDisable && toggleIndex === -1) controls.push('toggle');
  if (!canDisable && toggleIndex !== -1) controls.splice(toggleIndex, 1);

  const declaredDefault = nonEmpty(input?.defaultEffort ?? legacy.defaultEffort);
  const effortSets = [
    ...(efforts === undefined ? [] : [efforts]),
    ...providerEffortsEntries.map(([, values]) => values),
  ];
  const defaultEffort =
    declaredDefault !== undefined &&
    effortSets.length > 0 &&
    effortSets.every((values) => values.includes(declaredDefault))
      ? declaredDefault
      : undefined;
  return {
    availability,
    canDisable,
    controls,
    efforts: efforts === undefined ? undefined : [...efforts],
    providerEfforts:
      providerEfforts === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(providerEfforts).map(([provider, values]) => [provider, [...values]]),
          ),
    defaultEffort,
  };
}

export const NO_THINKING_CAPABILITY: ThinkingCapability = {
  availability: 'none',
  canDisable: false,
  controls: [],
};

const UNKNOWN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY');

export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze(
  Object.defineProperty(
    {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: false,
      max_context_tokens: 0,
      dynamically_loaded_tools: false,
    },
    UNKNOWN_CAPABILITY_MARKER,
    { value: true },
  ),
);

export function isUnknownCapability(capability: ModelCapability): boolean {
  if (capability === UNKNOWN_CAPABILITY) return true;
  const marked =
    (capability as unknown as Record<PropertyKey, unknown>)[UNKNOWN_CAPABILITY_MARKER] === true;
  if (marked) return true;
  return (
    !capability.image_in &&
    !capability.video_in &&
    !capability.audio_in &&
    !capability.thinking &&
    !capability.tool_use &&
    capability.dynamically_loaded_tools !== true &&
    capability.max_context_tokens === 0
  );
}
