import type { PolicyAction } from "../policy/execution-policy.js";

export type WorkflowAdapterStatus = "ready" | "uninitialized" | "unavailable" | "disabled" | "error";

export interface WorkflowBundleIdentity {
  version: string;
  sourceCommit: string;
  archiveSha256: string;
  contractVersion: string;
  root: string;
}

export interface WorkflowMilestoneSnapshot {
  id: string;
  title: string;
  status: string;
  stone?: boolean;
}

export interface WorkflowSnapshot {
  status: WorkflowAdapterStatus;
  diagnostic: string;
  identity?: WorkflowBundleIdentity;
  workspaceId?: string;
  delivery?: {
    id: string;
    kind: string;
    status: string;
    revision: number;
    planHash: string;
    milestones: WorkflowMilestoneSnapshot[];
    currentMilestoneId?: string;
  };
}

export interface WorkflowAdapter {
  snapshot(): Promise<WorkflowSnapshot>;
  authorize(action: PolicyAction): Promise<boolean>;
}

export interface WorkflowCoreModule {
  createDeliveryStore(options: { clock: () => string }): {
    resume(root: string, input: Record<string, never>): Promise<unknown>;
  };
  createWorkstreamStore(options: { clock: () => string }): unknown;
  compileVspiIntegrationContract(input: { generated_at: string }): unknown;
  parseVspiIntegrationContract(value: unknown): unknown;
  verifyPortableBundle(input: { root: string; manifest: unknown }): Promise<{ files: string[] }>;
}

export interface LoadedWorkflowCore {
  core: WorkflowCoreModule;
  identity: WorkflowBundleIdentity;
}
