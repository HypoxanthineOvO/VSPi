import { createDecorator } from '#/_base/di/instantiation';
import type { GoalToolResult } from '#/features/goal/types';

export interface IAgentGoalViewService {
  readonly _serviceBrand: undefined;
  getGoal(): GoalToolResult;
}

export const IAgentGoalViewService = createDecorator<IAgentGoalViewService>('agentGoalViewService');
