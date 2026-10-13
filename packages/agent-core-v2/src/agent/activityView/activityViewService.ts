import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { interactions } from '#/human/interaction/facade';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { INTERACTION_TAG_SESSION_ID, INTERACTION_TAG_AGENT_ID } from '#/human/interaction/interaction';
import { AgentActivityUpdated, IAgentActivityView, type AgentActivityState, type ActivityLastTurnState } from './activityView';

export class AgentActivityView extends Disposable implements IAgentActivityView {
  declare readonly _serviceBrand: undefined;
  private origin: PromptOrigin = { kind: 'user' };
  private lastTurn: ActivityLastTurnState | undefined;
  private stream: 'assistant' | 'thinking' | 'tool_call' | undefined;
  private readonly toolSince = new Map<string, number>();
  private endedTurnId: number | undefined;
  private queued = false;
  private disposed = false;
  private lastState = '';

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IEventBus private readonly bus: IEventBus,
    @ISessionContext private readonly session: ISessionContext,
  ) {
    super();
    this._register(bus.subscribe(event => {
      const data = event as unknown as { type: string; origin?: PromptOrigin; turnId?: number; reason?: ActivityLastTurnState['reason']; durationMs?: number; toolCallId?: string };
      if (!/^(turn\.|assistant\.|thinking\.|tool\.|task\.|permission\.approval\.)/.test(data.type)) return;
      if (data.type === 'turn.started') {
        this.origin = data.origin ?? { kind: 'user' };
        this.endedTurnId = undefined;
        this.stream = undefined;
      }
      if (data.type === 'assistant.delta') this.stream = 'assistant';
      if (data.type === 'thinking.delta') this.stream = 'thinking';
      if (data.type === 'tool.call.delta') this.stream = 'tool_call';
      if (data.type === 'turn.step.started' || data.type === 'tool.call.started' || data.type === 'turn.step.retrying') this.stream = undefined;
      if (data.type === 'tool.call.started' && data.toolCallId) this.toolSince.set(data.toolCallId, Date.now());
      if (data.type === 'tool.result' && data.toolCallId) this.toolSince.delete(data.toolCallId);
      if (data.type === 'turn.ended' && data.turnId !== undefined && data.reason) {
        this.endedTurnId = data.turnId;
        this.lastTurn = { turnId: data.turnId, reason: data.reason, durationMs: data.durationMs, at: Date.now() };
        this.toolSince.clear();
      }
      if (!this.queued) {
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          if (!this.disposed) this.publish();
        });
      }
    }));
  }

  state(): AgentActivityState {
    const snapshot = this.loop.snapshot();
    const turn = snapshot.turn?.turnId === this.endedTurnId ? undefined : snapshot.turn;
    return {
      lifecycle: this.disposed ? 'disposed' : 'ready',
      turn: turn ? {
        ...turn,
        origin: this.origin,
        phase: turn.phase === 'running' && this.stream ? 'streaming' : turn.phase,
        stream: this.stream,
        since: turn.since ?? 0,
        pendingApprovals: interactions.findAll({ kind: 'approval', resolved: false, tags: { [INTERACTION_TAG_AGENT_ID]: this.scope.agentId, [INTERACTION_TAG_SESSION_ID]: this.session.sessionId } }).map(approval => ({
          approvalId: approval.id,
          toolCallId: (approval.payload as { toolCallId?: string }).toolCallId,
          since: approval.createdAt,
        })),
        activeToolCalls: turn.activeToolCalls.map(call => ({ ...call, since: this.toolSince.get(call.toolCallId) ?? turn.since ?? 0 })),
      } : undefined,
      lastTurn: this.lastTurn,
      background: this.tasks.list(true).map(task => ({ kind: task.kind, id: task.taskId, since: task.startedAt })),
    };
  }

  private publish(): void {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.lastState) return;
    this.lastState = key;
    this.bus.publish(new AgentActivityUpdated({ agentId: this.scope.agentId, ...state }));
  }

  override dispose(): void {
    this.disposed = true;
    this.publish();
    super.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentActivityView, AgentActivityView, ScopeActivation.OnScopeCreated, 'agentActivity');
