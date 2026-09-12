import { afterEach, describe, expect, it } from 'vitest';
import { IAgentHistoryService } from '#/agent/history/history';
import { AgentHistoryService } from '#/agent/history/historyService';
import { AssistantDelta, TurnStarted, TurnStepStarted } from '#/agent/loop/turnEvents';
import { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ContextApplyCompaction } from '#/agent/contextMemory/contextEvents';
import { agentServices, createTestAgent, type TestAgentContext } from '../../harness';

describe('agent history view', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => { await ctx?.dispose(); ctx = undefined; });
  const setup = () => {
    ctx = createTestAgent(agentServices(reg => { reg.define(IAgentHistoryService, AgentHistoryService); }));
    return { context: ctx, history: ctx.get(IAgentHistoryService) };
  };

  it('preserves durable history across a context clear', async () => {
    const { context, history } = setup();
    context.context.append({ id: 'first', role: 'user', content: [{ type: 'text', text: 'original conversation' }], toolCalls: [], origin: { kind: 'user' } });
    context.context.clear();
    context.context.append({ id: 'second', role: 'user', content: [{ type: 'text', text: 'new context' }], toolCalls: [], origin: { kind: 'user' } });
    const page = await history.page({ limit: 1 });
    expect(page.items.map(item => item.id)).toEqual(['second']);
    expect(page.before).toBe(1);
    const previous = await history.page({ before: page.before, limit: 1 });
    expect(previous.items[0]?.content).toEqual([{ type: 'text', text: 'original conversation' }]);
  });

  it('includes a bounded active stream and its event watermark in a snapshot', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    await dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId: 7, origin: { kind: 'user' } }));
    const delta = new AssistantDelta({ agentId: 'main', turnId: 7, delta: 'partial answer' });
    await dispatcher.dispatch(delta);
    const page = await history.page();
    expect(page.live).toMatchObject({ turnId: 7, text: 'partial answer' });
    expect(page.revision).toBeGreaterThanOrEqual(history.sequenceFor(delta)!);
  });

  it('keeps original messages available after model context compaction', async () => {
    const { context, history } = setup();
    context.context.append({ id: 'original', role: 'user', content: [{ type: 'text', text: 'original request' }], toolCalls: [], origin: { kind: 'user' } });
    await context.get(IEventDispatcher).dispatch(new ContextApplyCompaction({ agentId: 'main', summary: 'compact summary', compactedCount: 1 }));
    const page = await history.page({ limit: 100 });
    expect(page.items.some(item => item.id === 'original')).toBe(true);
    expect(page.items.some(item => item.origin?.kind === 'compaction_summary')).toBe(true);
  });

  it('starts a fresh live segment when a transient failure retries a partial reply', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    await dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId: 7, origin: { kind: 'user' } }));
    await dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 7, delta: 'discarded partial reply' }));
    await dispatcher.dispatch(new TurnStepRetrying({ agentId: 'main', turnId: 7, step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, errorName: 'NetworkError', errorMessage: 'connection reset' }));
    expect((await history.page()).live).toMatchObject({ segment: 1, text: '', thinking: '' });
    await dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 7, delta: 'successful reply' }));
    expect((await history.page()).live).toMatchObject({ segment: 1, text: 'successful reply' });
  });

  it('retains the final visible window when undo removes the newest message', async () => {
    const { context, history } = setup();
    for (let index = 1; index <= 5; index++) context.context.append({ id: `m${index}`, role: 'user', content: [{ type: 'text', text: `message-${index}` }], toolCalls: [], origin: { kind: 'user' } });
    context.context.undo(1);
    const page = await history.page({ limit: 2 });
    expect(page.items.map(item => item.content)).toEqual([[{ type: 'text', text: 'message-3' }], [{ type: 'text', text: 'message-4' }]]);
  });

  it('does not repeat a live reply after its content has reached the journal', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    await dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId: 7, origin: { kind: 'user' } }));
    context.context.appendLoopEvent({ type: 'step.begin', uuid: 'step-1', turnId: '7', step: 1 });
    await dispatcher.dispatch(new TurnStepStarted({ agentId: 'main', turnId: 7, step: 1 }));
    await dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 7, delta: 'committed reply' }));
    context.context.appendLoopEvent({ type: 'content.part', stepUuid: 'step-1', turnId: '7', step: 1, part: { type: 'text', text: 'committed reply' } });
    const page = await history.page();
    expect(page.items.flatMap(item => item.content)).toContainEqual({ type: 'text', text: 'committed reply' });
    expect(page.live?.text).toBe('');
  });
});
