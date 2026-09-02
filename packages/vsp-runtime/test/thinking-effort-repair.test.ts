import { describe, expect, it } from 'vitest';

import { repairThinkingEffort } from '../src/thinking-effort-repair.js';

const modelId = 'relay/model';

function repair(
  effort: string,
  thinking: Record<string, unknown> | undefined,
  providerType = 'openai',
) {
  return repairThinkingEffort(
    effort,
    modelId,
    { [modelId]: { provider: 'relay', thinking } },
    { relay: { type: providerType } },
  );
}

describe('thinking effort repair', () => {
  it.each([
    ['none ignores off', 'off', { availability: 'none' }, 'off', 'thinking-unavailable'],
    ['none rejects listed effort', 'high', { availability: 'none', efforts: ['high'] }, 'off', 'thinking-unavailable'],
    ['always preserves listed effort', 'high', { availability: 'always', efforts: ['low', 'high'] }, 'high', 'effort-supported'],
    ['always rejects off to default', 'off', { availability: 'always', efforts: ['low', 'high'], default_effort: 'high' }, 'high', 'default-effort'],
    ['always rejects unknown to middle', 'turbo', { availability: 'always', efforts: ['low', 'medium', 'high'] }, 'medium', 'middle-effort'],
    ['always falls back to on', 'off', { availability: 'always' }, 'on', 'thinking-on'],
    ['dynamic disable preserves off', 'off', { availability: 'dynamic', can_disable: true, efforts: ['low', 'high'] }, 'off', 'off-supported'],
    ['dynamic disable preserves listed effort', 'low', { availability: 'dynamic', can_disable: true, efforts: ['low', 'high'] }, 'low', 'effort-supported'],
    ['dynamic disable repairs unknown', 'turbo', { availability: 'dynamic', can_disable: true, efforts: ['low', 'high'] }, 'high', 'middle-effort'],
    ['dynamic fixed rejects off', 'off', { availability: 'dynamic', can_disable: false, efforts: ['low', 'high'] }, 'high', 'middle-effort'],
  ] as const)('%s', (_name, effort, thinking, expected, reason) => {
    expect(repair(effort, thinking)).toMatchObject({
      effort: expected,
      action: { before: effort, after: expected, reason },
    });
  });

  it('uses the floor middle effort for even lists', () => {
    expect(repair('invalid', { availability: 'always', efforts: ['low', 'medium', 'high', 'max'] })).toMatchObject({
      effort: 'high',
      action: { reason: 'middle-effort' },
    });
  });

  it('uses provider-specific efforts and preserves unknown provider strings', () => {
    const thinking = {
      availability: 'dynamic',
      can_disable: true,
      efforts: ['low', 'high'],
      provider_efforts: { kimi: ['careful', 'maximum'], anthropic: ['small', 'large'] },
    };
    expect(repair('maximum', thinking, 'kimi')).toMatchObject({
      effort: 'maximum',
      action: { reason: 'effort-supported' },
    });
    expect(repair('low', thinking, 'kimi')).toMatchObject({
      effort: 'maximum',
      action: { reason: 'middle-effort' },
    });
    expect(repair('high', thinking, 'openai')).toMatchObject({
      effort: 'high',
      action: { reason: 'effort-supported' },
    });
  });

  it.each([
    ['missing', undefined, 'missing-capability'],
    ['malformed availability', { availability: 'sometimes' }, 'invalid-capability'],
    ['malformed efforts', { availability: 'always', efforts: 'high' }, 'invalid-capability'],
    ['malformed provider efforts', { availability: 'always', provider_efforts: { kimi: 'high' } }, 'invalid-capability'],
  ] as const)('uses conservative off for %s capability', (_name, thinking, reason) => {
    expect(repair('high', thinking)).toMatchObject({
      effort: 'off',
      action: { reason, after: 'off' },
      diagnostic: expect.stringContaining('off'),
    });
  });

  it('uses conservative off when the repaired default model is unavailable', () => {
    expect(repairThinkingEffort('high', 'missing/model', {}, {})).toMatchObject({
      effort: 'off',
      action: { reason: 'missing-default-model', after: 'off' },
    });
  });
});
