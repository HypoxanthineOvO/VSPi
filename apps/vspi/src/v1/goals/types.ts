export type GoalState =
  | "executing"
  | "paused"
  | "blocked"
  | "stalled"
  | "pending_acceptance"
  | "completed"
  | "cancelled";

export interface GoalContract {
  objective: string;
  completionCriteria: string[];
}

export interface GoalLimits {
  maxAutoRounds: number;
  maxNoProgressRounds: number;
  maxTokens: number;
}

export interface GoalMarker {
  sequence: number;
  recordedAt: string;
  currentItem?: string;
  completedWork: string[];
  evidence: string[];
  nextItem?: string;
  note?: string;
}

export interface GoalBlocker {
  reason: string;
  attempts: string[];
  neededInput: string;
  recordedAt: string;
}

export interface GoalOwner {
  sessionId: string;
  processId: string;
  acquiredAt: string;
}

export interface GoalInput {
  contract: GoalContract;
  planId: string;
  limits: GoalLimits;
  owner: GoalOwner;
  initialTokens: number;
}

export interface StoredGoal extends GoalInput {
  id: string;
  revision: number;
  semanticHash: string;
  state: GoalState;
  autoRounds: number;
  noProgressRounds: number;
  consumedTokens: number;
  markers: GoalMarker[];
  blocker?: GoalBlocker;
  stateReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalRoundInput {
  expectedRevision: number;
  consumedTokens: number;
  progressed: boolean;
}

export interface GoalBackend {
  create(input: GoalInput): Promise<StoredGoal>;
  list(): Promise<StoredGoal[]>;
  read(goalId: string): Promise<StoredGoal | undefined>;
  checkpoint(
    goalId: string,
    input: {
      expectedRevision: number;
      currentItem?: string;
      completedWork: string[];
      evidence: string[];
      nextItem?: string;
      note?: string;
    },
  ): Promise<StoredGoal>;
  recordRound(goalId: string, input: GoalRoundInput): Promise<StoredGoal>;
  block(
    goalId: string,
    input: { expectedRevision: number; reason: string; attempts: string[]; neededInput: string },
  ): Promise<StoredGoal>;
  claimComplete(
    goalId: string,
    input: { expectedRevision: number; summary: string; evidence: string[] },
  ): Promise<StoredGoal>;
  transition(
    goalId: string,
    input: {
      expectedRevision: number;
      state: Extract<GoalState, "executing" | "paused" | "completed" | "cancelled">;
      reason?: string;
      owner?: GoalOwner;
      initialTokens?: number;
    },
  ): Promise<StoredGoal>;
}

export interface GoalBinding {
  goalId: string;
}

export const DEFAULT_GOAL_LIMITS: GoalLimits = {
  maxAutoRounds: 24,
  maxNoProgressRounds: 3,
  maxTokens: 500_000,
};

export function goalIsTerminal(state: GoalState): boolean {
  return state === "completed" || state === "cancelled";
}

export function goalCanAutoContinue(goal: StoredGoal): boolean {
  return goal.state === "executing";
}
