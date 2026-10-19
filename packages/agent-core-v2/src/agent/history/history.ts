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
  readonly stepId?: string;
}

export interface HistoryMessageSource {
  readonly stepId: string;
  readonly turnId?: number;
  readonly step?: number;
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
  readonly sources?: Readonly<Record<string, HistoryMessageSource>>;
}

export interface HistoryCursor {
  readonly epoch: string;
  readonly revision: number;
}

export interface HistoryWatchQuery {
  readonly after?: HistoryCursor;
  readonly limit?: number;
}

export type AgentHistoryUpdate =
  | { readonly kind: 'snapshot'; readonly cursor: HistoryCursor; readonly page: AgentHistoryPage }
  | { readonly kind: 'event'; readonly cursor: HistoryCursor; readonly event: Record<string, unknown> };

export interface IAgentHistoryService {
  readonly _serviceBrand: undefined;
  page(query?: HistoryQuery): Promise<AgentHistoryPage>;
  watch(query?: HistoryWatchQuery): AsyncIterable<AgentHistoryUpdate>;
  sequenceFor(event: Event2<any>): number | undefined;
  liveSegment(): LiveHistorySegment | undefined;
}

export const IAgentHistoryService = createDecorator<IAgentHistoryService>('agentHistoryService');
