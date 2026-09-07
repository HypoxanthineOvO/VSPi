import { createDecorator } from '#/_base/di/instantiation';
import type { GoalReasonInput, ResumeGoalInput } from '#/features/goal/goal';
import type { GoalSnapshot, GoalToolResult } from '#/features/goal/types';

export interface IAgentGoalViewService {
  readonly _serviceBrand: undefined;
  getGoal(): GoalToolResult;
  pauseGoal(input?: GoalReasonInput): Promise<GoalSnapshot>;
  resumeGoal(input?: ResumeGoalInput): Promise<GoalSnapshot>;
  cancelGoal(input?: GoalReasonInput): Promise<GoalSnapshot>;
}

export const IAgentGoalViewService = createDecorator<IAgentGoalViewService>('agentGoalViewService');
