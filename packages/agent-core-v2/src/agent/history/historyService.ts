import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentProfileService } from '#/agent/profile/profile';
import { createContextTranscriptReducer, type ContextTranscriptReducer } from '#/agent/contextMemory/contextTranscript';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import { IAgentHistoryService, type AgentHistoryPage, type HistoryQuery, type LiveHistorySegment } from './history';

const LIVE_LIMIT = 262144;
const MESSAGE_LIMIT = 65536;

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

  constructor(
    @IEventBus bus: IEventBus,
    @IWireService private readonly wire: IWireService,
    @IAppendLogStore private readonly journal: IAppendLogStore,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentActivityView private readonly activity: IAgentActivityView,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
    this._register(bus.subscribe(event => this.observe(event)));
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

  private observe(event: Event2<any>): void {
    const data = event as Event2<any> & { turnId?: number; delta?: string; step?: number };
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
      this.liveStep = data.step;
    }
    if ((event.type === 'tool.call.started' || event.type === 'prompt.steered' || event.type === 'turn.step.retrying') && this.live) this.live = { turnId: this.live.turnId, segment: this.live.segment + 1, text: '', thinking: '' };
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
      return {
        items,
        before: start > 0 ? start : undefined,
        total: transcript.entries.length,
        revision: this.revision,
        truncated: items.some(message => message.content.some(part => part.type === 'text' && part.text.endsWith('[display truncated]'))),
        activity: this.activity.state(),
        model: this.profile.hasModel() ? this.profile.getModel() : undefined,
        effort: this.profile.getEffectiveThinkingLevel(),
        live: this.live ? { ...this.live, text: currentCommitted && this.committed?.text ? '' : this.live.text, thinking: currentCommitted && this.committed?.thinking ? '' : this.live.thinking } : undefined,
      };
    }
    throw new StorageError(StorageErrors.codes.STORAGE_LOCKED, 'Conversation changed while reading history; retry after the current step');
  }
}

registerScopedService(LifecycleScope.Agent, IAgentHistoryService, AgentHistoryService, ScopeActivation.OnScopeCreated, 'agentHistory');
