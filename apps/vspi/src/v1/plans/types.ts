export type PlanStatus = "pending" | "in_progress" | "blocked" | "done";

export interface PlanWorkItem {
  id: string;
  title: string;
  status: PlanStatus;
  blocker?: string;
  children?: PlanWorkItem[];
}

export interface PlanInput {
  title: string;
  goal: string;
  background?: string;
  challenges: string[];
  items: PlanWorkItem[];
  focusItemId?: string;
  blockers: string[];
  nextAction?: string;
}

export interface StoredPlan extends PlanInput {
  id: string;
  revision: number;
  semanticHash: string;
  archived: boolean;
}

export interface LocalPlanBackend {
  create(plan: PlanInput): Promise<StoredPlan>;
  list(options?: { includeArchived?: boolean }): Promise<StoredPlan[]>;
  read(planId: string): Promise<StoredPlan | undefined>;
  update(planId: string, input: { expectedRevision: number; plan: PlanInput }): Promise<StoredPlan>;
  archive(planId: string, input: { expectedRevision: number }): Promise<StoredPlan>;
}

export interface PlanBinding {
  planId: string;
}
