import type { EffortLevel } from "../domain/types.js";

export const AGENT_ROUTING_MODES = [
	"required",
	"preferred",
	"consult",
	"manual",
] as const;
export type AgentRoutingMode = (typeof AGENT_ROUTING_MODES)[number];
export type AgentOverrideScope = "turn" | "session";
export const AGENT_ROLES = [
	"orchestrator",
	"researcher",
	"analyst",
	"worker",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentModelPoolConfig {
	roles: Partial<Record<AgentRole, string>>;
}

export interface ResolvedAgentModelPool {
	provider: string;
	source: "automatic" | "project";
	roles: Record<AgentRole, string>;
}

export const AGENT_RUN_STATUSES = [
	"queued",
	"running",
	"success",
	"error",
	"cancelled",
	"timed_out",
	"killed",
	"lost",
] as const;
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
	maxDepth: number;
	maxAgentsPerTree: number;
	maxConcurrency: number;
	maxRunTokens: number;
	maxTreeTokens: number;
	maxTreeCostUsd: number;
	maxRunSeconds: number;
	allowedModels: string[];
	modelPools: Record<string, AgentModelPoolConfig>;
	crossProviderDelegation: boolean;
	teammates: TeammateDefinition[];
}

export interface AgentRunSnapshot {
	id: string;
	/** Stable child identity. A resumed child gets a new run id but keeps this agent id. */
	agentId: string;
	treeId: string;
	parentId?: string;
	parentToolCallId?: string;
	kind: "task" | "teammate";
	teammateId?: string;
	lane?: string;
	depth: number;
	model: string;
	provider: string;
	role: AgentRole;
	profile: string;
	codename?: string;
	taskTitle?: string;
	modelReason: string;
	preferredModel?: string;
	effort: EffortLevel;
	contextMode: "isolated" | "inherited" | "lane";
	contextChars: number;
	task: string;
	tools: string[];
	outputPreview?: string;
	summary?: string;
	error?: string;
	usage: AgentUsageSnapshot;
	budget: AgentRunBudgetSnapshot;
	timeline: AgentTimelineEvent[];
	status: AgentRunStatus;
	background: boolean;
	resumed: boolean;
	fallbackReason?: string;
	startedAt?: string;
	deadlineAt?: string;
	finishedAt?: string;
	/** 当前正在执行的 tool 名，仅在 run 运行期间由 session 事件刷新。 */
	currentTool?: string;
	/** 最近一次活动（输出增量或 tool 事件）的 ISO 时间戳。 */
	lastActivityAt?: string;
}

export interface AgentUsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface AgentRunBudgetSnapshot {
	runTokensUsed: number;
	maxRunTokens: number;
	treeTokensUsed: number;
	maxTreeTokens: number;
	treeCostUsd: number;
	maxTreeCostUsd: number;
	maxRunSeconds: number;
	/** 警戒线状态：仅用于 UI 标黄提示，不参与任何 runtime 拒绝或作废决策。 */
	warnRunTokens: boolean;
	warnTreeTokens: boolean;
	warnTreeCost: boolean;
	warnElapsed: boolean;
}

export interface AgentTimelineEvent {
	at: string;
	kind:
		| "queued"
		| "started"
		| "fallback"
		| "completed"
		| "failed"
		| "cancelled"
		| "budget";
	summary: string;
}

export interface AgentLaneSnapshot {
	lane: string;
	state: "idle" | "owned" | "waiting" | "blocked";
	owner?: string;
	updatedAt: string;
}

export interface AgentSnapshot {
	enabled: boolean;
	projectTrusted: boolean;
	recovery: boolean;
	limits: {
		maxDepth: number;
		maxAgentsPerTree: number;
		maxConcurrency: number;
		maxRunTokens: number;
		maxTreeTokens: number;
		maxTreeCostUsd: number;
		maxRunSeconds: number;
	};
	pools: ResolvedAgentModelPool[];
	active: AgentRunSnapshot[];
	recent: AgentRunSnapshot[];
	teammates: Array<
		TeammateDefinition & {
			activeLanes: string[];
			lanes: AgentLaneSnapshot[];
			stickyFallback: boolean;
		}
	>;
	authority: {
		pendingRequired: string[];
		turnOverrides: string[];
		sessionOverrides: string[];
		taskEpoch: number;
	};
	diagnostic?: string;
}

export interface AgentStatusEvent {
	run: AgentRunSnapshot;
	fallbackNotice?: string;
}

export interface AgentCompletionEvent {
	taskId: string;
	agentId: string;
	status: "success" | "error" | "cancelled";
	background: true;
	result?: string;
	error?: string;
	run: AgentRunSnapshot;
}
