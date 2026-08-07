import type { EffortLevel } from "../domain/types.js";

export const AGENT_ROUTING_MODES = ["required", "preferred", "consult", "manual"] as const;
export type AgentRoutingMode = (typeof AGENT_ROUTING_MODES)[number];
export const AGENT_ROLES = ["orchestrator", "researcher", "analyst", "worker"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentModelPoolConfig {
  roles: Partial<Record<AgentRole, string>>;
}

export interface ResolvedAgentModelPool {
  provider: string;
  source: "automatic" | "project";
  roles: Record<AgentRole, string>;
}

export const AGENT_RUN_STATUSES = ["queued", "running", "success", "error", "cancelled"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface TeammateFallbackState {
  from: string;
  reason: "quota_exhausted";
  at: string;
}

export interface TeammateDefinition {
  id: string;
  role: string;
  description: string;
  routing: AgentRoutingMode;
  match: string[];
  systemPrompt: string;
  tools: string[];
  preferredModel?: string;
  currentModel?: string;
  effort?: EffortLevel;
  fallbackModels: string[];
  fallback?: TeammateFallbackState;
}

export interface AgentProjectConfig {
  version: 1;
  maxConcurrency: number;
  allowedModels: string[];
  modelPools: Record<string, AgentModelPoolConfig>;
  crossProviderDelegation: boolean;
  teammates: TeammateDefinition[];
}

export interface AgentRunSnapshot {
  id: string;
  treeId: string;
  parentId?: string;
  kind: "task" | "teammate";
  teammateId?: string;
  lane?: string;
  depth: number;
  model: string;
  role: AgentRole;
  modelReason: string;
  preferredModel?: string;
  effort: EffortLevel;
  contextMode: "isolated" | "inherited" | "lane";
  task: string;
  tools: string[];
  outputPreview?: string;
  sessionFile?: string;
  status: AgentRunStatus;
  fallbackReason?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentSnapshot {
  enabled: boolean;
  projectTrusted: boolean;
  recovery: boolean;
  limits: { maxDepth: number; maxAgentsPerTree: number; maxConcurrency: number };
  pools: ResolvedAgentModelPool[];
  active: AgentRunSnapshot[];
  recent: AgentRunSnapshot[];
  teammates: Array<
    TeammateDefinition & {
      activeLanes: string[];
      stickyFallback: boolean;
    }
  >;
  diagnostic?: string;
}

export interface AgentStatusEvent {
  run: AgentRunSnapshot;
  fallbackNotice?: string;
}
