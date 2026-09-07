import { describe, expect, it } from 'vitest';

import { stripCatalog } from '../../scripts/update-catalog.mjs';

describe('update-catalog', () => {
  it('preserves reasoning options and model provider metadata', () => {
    const reasoningOptions = [
      { type: 'toggle' },
      { type: 'effort', values: [null, 'off', 'low', 'high'] },
      { type: 'budget_tokens', min: 1024, max: 32768 },
      { type: 'future_control', values: ['opaque'] },
    ];
    const provider = {
      npm: '@ai-sdk/anthropic',
      api: 'https://gateway.example.test/anthropic/v1',
    };
    const cost = { input: 1, output: 2, cache_read: 0.1 };

    expect(
      stripCatalog({
        gateway: {
          id: 'gateway',
          name: 'Gateway',
          npm: '@ai-sdk/openai-compatible',
          models: {
            model: {
              id: 'model',
              limit: { context: 1000 },
              reasoning: true,
              reasoning_options: reasoningOptions,
              provider,
              cost,
              stripped_model_field: true,
            },
          },
          stripped_provider_field: true,
        },
      }),
    ).toEqual({
      gateway: {
        id: 'gateway',
        name: 'Gateway',
        npm: '@ai-sdk/openai-compatible',
        models: {
          model: {
            id: 'model',
            limit: { context: 1000 },
            reasoning: true,
            reasoning_options: reasoningOptions,
            provider,
            cost,
          },
        },
      },
    });
  });
});
