import { lookupBuiltinModelMetadata } from '@vsp/vsp-runtime';
import { describe, expect, it } from 'vitest';
import { isOfficialRecommendedModel, RECOMMENDED_MODELS } from '../src/v1/domain/recommended-models.js';

describe('built-in model recommendations', () => {
  it('keeps each recommendation connected to a packaged canonical model', () => {
    for (const { ids, label } of RECOMMENDED_MODELS) {
      expect(ids.length, label).toBeGreaterThan(0);
      for (const id of ids) {
        const metadata = lookupBuiltinModelMetadata(id);
        expect(metadata, `${label}: ${id}`).toBeDefined();
        expect(metadata?.canonical.id, id).not.toMatch(/^unclassified\//u);
        expect(metadata?.maxContextSize, id).toBeGreaterThan(0);
        expect(isOfficialRecommendedModel(id), id).toBe(true);
      }
    }
  });

  it('recognizes reviewed relay spellings without replacing wire IDs', () => {
    expect(isOfficialRecommendedModel('relay/claude-opus-5.5-20261118')).toBe(true);
    expect(isOfficialRecommendedModel('relay/gemini-4-argon-medium')).toBe(true);
    expect(isOfficialRecommendedModel('relay/kimi-k3.1-pro')).toBe(true);
    expect(isOfficialRecommendedModel('relay/deepseek-v4.1-flash')).toBe(true);
    expect(isOfficialRecommendedModel('relay/gemini-4-experimental')).toBe(false);
  });
});
