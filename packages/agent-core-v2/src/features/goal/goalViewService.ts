import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentGoal } from '#/features/goal/goalAgentRuntime';
import type { GoalToolResult } from '#/features/goal/types';
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
}
