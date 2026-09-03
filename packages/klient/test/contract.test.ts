/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises the session-creation and plugin-manifest schemas directly with no
 * external collaborators. Run with `pnpm --filter @moonshot-ai/klient exec
 * vitest run test/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { pluginManifestSchema } from '../src/contract/global/plugins.js';
import { mcpServerAuthFlowHandleSchema } from '../src/contract/global/mcpManagement.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';
import { goalToolResultSchema, promptPayloadSchema } from '../src/contract/agent/schemas.js';
import { goalUpdatedEventSchema } from '../src/contract/agent/events.js';

type McpTimeoutField = 'startupTimeoutMs' | 'toolTimeoutMs';

const timeoutCases = [
  {
    surface: 'plugin manifests',
    parse: (field: McpTimeoutField, value: number) =>
      pluginManifestSchema.safeParse({
        name: 'example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
].flatMap(({ surface, parse }) => [
  { surface, field: 'startupTimeoutMs' as const, parse },
  { surface, field: 'toolTimeoutMs' as const, parse },
]);

describe('MCP timeout contract validation', () => {
  it.each(timeoutCases)('accepts the maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_647).success).toBe(true);
  });

  it.each(timeoutCases)('rejects an above-maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_648).success).toBe(false);
  });

  it('session creation options accept ephemeral mcpServers', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        stdioExample: { transport: 'stdio', command: 'node', args: ['server.mjs'] },
        httpExample: { transport: 'http', url: 'https://example.com/mcp', headers: { a: 'b' } },
        sseExample: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpServers?.['stdioExample']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
  });

  it('session creation options reject malformed mcpServers entries', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        example: { transport: 'http', url: 'not-a-url' },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('completeAuth timeoutMs accepts the setTimeout maximum and rejects above it', () => {
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_647 })
        .success,
    ).toBe(true);
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_648 })
        .success,
    ).toBe(false);
  });
});

describe('prompt contract validation', () => {
  it('rejects an empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: '' }).success).toBe(false);
  });

  it('accepts a non-empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: 'submission-1' }).success).toBe(true);
  });
});

const goal = {
  goalId: 'goal-1',
  objective: 'Ship the feature',
  status: 'active',
  turnsUsed: 1,
  tokensUsed: 100,
  wallClockMs: 1_000,
  budget: {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

describe('goal contract validation', () => {
  it('accepts the complete Goal read result and observable event', () => {
    expect(goalToolResultSchema.safeParse({ goal }).success).toBe(true);
    expect(
      goalUpdatedEventSchema.safeParse({
        type: 'goal.updated',
        time: 1,
        agentId: 'main',
        snapshot: goal,
        change: { kind: 'lifecycle', status: 'active', actor: 'user' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown Goal fields and invalid statuses', () => {
    expect(goalToolResultSchema.safeParse({ goal: { ...goal, extra: true } }).success).toBe(false);
    expect(
      goalUpdatedEventSchema.safeParse({
        type: 'goal.updated',
        agentId: 'main',
        snapshot: { ...goal, status: 'running' },
      }).success,
    ).toBe(false);
  });
});
