import { describe, expect, it } from 'vitest';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { findPiModel, listPiProviders, piModelRecord, piThinking } from '#/llm-adapter/provider/pi/catalog';
import { effectiveModelConfig } from '#/llm-adapter/model/model-auth';
import { lookupBuiltinModelMetadata } from '#/llm-adapter/model/metadata-lookup';
import { MODEL_EFFORT_PROFILES, modelEffortProfile } from '#/llm-adapter/provider/effortProfiles';

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

  it.each([
    ['gpt-6.2-sol', 500000], ['gpt-6.2-astra', 272000], ['gpt-6.1-terra', 500000], ['gpt-6.1-sol', 500000],
  ] as const)('uses the Codex template and context for %s', (id, contextWindow) => {
    const model = findPiModel('openai-codex', id, 'openai_responses', { allowFallback: false });
    expect(model).toMatchObject({ id, api: 'openai-codex-responses', provider: 'openai-codex', contextWindow, maxTokens: 128000 });
    expect(findPiModel('openai-codex', 'gpt-6.1-fabricated', 'openai_responses')).toBeUndefined();
    expect(findPiModel('vsplab', id, 'openai_responses')).toMatchObject({ id, api: 'openai-responses', provider: 'openai', contextWindow: id === 'gpt-6.1-sol' ? 272000 : 1050000 });
  });

  it.each([
    ['openai/gpt-6.2-sol', 'openai/gpt-6.2-sol', 'openai_responses', 1050000, 128000],
    ['claude-opus-5.5-20261118', 'anthropic/claude-opus-5.5', 'anthropic', 1000000, 128000],
    ['anthropic/claude-fable-5-2-high', 'anthropic/claude-fable-5.2', 'anthropic', 1000000, 128000],
    ['gemini-4-argon-medium', 'google/gemini-4-argon', 'google-genai', 1048576, 32768],
    ['gemini-4-neon-high', 'google/gemini-4-neon', 'google-genai', 1048576, 65536],
    ['glm-5.3', 'zhipu/glm-5.3', 'openai', 1000000, 131072],
    ['deepseek-flash', 'deepseek/deepseek-v4.1-flash', 'openai', 1000000, 384000],
    ['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', 'openai', 1000000, 384000],
    ['k3.1-pro', 'moonshot/kimi-k3.1-pro', 'openai', 1048576, 1048576],
    ['kimi-k3.1-pro', 'moonshot/kimi-k3.1-pro', 'openai', 1048576, 1048576],
    ['k3-256k', 'moonshot/kimi-k3-256k', 'openai', 262144, 131072],
    ['doubao-seed-2.1-pro', 'bytedance/doubao-seed-2.1-pro', 'openai', 1024000, 256000],
  ] as const)('inherits known metadata for %s without changing wire identity', (id, canonical, defaultProtocol, maxContextSize, maxOutputSize) => {
    expect(lookupBuiltinModelMetadata(id, { protocol: 'openai' })).toMatchObject({ canonical: { id: canonical }, defaultProtocol, maxContextSize, maxOutputSize, capabilities: expect.arrayContaining(['tool_use', 'thinking']) });
  });

  it('returns no fabricated metadata and resolves provider-specific context', () => {
    expect(lookupBuiltinModelMetadata('openai/gpt-6.3-private')).toBeUndefined();
    expect(lookupBuiltinModelMetadata('gpt-6.2-sol', { providerType: 'openai-codex' })).toMatchObject({ maxContextSize: 500000 });
    expect(lookupBuiltinModelMetadata('codex-auto-review', { providerType: 'openai-codex' })).toMatchObject({ maxContextSize: 272000, source: 'pi-catalog' });
    expect(listPiProviders().find(provider => provider.id === 'openai-codex')?.models.some(model => model.id === 'codex-auto-review')).toBe(false);
    expect(lookupBuiltinModelMetadata('codex-auto-review')).toMatchObject({ source: 'vsplab-catalog' });
    expect(lookupBuiltinModelMetadata('codex-auto-review', { allowRelayFallback: false })).toBeUndefined();
  });

  it('ties each local effort profile to a packaged model and a selectable default', () => {
    for (const profile of MODEL_EFFORT_PROFILES) {
      expect(profile.ids.some(id => lookupBuiltinModelMetadata(id) !== undefined), profile.ids.join(', ')).toBe(true);
      for (const id of profile.ids) expect(modelEffortProfile(id), id).toBe(profile);
      if (profile.mode === 'effort') expect(profile.efforts).toContain(profile.defaultEffort);
    }
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
