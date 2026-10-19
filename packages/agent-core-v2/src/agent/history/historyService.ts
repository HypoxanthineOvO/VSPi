import { randomUUID } from 'node:crypto';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { Error2, ErrorCodes } from '#/errors';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentProfileService } from '#/agent/profile/profile';
import { createContextTranscriptReducer, type ContextTranscriptReducer } from '#/agent/contextMemory/contextTranscript';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import { IAgentHistoryService, type AgentHistoryPage, type AgentHistoryUpdate, type HistoryCursor, type HistoryQuery, type HistoryWatchQuery, type LiveHistorySegment } from './history';
import { WatchQueue, measureHistoryValue } from './watchQueue';

const LIVE_LIMIT = 262144;
const MESSAGE_LIMIT = 65536;
const REPLAY_EVENT_LIMIT = 1024;
const REPLAY_BYTE_LIMIT = 1024 * 1024;
const LIVE_EVENT_BYTE_LIMIT = 4 * 1024 * 1024;
const WATCH_BUFFER_BYTES = 1024 * 1024;

interface HistoryWatchHandle {
  push(update: AgentHistoryUpdate, bytes: number): void;
  reset(): void;
  finish(): void;
}

export class AgentHistoryService extends Disposable implements IAgentHistoryService {
  declare readonly _serviceBrand: undefined;
  private revision = 0;
  private structure = 0;
  private live: LiveHistorySegment | undefined;
  private liveStep: number | undefined;
  private readonly sequences = new WeakMap<object, number>();
  private pending: Promise<AgentHistoryPage> | undefined;
  private index: ContextTranscriptReducer | undefined;
  private cursor = 0;
  private indexGeneration = 0;
  private committed: { turnId?: string; step?: number; text: boolean; thinking: boolean } | undefined;
  private readonly epoch = randomUUID();
  private readonly replay: Array<{ readonly revision: number; readonly bytes: number; readonly update: AgentHistoryUpdate }> = [];
  private replayBytes = 0;
  private readonly updateSizes = new WeakMap<AgentHistoryUpdate, number>();
  private readonly updates = new Emitter<AgentHistoryUpdate>();
  private readonly watchers = new Set<HistoryWatchHandle>();
  private watchEnabled = false;

  constructor(
    @IEventBus bus: IEventBus,
    @IWireService private readonly wire: IWireService,
    @IAppendLogStore private readonly journal: IAppendLogStore,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentActivityView private readonly activity: IAgentActivityView,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
    this._register(bus.subscribe(event => {
      this.observe(event);
      if (this.watchEnabled) this.record(event);
    }));
    this._register(this.updates);
    this._register(toDisposable(() => {
      for (const watcher of this.watchers) watcher.finish();
    }));
    this._register(journal.onDidWrite(event => {
      if (event.scope !== scope.scope() || event.key !== AGENT_WIRE_RECORD_KEY || !event.rewritten) return;
      this.index = undefined;
      this.cursor = 0;
      this.committed = undefined;
      this.indexGeneration++;
    }));
  }

  sequenceFor(event: Event2<any>): number | undefined { return this.sequences.get(event); }
  liveSegment(): LiveHistorySegment | undefined { return this.live; }

  page(query: HistoryQuery = {}): Promise<AgentHistoryPage> {
    if (this.pending) return this.pending.then(() => this.page(query));
    const pending = this.readPage(query).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  watch(query?: HistoryWatchQuery): AsyncIterable<AgentHistoryUpdate> {
    const after = query?.after;
    const limit = query?.limit;
    if (after !== undefined) assertWatchCursor(after);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'history watch limit must be an integer between 1 and 100',
      );
    }
    return {
      [Symbol.asyncIterator]: () => this.createWatchIterator(after, limit),
    };
  }

  private createWatchIterator(
    after: HistoryCursor | undefined,
    limit: number | undefined,
  ): AsyncIterator<AgentHistoryUpdate> {
    this.watchEnabled = true;
    let last = after !== undefined && after.epoch === this.epoch ? after.revision : -1;
    let subscription: IDisposable | undefined;
    const queue = new WatchQueue(WATCH_BUFFER_BYTES, () => {
      this.watchers.delete(handle);
      subscription?.dispose();
    });
    const handle: HistoryWatchHandle = {
      push: (update, bytes) => queue.push({ kind: 'event', update, bytes }),
      reset: () => queue.push({ kind: 'reset' }),
      finish: () => queue.finish(),
    };
    subscription = this.updates.event((update) => {
      handle.push(update, this.updateSizes.get(update) ?? 0);
    });
    this.watchers.add(handle);
    const replayable =
      after !== undefined &&
      after.epoch === this.epoch &&
      after.revision <= this.revision &&
      this.replay.length > 0 &&
      after.revision >= this.replay[0]!.revision - 1;
    if (replayable) {
      for (const entry of this.replay) {
        if (entry.revision > last) queue.push({ kind: 'event', update: entry.update, bytes: entry.bytes });
      }
    } else {
      queue.push({ kind: 'reset' });
    }
    return {
      next: async (): Promise<IteratorResult<AgentHistoryUpdate>> => {
        for (;;) {
          const item = await queue.next();
          if (item.done === true) return { done: true, value: undefined };
          const entry = item.value;
          if (entry.kind === 'reset') {
            let page: AgentHistoryPage;
            try {
              const pendingPage = this.page({ limit }).then(page => ({ kind: 'page' as const, page }));
              const raced = await Promise.race([
                pendingPage,
                queue.closed.then(() => ({ kind: 'closed' as const })),
              ]);
              if (raced.kind === 'closed') {
                pendingPage.catch(() => undefined);
                continue;
              }
              page = raced.page;
            } catch (error) {
              if (queue.terminated) continue;
              queue.fail(error);
              throw error;
            }
            if (queue.terminated) continue;
            last = page.revision;
            return {
              done: false,
              value: {
                kind: 'snapshot',
                cursor: { epoch: this.epoch, revision: page.revision },
                page,
              },
            };
          }
          const revision = entry.update.cursor.revision;
          if (revision <= last) continue;
          last = revision;
          return { done: false, value: entry.update };
        }
      },
      return: async (): Promise<IteratorResult<AgentHistoryUpdate>> => {
        queue.finish();
        return { done: true, value: undefined };
      },
    };
  }

  private record(event: Event2<any>): void {
    const revision = this.sequenceFor(event)!;
    const update: AgentHistoryUpdate = {
      kind: 'event',
      cursor: { epoch: this.epoch, revision },
      event: {
        ...event.serialize(),
        viewRevision: revision,
        viewSegment: this.live?.segment,
      },
    };
    if (measureHistoryValue(update, LIVE_EVENT_BYTE_LIMIT) > LIVE_EVENT_BYTE_LIMIT) {
      this.replay.length = 0;
      this.replayBytes = 0;
      for (const watcher of this.watchers) watcher.reset();
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(update), 'utf8');
    this.updateSizes.set(update, bytes);
    if (bytes > REPLAY_BYTE_LIMIT) {
      this.replay.length = 0;
      this.replayBytes = 0;
    } else {
      this.replay.push({ revision, bytes, update });
      this.replayBytes += bytes;
      while (this.replay.length > REPLAY_EVENT_LIMIT || this.replayBytes > REPLAY_BYTE_LIMIT) {
        const evicted = this.replay.shift();
        if (evicted === undefined) break;
        this.replayBytes -= evicted.bytes;
      }
    }
    if (bytes <= LIVE_EVENT_BYTE_LIMIT) {
      this.updates.fire(update);
    } else {
      for (const watcher of this.watchers) watcher.reset();
    }
  }

  private observe(event: Event2<any>): void {
    const data = event as Event2<any> & { turnId?: number; delta?: string; step?: number; stepId?: string };
    this.sequences.set(event, ++this.revision);
    if (event.type === 'assistant.delta' || event.type === 'thinking.delta') {
      if (data.turnId === undefined || typeof data.delta !== 'string') return;
      if (this.live?.turnId !== data.turnId) this.live = { turnId: data.turnId, segment: 0, text: '', thinking: '' };
      const key = event.type === 'assistant.delta' ? 'text' : 'thinking';
      this.live = { ...this.live, [key]: (this.live[key] + data.delta).slice(-LIVE_LIMIT) };
      return;
    }
    if (['turn.started', 'turn.ended', 'tool.call.started', 'tool.result', 'prompt.submitted', 'prompt.steered', 'turn.step.started', 'turn.step.retrying', 'turn.step.completed', 'turn.step.interrupted', 'permission.approval.requested', 'context.spliced', 'context.undone', 'compaction.completed', 'agent.status.updated'].includes(event.type)) this.structure++;
    if (event.type === 'turn.started' && data.turnId !== undefined) { this.live = { turnId: data.turnId, segment: 0, text: '', thinking: '' }; this.liveStep = undefined; }
    if (event.type === 'turn.step.started' && data.step !== undefined) {
      if (this.live && this.liveStep !== undefined && this.liveStep !== data.step) this.live = { turnId: this.live.turnId, segment: this.live.segment + 1, text: '', thinking: '' };
      if (this.live) this.live = { ...this.live, stepId: data.stepId };
      this.liveStep = data.step;
    }
    if ((event.type === 'tool.call.started' || event.type === 'prompt.steered' || event.type === 'turn.step.retrying') && this.live) this.live = { ...this.live, segment: this.live.segment + 1, text: '', thinking: '' };
    if (event.type === 'turn.ended') { this.live = undefined; this.liveStep = undefined; }
  }

  private async readPage(query: HistoryQuery): Promise<AgentHistoryPage> {
    const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
    for (let attempt = 0; attempt < 4; attempt++) {
      const structure = this.structure;
      await this.wire.flush();
      const generation = this.indexGeneration;
      {
        if (this.cursor === 0) { this.index = undefined; this.committed = undefined; }
        const index = this.index ??= createContextTranscriptReducer({ maxContentChars: MESSAGE_LIMIT, tailContentLimit: 100 });
        try {
          for await (const record of this.journal.read<WireRecord>(this.scope.scope(), AGENT_WIRE_RECORD_KEY, {
            fromByte: this.cursor,
            onCursor: cursor => { if (generation === this.indexGeneration) this.cursor = cursor; },
          })) {
            index.add(record);
            const event = record['event'] as { type?: string; turnId?: string; step?: number; part?: { type?: string } } | undefined;
            if (record.type === 'context.append_loop_event' && event?.type === 'content.part') {
              if (this.committed?.turnId !== event.turnId || this.committed?.step !== event.step)
                this.committed = { turnId: event.turnId, step: event.step, text: false, thinking: false };
              this.committed!.text ||= event.part?.type === 'text';
              this.committed!.thinking ||= event.part?.type === 'think';
            }
          }
        } catch (error) {
          this.index = undefined;
          this.cursor = 0;
          this.committed = undefined;
          throw error;
        }
        if (generation !== this.indexGeneration) continue;
      }
      if (structure !== this.structure) continue;
      const positions = this.index.positions();
      const end = Math.max(0, Math.min(positions.length, query.before ?? positions.length));
      const start = Math.max(0, end - limit);
      let reducer = this.index;
      if (positions.slice(start, end).some(ordinal => !reducer.hasContent(ordinal))) {
        reducer = createContextTranscriptReducer({ maxContentChars: MESSAGE_LIMIT, contentOrdinals: new Set(positions.slice(start, end)) });
        for await (const record of this.journal.read<WireRecord>(this.scope.scope(), AGENT_WIRE_RECORD_KEY)) reducer.add(record);
      }
      if (structure !== this.structure || generation !== this.indexGeneration) continue;
      const currentCommitted = this.committed !== undefined && Number(this.committed.turnId) === this.live?.turnId && this.committed.step === this.liveStep;
      const transcript = reducer.result();
      const items = transcript.entries.slice(start, end).map((message, index) => ({ ...message, id: message.id ?? `history:${positions[start + index]}` }));
      const sources = Object.fromEntries(items.flatMap((message, index) => {
        const source = reducer.sourceAt(positions[start + index]!);
        return source ? [[message.id, source]] : [];
      }));
      return {
        items,
        before: start > 0 ? start : undefined,
        total: transcript.entries.length,
        revision: this.revision,
        truncated: items.some(message => message.content.some(part => part.type === 'text' && part.text.endsWith('[display truncated]'))),
        activity: this.activity.state(),
        model: this.profile.hasModel() ? this.profile.getModel() : undefined,
        effort: this.profile.getEffectiveThinkingLevel(),
        sources,
        live: this.live ? { ...this.live, text: currentCommitted && this.committed?.text ? '' : this.live.text, thinking: currentCommitted && this.committed?.thinking ? '' : this.live.thinking } : undefined,
      };
    }
    throw new StorageError(StorageErrors.codes.STORAGE_LOCKED, 'Conversation changed while reading history; retry after the current step');
  }
}

function assertWatchCursor(cursor: HistoryCursor): void {
  if (
    cursor === null ||
    typeof cursor !== 'object' ||
    typeof cursor.epoch !== 'string' ||
    cursor.epoch.length === 0 ||
    !Number.isSafeInteger(cursor.revision) ||
    cursor.revision < 0
  ) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'history watch cursor is invalid');
  }
}

registerScopedService(LifecycleScope.Agent, IAgentHistoryService, AgentHistoryService, ScopeActivation.OnScopeCreated, 'agentHistory');
