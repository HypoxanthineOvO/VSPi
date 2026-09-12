import { createDecorator } from '#/_base/di/instantiation';
import type { Event2 } from '#/app/event/event2';
import type { AgentActivityState } from '#/agent/activityView/activityView';
import type { ContextMessage } from '#/agent/contextMemory/types';

export interface HistoryQuery {
  readonly before?: number;
  readonly limit?: number;
}

export interface LiveHistorySegment {
  readonly turnId: number;
  readonly segment: number;
  readonly text: string;
  readonly thinking: string;
}

export interface AgentHistoryPage {
  readonly items: readonly ContextMessage[];
  readonly before?: number;
  readonly total: number;
  readonly revision: number;
  readonly truncated: boolean;
  readonly activity: AgentActivityState;
  readonly model?: string;
  readonly effort: string;
  readonly live?: LiveHistorySegment;
}

export interface IAgentHistoryService {
  readonly _serviceBrand: undefined;
  page(query?: HistoryQuery): Promise<AgentHistoryPage>;
  sequenceFor(event: Event2<any>): number | undefined;
  liveSegment(): LiveHistorySegment | undefined;
}

export const IAgentHistoryService = createDecorator<IAgentHistoryService>('agentHistoryService');
