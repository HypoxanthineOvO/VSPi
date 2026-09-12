import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APIProviderRateLimitError,
  APIProviderQuotaExhaustedError,
  APIStatusError,
  ChatProviderError,
} from '#/kosong/contract/errors';
import { emptyUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';

import { createTestAgent, llmGenerateServices, type TestAgentContext } from '../../harness';

const realSetTimeout = globalThis.setTimeout;

describe('stepRetry plugin', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  function rpcEvents(name: string) {
    return ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === name);
  }

  function wireLoopEvents(eventType: string): Array<Record<string, unknown>> {
    return ctx.allEvents
      .filter(
        (entry) =>
          entry.type === '[wire]' &&
          entry.event === 'context.append_loop_event' &&
          (entry.args as { event?: { type?: string } }).event?.type === eventType,
      )
      .map((entry) => (entry.args as { event: Record<string, unknown> }).event);
  }

  async function runTurn(turnId: number, signal?: AbortSignal) {
    void ctx.dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const resultPromise = loop.run({ turnId, signal });
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 100; i += 1) {
      if (settled) break;
      await vi.runAllTimersAsync();
      if (!settled) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    }
    return resultPromise;
  }

  async function runBoundedTurn(signal?: AbortSignal) {
    await ctx.dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    return loop.run({ turnId: 1, signal });
  }

  it('stops after three transient failures when finite recovery is configured despite the legacy infinite switch', async () => {
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 120_000, retryInitialDelayMs: 0 } } },
      llmGenerateServices(async () => { calls++; throw new APIStatusError(503, 'temporarily unavailable'); }),
    );
    expect((await runBoundedTurn()).type).toBe('failed');
    expect(calls).toBe(3);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 422])('does not retry HTTP %s when finite transient-only recovery is configured', async (status) => {
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 120_000, retryInitialDelayMs: 0 } } },
      llmGenerateServices(async () => { calls++; throw new APIStatusError(status, 'permanent failure'); }),
    );
    expect((await runBoundedTurn()).type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('does not retry an unclassified provider configuration error under finite recovery', async () => {
    let calls = 0;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 120_000 } } },
      llmGenerateServices(async () => { calls++; throw new ChatProviderError('Unsupported model configuration'); }),
    );
    expect((await runBoundedTurn()).type).toBe('failed');
    expect(calls).toBe(1);
  });

  it('does not retry exhausted provider quota under finite recovery', async () => {
    let calls = 0;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 120_000 } } },
      llmGenerateServices(async () => { calls++; throw new APIProviderQuotaExhaustedError('quota exhausted'); }),
    );
    expect((await runBoundedTurn()).type).toBe('failed');
    expect(calls).toBe(1);
  });

  it('ends an unresponsive retry when the recovery budget expires', async () => {
    let calls = 0;
    let retrySignal: AbortSignal | undefined;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 30, retryInitialDelayMs: 0 } } },
      llmGenerateServices(async (_provider, _system, _tools, _history, _callbacks, options) => {
        if (++calls === 1) throw new APIConnectionError('disconnected');
        retrySignal = options?.signal;
        return new Promise<never>(() => {});
      }),
    );
    const result = await runBoundedTurn();
    expect(result).toMatchObject({ type: 'failed', error: { code: 'loop.retry_budget_exceeded' } });
    expect(calls).toBe(2);
    expect(retrySignal?.aborted).toBe(true);
  });

  it('does not cut off a retry that resumes protocol content and completes after its original recovery window', async () => {
    let calls = 0;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 30, retryInitialDelayMs: 0 } } },
      llmGenerateServices(async (_provider, _system, _tools, _history, callbacks, options) => {
        if (++calls === 1) throw new APIConnectionError('disconnected');
        options?.onProtocolProgress?.('body');
        await callbacks?.onMessagePart?.({ type: 'think', think: 'protocol progress' });
        await sleepForRetry(50, options?.signal);
        await callbacks?.onMessagePart?.({ type: 'text', text: 'recovered' });
        return { id: 'recovered', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }),
    );
    expect(await runBoundedTurn()).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toBe(2);
  });

  it('does not start another retry if a recovered stream fails after the original recovery window', async () => {
    let calls = 0;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 30, retryInitialDelayMs: 0 } } },
      llmGenerateServices(async (_provider, _system, _tools, _history, callbacks, options) => {
        if (++calls === 1) throw new APIConnectionError('disconnected');
        options?.onProtocolProgress?.('body');
        await callbacks?.onMessagePart?.({ type: 'think', think: 'protocol progress' });
        await sleepForRetry(50, options?.signal);
        throw new APIConnectionError('disconnected again');
      }),
    );
    expect(await runBoundedTurn()).toMatchObject({ type: 'failed', error: { code: 'loop.retry_budget_exceeded' } });
    expect(calls).toBe(2);
  });

  it('ends recovery without retrying early when Retry-After exceeds the remaining budget', async () => {
    let calls = 0;
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 100 } } },
      llmGenerateServices(async () => { calls++; throw new APIProviderRateLimitError('slow down', null, 1_800_000); }),
    );
    const result = await runBoundedTurn();
    expect(result).toMatchObject({ type: 'failed', error: { code: 'loop.retry_budget_exceeded' } });
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('does not dispatch another request when the user cancels a retry notice', async () => {
    let calls = 0;
    const controller = new AbortController();
    ctx = createTestAgent(
      { initialConfig: { loopControl: { maxAttemptsPerStep: 3, retryBudgetMs: 120_000, retryInitialDelayMs: 10_000 } } },
      llmGenerateServices(async () => { calls++; throw new APIConnectionError('disconnected'); }),
    );
    const listener = ctx.get(IEventBus).subscribe(TurnStepRetrying, () => { controller.abort(); });
    try {
      expect((await runBoundedTurn(controller.signal)).type).toBe('cancelled');
      expect(calls).toBe(1);
    } finally { listener.dispose(); }
  });

  it('retries a retryable provider error and resumes the same step number', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return {
          id: 'retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          turnId: 1,
          step: 1,
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 10,
          delayMs: expect.any(Number),
          errorName: 'APIConnectionError',
          errorMessage: 'terminated',
        }),
      }),
    ]);
    expect(
      rpcEvents('turn.step.started').map((event) => (event.args as { step: number }).step),
    ).toEqual([1, 2]);
    expect(rpcEvents('turn.step.interrupted')).toEqual([]);
    expect(ctx.contextData().history).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
      }),
    ]);
  });

  it('pairs every retried step.begin with a step.end in the wire', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return {
          id: 'retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    const begins = wireLoopEvents('step.begin');
    const ends = wireLoopEvents('step.end');
    expect(begins).toHaveLength(2);
    expect(ends.map((event) => event['finishReason'])).toEqual(['error', 'end_turn']);
    expect(ends.map((event) => event['uuid'])).toEqual(begins.map((event) => event['uuid']));
  });

  it('fails the turn after maxAttempts and reports the interruption only then', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(429, 'slow down');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(10);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(9);
    expect(rpcEvents('turn.step.interrupted')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ reason: 'error', step: 10 }),
      }),
    ]);
  });

  it('honors the provider retry-after delay before retrying', async () => {
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIProviderRateLimitError('slow down', null, 1);
        return {
          id: 'retry-after-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    void ctx.dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const result = await loop.run({ turnId: 1 });

    expect(result.type).toBe('completed');
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ delayMs: 1 }),
      }),
    ]);
  });

  it('does not retry a non-retryable error', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(401, 'unauthorized');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('cancels the turn when aborted during the backoff wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        throw new APIConnectionError('terminated');
      }),
    );
    ctx.get(IEventBus).subscribe(TurnStepRetrying, () => {
      controller.abort(new Error('stop'));
    });

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
  });

  it('honors loop_control.max_attempts_per_step', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(llmGenerateServices(async () => {
      calls += 1;
      throw new APIConnectionError('terminated');
    }), {
      initialConfig: { loopControl: { maxAttemptsPerStep: 1 } },
    });

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('honors loop_control backoff delay options', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls <= 2) throw new APIConnectionError('terminated');
        return {
          id: 'backoff-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
      {
        initialConfig: { loopControl: { retryInitialDelayMs: 1_000, retryMaxDelayMs: 2_000 } },
      },
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 3, truncated: false });
    const delays = rpcEvents('turn.step.retrying').map(
      (event) => (event.args as { delayMs: number }).delayMs,
    );
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(delays[0]).toBeLessThanOrEqual(1_250);
    expect(delays[1]).toBeGreaterThanOrEqual(2_000);
    expect(delays[1]).toBeLessThanOrEqual(2_500);
  });

  it('starts a fresh attempt budget on the next turn', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let failing = true;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        if (failing) {
          calls += 1;
          throw new APIConnectionError('terminated');
        }
        return {
          id: 'ok-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const first = await runTurn(1);
    expect(first.type).toBe('failed');
    expect(calls).toBe(10);

    failing = false;
    const second = await runTurn(2);
    expect(second).toEqual({ type: 'completed', steps: 1, truncated: false });
  });

  it('retries any request error inside the request when KIMI_CODE_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIStatusError(400, 'endpoint broken');
        if (calls === 2) throw new APIStatusError(404, 'model not found');
        if (calls === 3) throw new APIStatusError(429, 'slow down');
        return {
          id: 'infinite-retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(4);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
    expect(rpcEvents('turn.step.interrupted')).toEqual([]);
  });

  it('keeps retrying past the per-step attempt budget when KIMI_CODE_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls <= 12) throw new APIStatusError(429, 'slow down');
        return {
          id: 'infinite-retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(13);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('cancels the turn when aborted during an infinite retry backoff', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    const controller = new AbortController();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(400, 'endpoint broken');
      }),
    );
    setTimeout(() => controller.abort(new Error('stop')), 100);

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
    expect(calls).toBe(1);
  });
});

describe('retryBackoffDelays', () => {
  it('starts at 500 milliseconds and doubles with up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(3);

    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(625);
    expect(delays[1]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeLessThanOrEqual(1_250);
  });

  it('caps high-attempt backoff at 32 seconds plus up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(10);

    expect(delays).toHaveLength(9);
    expect(delays[6]).toBeGreaterThanOrEqual(32_000);
    expect(delays[6]).toBeLessThanOrEqual(40_000);
    expect(delays[8]).toBeGreaterThanOrEqual(32_000);
    expect(delays[8]).toBeLessThanOrEqual(40_000);
  });

  it('honors custom initial and max delays', () => {
    const delays = retryBackoffDelays(10, { initialDelayMs: 1_000, maxDelayMs: 4_000 });

    expect(delays).toHaveLength(9);
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(delays[0]).toBeLessThanOrEqual(1_250);
    expect(delays[1]).toBeGreaterThanOrEqual(2_000);
    expect(delays[1]).toBeLessThanOrEqual(2_500);
    expect(delays[2]).toBeGreaterThanOrEqual(4_000);
    expect(delays[2]).toBeLessThanOrEqual(5_000);
    expect(delays[8]).toBeGreaterThanOrEqual(4_000);
    expect(delays[8]).toBeLessThanOrEqual(5_000);
  });
});
