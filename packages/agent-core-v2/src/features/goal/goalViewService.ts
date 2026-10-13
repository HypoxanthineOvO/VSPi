import { IAgentGoalService } from '#/features/goal/goalService';
import type { GoalReasonInput, ResumeGoalInput } from '#/features/goal/goal';
import type { GoalSnapshot, GoalToolResult } from '#/features/goal/types';

import type { IAgentGoalViewService } from './goalView';

export class AgentGoalViewService implements IAgentGoalViewService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentGoalService private readonly goal: IAgentGoalService) {}

  getGoal(): GoalToolResult {
    return this.goal.getGoal();
  }

  pauseGoal(input: GoalReasonInput = {}): Promise<GoalSnapshot> {
    return this.goal.pauseGoal(input, 'user');
  }

  resumeGoal(input: ResumeGoalInput = {}): Promise<GoalSnapshot> {
    return this.goal.resumeGoal(input, 'user');
  }

  cancelGoal(input: GoalReasonInput = {}): Promise<GoalSnapshot> {
    return this.goal.cancelGoal(input, 'user');
  }
}
