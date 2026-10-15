import { afterEach, describe, expect, it, vi } from 'vitest';
import { IAgentActivityView, AgentActivityUpdated, type AgentActivityState } from '#/agent/activityView/activityView';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentHistoryService, type AgentHistoryPage } from '#/agent/history/history';
import { AgentHistoryService } from '#/agent/history/historyService';
import { AssistantDelta, TurnStarted, TurnStepStarted } from '#/agent/loop/turnEvents';
import { TurnStepRetrying } from '#/agent/loop/turnEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ContextUndo, ContextApplyCompaction } from '#/agent/contextMemory/contextEvents';
import { agentServices, createTestAgent, type TestAgentContext } from '../../harness';

describe('agent history view', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => { await ctx?.dispose(); ctx = undefined; });
  const setup = () => {
    ctx = createTestAgent(agentServices(reg => { reg.define(IAgentHistoryService, AgentHistoryService); }));
    return { context: ctx, history: ctx.get(IAgentHistoryService) };
  };

  it('projects the running turn and its completed state through activity events and history', async () => {
    const { context, history } = setup();
    const updates: AgentActivityState[] = [];
    context.get(IEventBus).subscribe(AgentActivityUpdated, event => updates.push(event));
    context.mockNextResponse({ type: 'text', text: 'complete response' });
    await context.rpc.prompt({ input: [{ type: 'text', text: 'show activity' }] });
    await context.untilTurnEnd();
    await Promise.resolve();
    expect(updates.some(update => update.turn?.turnId === 0)).toBe(true);
    expect(context.get(IAgentActivityView).state()).toMatchObject({
      lifecycle: 'ready', turn: undefined, lastTurn: { turnId: 0, reason: 'completed' },
    });
    expect((await history.page()).activity).toMatchObject({ lastTurn: { reason: 'completed' } });
    expect(updates.at(-1)?.lastTurn?.reason).toBe('completed');
  });

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
    await context.get(IEventDispatcher).dispatch(new ContextUndo({ agentId: 'main', count: 1 }));
    const page = await history.page({ limit: 2 });
    expect(page.items.map(item => item.content)).toEqual([[{ type: 'text', text: 'message-3' }], [{ type: 'text', text: 'message-4' }]]);
  });

  it('loads older contents after they leave the retained tail', async () => {
    const { context, history } = setup();
    for (let index = 0; index < 250; index++) context.appendUserMessage([{ type: 'text', text: `message-${index}` }]);
    expect((await history.page({ limit: 1 })).items[0]?.content).toEqual([{ type: 'text', text: 'message-249' }]);
    expect((await history.page({ before: 50, limit: 1 })).items[0]?.content).toEqual([{ type: 'text', text: 'message-49' }]);
    context.appendUserMessage([{ type: 'text', text: 'new' }]);
    expect((await history.page({ limit: 1 })).items[0]?.content).toEqual([{ type: 'text', text: 'new' }]);
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

  it('starts a watch with a snapshot then streams live events in order', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    const iter = history.watch()[Symbol.asyncIterator]();
    try {
      const first = await iter.next();
      expect(first.value?.kind).toBe('snapshot');
      if (first.value?.kind !== 'snapshot') return;
      const started = new TurnStarted({ agentId: 'main', turnId: 9, origin: { kind: 'user' } });
      const delta = new AssistantDelta({ agentId: 'main', turnId: 9, delta: 'streamed' });
      await dispatcher.dispatch(started);
      await dispatcher.dispatch(delta);
      const seen: number[] = [];
      const types: string[] = [];
      const target = history.sequenceFor(delta)!;
      while (seen.length === 0 || seen.at(-1)! < target) {
        const chunk = await iter.next();
        expect(chunk.value?.kind).toBe('event');
        if (chunk.value?.kind !== 'event') return;
        seen.push(chunk.value.cursor.revision);
        types.push(chunk.value.event['type'] as string);
        expect(chunk.value.cursor.epoch).toBe(first.value.cursor.epoch);
      }
      expect(seen).toContain(history.sequenceFor(started));
      expect(seen).toContain(target);
      expect(types).toContain('turn.started');
      expect(types).toContain('assistant.delta');
      expect([...seen].toSorted((a, b) => a - b)).toEqual(seen);
    } finally {
      await iter.return?.();
    }
  });

  it('replays retained events after a matching cursor without a snapshot', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    const initial = history.watch()[Symbol.asyncIterator]();
    const snapshot = await initial.next();
    if (snapshot.value?.kind !== 'snapshot') throw new Error('expected snapshot');
    const cursor = snapshot.value.cursor;
    const started = new TurnStarted({ agentId: 'main', turnId: 9, origin: { kind: 'user' } });
    const delta = new AssistantDelta({ agentId: 'main', turnId: 9, delta: 'replayed' });
    await dispatcher.dispatch(started);
    await dispatcher.dispatch(delta);
    const replay = history.watch({ after: cursor })[Symbol.asyncIterator]();
    try {
      const seen: number[] = [];
      const target = history.sequenceFor(delta)!;
      while (seen.length === 0 || seen.at(-1)! < target) {
        const chunk = await replay.next();
        expect(chunk.value?.kind).toBe('event');
        if (chunk.value?.kind !== 'event') return;
        seen.push(chunk.value.cursor.revision);
      }
      expect(seen).toContain(history.sequenceFor(started));
      expect(seen).toContain(target);
    } finally {
      await replay.return?.();
      await initial.return?.();
    }
  });

  it('does not lose or duplicate an event that lands while the snapshot page is read', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    await dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId: 9, origin: { kind: 'user' } }));
    const iter = history.watch()[Symbol.asyncIterator]();
    try {
      const raced = new AssistantDelta({ agentId: 'main', turnId: 9, delta: 'raced' });
      const first = iter.next();
      await dispatcher.dispatch(raced);
      const snapshot = await first;
      expect(snapshot.value?.kind).toBe('snapshot');
      if (snapshot.value?.kind !== 'snapshot') return;
      const racedRevision = history.sequenceFor(raced)!;
      let delivered = 0;
      if (racedRevision > snapshot.value.cursor.revision) {
        const chunk = await iter.next();
        expect(chunk.value).toMatchObject({
          kind: 'event',
          cursor: { revision: racedRevision },
        });
        delivered = 1;
      } else {
        expect(snapshot.value.page.live?.text).toContain('raced');
      }
      const after = new AssistantDelta({ agentId: 'main', turnId: 9, delta: 'after snapshot' });
      await dispatcher.dispatch(after);
      const afterRevision = history.sequenceFor(after)!;
      for (;;) {
        const chunk = await iter.next();
        expect(chunk.value?.kind).toBe('event');
        if (chunk.value?.kind !== 'event') return;
        if (chunk.value.cursor.revision === racedRevision) delivered += 1;
        if (chunk.value.cursor.revision >= afterRevision) break;
      }
      expect(delivered).toBeLessThanOrEqual(1);
    } finally {
      await iter.return?.();
    }
  });

  it('falls back to a snapshot for a foreign epoch or a revision outside the retained window', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    const stale = history.watch({ after: { epoch: 'other-epoch', revision: 0 } })[Symbol.asyncIterator]();
    try {
      expect((await stale.next()).value?.kind).toBe('snapshot');
    } finally {
      await stale.return?.();
    }
    for (let index = 0; index < 1030; index++) {
      await dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 9, delta: `d${index}` }));
    }
    const initial = history.watch()[Symbol.asyncIterator]();
    try {
      const snapshot = await initial.next();
      if (snapshot.value?.kind !== 'snapshot') throw new Error('expected snapshot');
      const evicted = history.watch({
        after: { epoch: snapshot.value.cursor.epoch, revision: 0 },
      })[Symbol.asyncIterator]();
      try {
        expect((await evicted.next()).value?.kind).toBe('snapshot');
      } finally {
        await evicted.return?.();
      }
    } finally {
      await initial.return?.();
    }
  });

  it('return resolves a pending next while the snapshot page is still blocked', async () => {
    const { history } = setup();
    let releasePage!: (page: AgentHistoryPage) => void;
    vi.spyOn(history, 'page').mockReturnValue(
      new Promise<AgentHistoryPage>((resolve) => {
        releasePage = resolve;
      }),
    );
    const iter = history.watch()[Symbol.asyncIterator]();
    const pending = iter.next();
    await iter.return?.();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    releasePage({
      items: [],
      total: 0,
      revision: 0,
      truncated: false,
      activity: { lifecycle: 'ready' },
      effort: 'low',
    } as unknown as AgentHistoryPage);
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined });
    const internals = history as unknown as { watchers: Set<unknown> };
    expect(internals.watchers.size).toBe(0);
  });

  it('dispose resolves a pending next while the snapshot page is still blocked', async () => {
    const { context, history } = setup();
    let failPage!: (error: unknown) => void;
    vi.spyOn(history, 'page').mockReturnValue(
      new Promise<AgentHistoryPage>((_, reject) => {
        failPage = reject;
      }),
    );
    const iter = history.watch()[Symbol.asyncIterator]();
    const pending = iter.next();
    await context.dispose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    failPage(new Error('late page failure'));
    ctx = undefined;
  });

  it('keeps revision order when a later listener publishes reentrantly', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    const bus = context.get(IEventBus);
    const iter = history.watch()[Symbol.asyncIterator]();
    try {
      const snapshot = await iter.next();
      if (snapshot.value?.kind !== 'snapshot') throw new Error('expected snapshot');
      const outer = new AssistantDelta({ agentId: 'main', turnId: 9, delta: 'outer' });
      const nested = new AssistantDelta({ agentId: 'main', turnId: 9, delta: 'nested' });
      let fired = false;
      const subscription = bus.subscribe((event) => {
        if (fired || event !== outer) return;
        fired = true;
        bus.publish(nested);
      });
      try {
        await dispatcher.dispatch(outer);
      } finally {
        subscription.dispose();
      }
      const outerRevision = history.sequenceFor(outer)!;
      const nestedRevision = history.sequenceFor(nested)!;
      expect(nestedRevision).toBe(outerRevision + 1);
      const seen: number[] = [];
      while (seen.length === 0 || seen.at(-1)! < nestedRevision) {
        const chunk = await iter.next();
        expect(chunk.value?.kind).toBe('event');
        if (chunk.value?.kind !== 'event') return;
        seen.push(chunk.value.cursor.revision);
      }
      expect([...seen].toSorted((a, b) => a - b)).toEqual(seen);
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      await iter.return?.();
    }
  });

  it('resets watchers to a snapshot instead of delivering an oversized event', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    const iter = history.watch()[Symbol.asyncIterator]();
    try {
      const first = await iter.next();
      if (first.value?.kind !== 'snapshot') throw new Error('expected snapshot');
      const base = first.value.cursor;
      await dispatcher.dispatch(
        new AssistantDelta({ agentId: 'main', turnId: 9, delta: 'x'.repeat(2 * 1024 * 1024) }),
      );
      const next = await iter.next();
      expect(next.value?.kind).toBe('snapshot');
      if (next.value?.kind !== 'snapshot') return;
      expect(next.value.cursor.epoch).toBe(base.epoch);
      expect(next.value.cursor.revision).toBeGreaterThanOrEqual(base.revision);
    } finally {
      await iter.return?.();
    }
  });

  it('rejects a slow consumer instead of dropping queued events', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    const iter = history.watch()[Symbol.asyncIterator]();
    try {
      await iter.next();
      const big = 'x'.repeat(600 * 1024);
      await dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 9, delta: big }));
      await dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 9, delta: big }));
      await expect(iter.next()).rejects.toThrow(/fell behind|resubscribe/i);
    } finally {
      await iter.return?.();
    }
  });

  it('delivers control characters and escaped payloads unchanged', async () => {
    const { context, history } = setup();
    const dispatcher = context.get(IEventDispatcher);
    const iter = history.watch()[Symbol.asyncIterator]();
    try {
      const first = await iter.next();
      if (first.value?.kind !== 'snapshot') throw new Error('expected snapshot');
      const payload = 'pre\u0000\u0001\u001F\n\t"\\\u4E16post';
      const delta = new AssistantDelta({ agentId: 'main', turnId: 9, delta: payload });
      await dispatcher.dispatch(delta);
      const revision = history.sequenceFor(delta)!;
      for (;;) {
        const chunk = await iter.next();
        if (chunk.value?.kind !== 'event') continue;
        if (chunk.value.cursor.revision < revision) continue;
        expect(chunk.value.event['type']).toBe('assistant.delta');
        expect(chunk.value.event['delta']).toBe(payload);
        break;
      }
    } finally {
      await iter.return?.();
    }
  });

  it('resets watchers instead of traversing an overdeep payload', async () => {
    const { context, history } = setup();
    const bus = context.get(IEventBus);
    const iter = history.watch()[Symbol.asyncIterator]();
    try {
      const first = await iter.next();
      if (first.value?.kind !== 'snapshot') throw new Error('expected snapshot');
      let nested: unknown = 'leaf';
      for (let index = 0; index < 200; index++) nested = { child: nested };
      bus.publish({
        type: 'test.overdeep',
        time: Date.now(),
        serialize: () => ({ type: 'test.overdeep', time: 0, nested }),
      } as never);
      const next = await iter.next();
      expect(next.value?.kind).toBe('snapshot');
    } finally {
      await iter.return?.();
    }
  });

  it('resolves a pending queue wait when the agent is disposed', async () => {
    const { context, history } = setup();
    const iter = history.watch()[Symbol.asyncIterator]();
    await iter.next();
    const pending = iter.next();
    await context.dispose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    ctx = undefined;
  });

  it('validates the watch cursor and limit', () => {
    const { history } = setup();
    expect(() => history.watch({ after: { epoch: '', revision: 1 } })).toThrow();
    expect(() => history.watch({ after: { epoch: 'e', revision: -1 } })).toThrow();
    expect(() => history.watch({ limit: 0 })).toThrow();
    expect(() => history.watch({ limit: 101 })).toThrow();
  });
});
