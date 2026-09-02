import { describe, expect, it } from 'vitest';

import {
  normalizeThinkingCapability,
  thinkingEffortsForProvider,
} from '#/kosong/contract/capability';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import {
  declaredDefaultEffortForModel,
  defaultThinkingEffortForModel,
  drivesThinkingThroughTraits,
  modelSupportsThinkingEffort,
  requiresStrictThinkingValidation,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  usesTraitDrivenThinking,
} from '#/kosong/model/thinking';

const registry = new ProtocolAdapterRegistry();

describe('normalizeThinkingCapability', () => {
  it('normalizes controls, provider efforts, and valid defaults', () => {
    const thinking = normalizeThinkingCapability({
      availability: 'dynamic',
      canDisable: true,
      controls: ['toggle', 'effort', 'effort'],
      efforts: [' low ', '', 'high', 'low'],
      providerEfforts: { anthropic: ['medium', ' high '], ' ': ['ignored'] },
      defaultEffort: 'high',
    });

    expect(thinking).toEqual({
      availability: 'dynamic',
      canDisable: true,
      controls: ['toggle', 'effort'],
      efforts: ['low', 'high'],
      providerEfforts: { anthropic: ['medium', 'high'] },
      defaultEffort: 'high',
    });
    expect(thinkingEffortsForProvider(thinking, 'anthropic')).toEqual(['medium', 'high']);
    expect(thinkingEffortsForProvider(thinking, 'openai')).toEqual(['low', 'high']);
  });

  it('normalizes conflicting availability, disable, and control declarations', () => {
    expect(
      normalizeThinkingCapability({
        availability: 'none',
        canDisable: true,
        controls: ['toggle', 'effort', 'budget'],
        efforts: ['low'],
        providerEfforts: { kimi: ['low'] },
        defaultEffort: 'low',
      }),
    ).toEqual({ availability: 'none', canDisable: false, controls: [] });
    expect(
      normalizeThinkingCapability({
        availability: 'always',
        canDisable: true,
        controls: ['toggle', 'effort'],
        efforts: ['low', 'high'],
        defaultEffort: 'max',
      }),
    ).toEqual({
      availability: 'always',
      canDisable: false,
      controls: ['effort'],
      efforts: ['low', 'high'],
      providerEfforts: undefined,
      defaultEffort: undefined,
    });
    expect(
      normalizeThinkingCapability({
        availability: 'dynamic',
        canDisable: false,
        controls: ['toggle', 'budget'],
      }),
    ).toEqual({
      availability: 'dynamic',
      canDisable: false,
      controls: ['budget'],
      efforts: undefined,
      providerEfforts: undefined,
      defaultEffort: undefined,
    });
  });

  it('requires defaults to be valid for fallback and every provider override', () => {
    expect(
      normalizeThinkingCapability({
        availability: 'dynamic',
        controls: ['effort'],
        efforts: ['low', 'high'],
        providerEfforts: { kimi: ['high', 'max'], anthropic: ['high'] },
        defaultEffort: 'high',
      }).defaultEffort,
    ).toBe('high');
    expect(
      normalizeThinkingCapability({
        availability: 'dynamic',
        controls: ['effort'],
        efforts: ['low', 'high'],
        providerEfforts: { kimi: ['medium', 'max'] },
        defaultEffort: 'high',
      }).defaultEffort,
    ).toBeUndefined();
  });

  it('keeps legacy thinking conservative without an explicit off signal', () => {
    expect(normalizeThinkingCapability(undefined, { thinking: true })).toEqual({
      availability: 'dynamic',
      canDisable: false,
      controls: [],
      efforts: undefined,
      providerEfforts: undefined,
      defaultEffort: undefined,
    });
    expect(normalizeThinkingCapability(undefined, { thinking: true, canDisable: true })).toEqual({
      availability: 'dynamic',
      canDisable: true,
      controls: ['toggle'],
      efforts: undefined,
      providerEfforts: undefined,
      defaultEffort: undefined,
    });
  });
});

describe('registry-driven vendor verdicts', () => {
  it('drivesThinkingThroughTraits: trait-driven vendors only, no string branches', () => {
    expect(drivesThinkingThroughTraits('kimi')).toBe(true);
    expect(drivesThinkingThroughTraits('openai')).toBe(false);
    expect(drivesThinkingThroughTraits('anthropic')).toBe(false);
    expect(drivesThinkingThroughTraits('never-registered')).toBe(false);
    expect(drivesThinkingThroughTraits(undefined)).toBe(false);
  });

  it('usesTraitDrivenThinking: native traits and the (kimi, anthropic) pair registration', () => {
    expect(usesTraitDrivenThinking(registry, 'openai', 'kimi')).toBe(true);
    expect(usesTraitDrivenThinking(registry, 'anthropic', 'kimi')).toBe(true);
    expect(usesTraitDrivenThinking(registry, 'openai', 'openai')).toBe(false);
    expect(usesTraitDrivenThinking(registry, 'openai', undefined)).toBe(false);
    expect(usesTraitDrivenThinking(registry, 'anthropic', 'anthropic')).toBe(false);
    expect(usesTraitDrivenThinking(registry, 'google-genai', 'kimi')).toBe(false);
  });

  it('requiresStrictThinkingValidation: only the strict-validation thinking driver', () => {
    expect(requiresStrictThinkingValidation(registry, 'openai', 'kimi')).toBe(true);
    expect(requiresStrictThinkingValidation(registry, 'anthropic', 'kimi')).toBe(false);
    expect(requiresStrictThinkingValidation(registry, 'openai', 'openai')).toBe(false);
    expect(requiresStrictThinkingValidation(registry, 'openai', undefined)).toBe(false);
    expect(requiresStrictThinkingValidation(registry, 'anthropic', 'anthropic')).toBe(false);
  });
});

describe('resolveThinkingEffortForModel', () => {
  const thinkingModel = {
    thinking: {
      availability: 'dynamic' as const,
      canDisable: true,
      controls: ['toggle' as const, 'effort' as const],
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    },
  };

  it('prefers the normalized request, then config, then the model default', () => {
    expect(resolveThinkingEffortForModel('HIGH', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { effort: 'low' }, thinkingModel, true)).toBe('low');
    expect(resolveThinkingEffortForModel(undefined, undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, thinkingModel, true)).toBe('off');
  });

  it('picks the middle effort when the model declares no default', () => {
    expect(
      defaultThinkingEffortForModel({ capabilities: ['thinking'], supportEfforts: ['low', 'medium', 'high'] }),
    ).toBe('medium');
    expect(defaultThinkingEffortForModel({ capabilities: ['thinking'] })).toBe('on');
    expect(defaultThinkingEffortForModel(undefined)).toBe('off');
  });

  it('normalizes unknown efforts back to the model default under kimi semantics', () => {
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, false)).toBe('extreme');
    expect(resolveThinkingEffortForModel('on', undefined, thinkingModel, true)).toBe('high');
  });

  it('keeps always-thinking models on under kimi semantics', () => {
    const always = {
      capabilities: ['always_thinking'],
      alwaysThinking: true,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'low',
    };
    expect(resolveThinkingEffortForModel('off', undefined, always, true)).toBe('low');
    expect(resolveThinkingEffortForModel('off', undefined, thinkingModel, true)).toBe('off');
  });

  it.each([
    ['none/off', 'off', { thinking: { availability: 'none', canDisable: false, controls: [] } }, true, true],
    ['none/on', 'on', { thinking: { availability: 'none', canDisable: false, controls: [] } }, true, false],
    ['always/off', 'off', { thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['low'] } }, true, false],
    ['always/effort', 'low', { thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['low'] } }, true, true],
    ['dynamic-disabled/off', 'off', { thinking: { availability: 'dynamic', canDisable: false, controls: ['effort'], efforts: ['low'] } }, true, false],
    ['dynamic-enabled/off', 'off', thinkingModel, true, true],
    ['strict-listed', 'high', thinkingModel, true, true],
    ['strict-unlisted', 'extreme', thinkingModel, true, false],
    ['non-strict-unlisted', 'extreme', thinkingModel, false, true],
  ] as const)(
    'modelSupportsThinkingEffort validates %s',
    (_name, effort, model, strict, expected) => {
      expect(
        modelSupportsThinkingEffort(
          effort,
          model as Parameters<typeof modelSupportsThinkingEffort>[1],
          strict,
        ),
      ).toBe(expected);
    },
  );

  it('declaredDefaultEffortForModel returns the declared default only when the model lists it', () => {
    expect(declaredDefaultEffortForModel(thinkingModel)).toBe('high');
    expect(
      declaredDefaultEffortForModel({
        capabilities: ['thinking'],
        supportEfforts: ['low', 'medium'],
        defaultEffort: 'high',
      }),
    ).toBeUndefined();
    expect(
      declaredDefaultEffortForModel({ capabilities: ['thinking'], supportEfforts: ['low'] }),
    ).toBeUndefined();
    expect(
      declaredDefaultEffortForModel({ supportEfforts: ['max'], defaultEffort: 'max' }),
    ).toBeUndefined();
    expect(declaredDefaultEffortForModel(undefined)).toBeUndefined();
  });
});

describe('resolveForcedThinkingEffort', () => {
  it('applies the forced effort only for trait-driven vendors with thinking on', () => {
    expect(resolveForcedThinkingEffort('low', 'high', true)).toBe('low');
    expect(resolveForcedThinkingEffort('low', 'off', true)).toBeUndefined();
    expect(resolveForcedThinkingEffort('low', 'high', false)).toBeUndefined();
    expect(resolveForcedThinkingEffort(undefined, 'high', true)).toBeUndefined();
  });
});

describe('resolveThinkingKeep', () => {
  it('never keeps when thinking is off', () => {
    expect(resolveThinkingKeep('all', 'all', 'off')).toBeUndefined();
  });

  it('honors explicit off-values as a specified disable', () => {
    expect(resolveThinkingKeep('off', undefined, 'on')).toBeUndefined();
    expect(resolveThinkingKeep('0', 'all', 'on')).toBeUndefined();
    expect(resolveThinkingKeep(undefined, 'none', 'on')).toBeUndefined();
  });

  it('env wins over config; the default is all', () => {
    expect(resolveThinkingKeep('summary', 'all', 'on')).toBe('summary');
    expect(resolveThinkingKeep(undefined, 'summary', 'on')).toBe('summary');
    expect(resolveThinkingKeep(undefined, undefined, 'on')).toBe('all');
  });
});
