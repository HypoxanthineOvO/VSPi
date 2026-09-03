import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentGoal } from '#/features/goal/goalAgentRuntime';
import type { GoalReasonInput, ResumeGoalInput } from '#/features/goal/goal';
import type { GoalSnapshot, GoalToolResult } from '#/features/goal/types';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import type { IAgentGoalViewService } from './goalView';

export class AgentGoalViewService implements IAgentGoalViewService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly manager: IAgentLifecycleService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {}

  getGoal(): GoalToolResult {
    return this.manager.resolve(this.scope.agentContext, AgentGoal).getGoal();
  }

  pauseGoal(input: GoalReasonInput = {}): Promise<GoalSnapshot> {
    return this.manager.resolve(this.scope.agentContext, AgentGoal).pauseGoal(input, 'user');
  }

  resumeGoal(input: ResumeGoalInput = {}): Promise<GoalSnapshot> {
    return this.manager.resolve(this.scope.agentContext, AgentGoal).resumeGoal(input, 'user');
  }

  cancelGoal(input: GoalReasonInput = {}): Promise<GoalSnapshot> {
    return this.manager.resolve(this.scope.agentContext, AgentGoal).cancelGoal(input, 'user');
  }
}
