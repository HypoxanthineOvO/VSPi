import { describe, expect, it } from 'vitest';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { findPiModel, listPiProviders, piModelRecord, piThinking } from '#/kosong/provider/pi/catalog';
import { effectiveModelConfig } from '#/kosong/model/modelAuth';

describe('pi catalog boundary', () => {
  it('uses packaged capabilities and the exact same supported levels', () => {
    for (const provider of listPiProviders()) {
      for (const model of provider.models) {
        const thinking = piThinking(model);
        const levels = thinking.availability === 'none' ? ['off'] : [
          ...thinking.canDisable ? ['off'] : [], ...thinking.efforts ?? [],
        ];
        expect(levels).toEqual(getSupportedThinkingLevels(model));
      }
    }
  });

  it('resolves vision and thinking without a network or user capability declaration', () => {
    const known = findPiModel('openai', 'gpt-5');
    expect(known).toBeDefined();
    const effective = effectiveModelConfig({ provider: 'example', model: 'gpt-5' }, 'openai');
    expect(effective.capabilities).toContain('image_in');
    expect(effective.thinking).toEqual(piThinking(known!));
    expect(effective.baseUrl).toBeUndefined();
  });

  it('preserves explicit overrides including disabling vision and thinking', () => {
    const effective = effectiveModelConfig({
      model: 'gpt-5',
      overrides: { capabilities: [], thinking: { availability: 'none' } },
    }, 'openai');
    expect(effective.capabilities ?? []).not.toContain('image_in');
    expect(effective.thinking?.availability).toBe('none');
    expect(effective.capabilities ?? []).not.toContain('thinking');
    expect(effective.capabilities ?? []).not.toContain('always_thinking');
  });

  it('retains long-context pricing thresholds from the pinned source', () => {
    const model = findPiModel('openai', 'gpt-5.4')!;
    expect(model.cost.tiers?.length).toBeGreaterThan(0);
    expect(piModelRecord(model, 'example').pricing.contextTiers).toEqual(model.cost.tiers!.map((tier) => ({
      contextTokensAbove: tier.inputTokensAbove,
      inputUsdPerMillion: tier.input,
      outputUsdPerMillion: tier.output,
    })));
  });

  it('does not infer a fabricated model from a familiar name prefix', () => {
    expect(findPiModel('openai', 'gpt-5-example-unknown')).toBeUndefined();
  });

  it('honors explicit disabled effort mappings in the effective choices', () => {
    const result = effectiveModelConfig({ model: 'gpt-5.4', effortMapping: { xhigh: null, off: null } }, 'openai');
    expect(result.thinking?.efforts).not.toContain('xhigh');
    expect(result.thinking?.canDisable).toBe(false);
  });
});
