import type { AgentOverrideScope, AgentRole, AgentSnapshot } from "../agents/types.js";
import type { CompactOptions } from "../continuity/compaction-profiles.js";
import type { CronTask } from "../cron/types.js";
import type {
  Attachment,
  EffortLevel,
  ModelGroup,
  ModelOption,
  ProviderOption,
  Question,
  SessionOption,
  TranscriptMessage,
  UsageSnapshot,
} from "../domain/types.js";
import type { GoalBinding, GoalLimits, StoredGoal } from "../goals/types.js";
import type { PlanBinding } from "../plans/types.js";
import type { ApprovalRequest, ApprovalResponse, PolicyLevel, PolicySnapshot } from "../policy/execution-policy.js";
import type { EffectivePromptSegment } from "../prompts/effective-prompt.js";
import type {
  ExternalSessionPreview,
  ExternalSessionSource,
  ExternalSessionSummary,
} from "../sessions/external-history.js";
import type { SessionLeaseOwner } from "../sessions/lease.js";
import type { SkillCatalogSnapshot, SkillInstallResult, SkillManager, SkillScope } from "../skills/types.js";
import type { WorkflowSnapshot } from "../workflow/types.js";
export type SessionOwnerRecoveryAction = "terminate" | "kill" | "cancel";

export interface RuntimeModelOption extends ModelOption {
  provider: string;
  contextWindow: number;
}

export interface ModelSelectionResult {
  modelId: string;
  vision: boolean;
  contextWindow: number;
  profileModelId: string;
  effort: EffortLevel;
}

export type ProviderProbeMode = "check-config" | "test-connection" | "minimal-generation";

export type ProviderAuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
      signal?: AbortSignal;
    };

export type ProviderAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface ProviderAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: ProviderAuthPrompt): Promise<string>;
  notify(event: ProviderAuthEvent): void;
}

export type SessionHandoffInteraction =
  | { kind: "question"; questions: Question[] }
  | { kind: "approval"; request: ApprovalRequest };

export type SessionHandoffResponse =
  | { kind: "question"; questions: Question[] }
  | { kind: "approval"; response: ApprovalResponse };

export type SessionHandoffProjection =
  | { kind: "snapshot-start" }
  | { kind: "snapshot-message"; message: TranscriptMessage }
  | {
      kind: "snapshot-state";
      modelLabel: string;
      modelId: string;
      modelProvider?: string;
      supportsVision: boolean;
      effort: EffortLevel;
      usage: UsageSnapshot;
      queue: ChatQueueState;
      busy: boolean;
    }
  | { kind: "message"; message: TranscriptMessage }
  | { kind: "message-update"; id: string; patch: Partial<TranscriptMessage> }
  | { kind: "busy"; busy: boolean }
  | { kind: "queue"; queue: ChatQueueState }
  | { kind: "usage"; usage: UsageSnapshot }
  | { kind: "queued-consumed"; id: string }
  | { kind: "notice"; message: string; tone: "info" | "success" | "warning" | "error" };

export interface SessionHandoffRelay {
  request(interaction: SessionHandoffInteraction): Promise<SessionHandoffResponse>;
  project(projection: SessionHandoffProjection): void;
}

export interface ChatBackendEvents {
  onMessage: (message: TranscriptMessage) => void;
  onMessageUpdate: (id: string, patch: Partial<TranscriptMessage>) => void;
  onBusy: (busy: boolean) => void;
  onQueueUpdate?: (queue: ChatQueueState) => void;
  onUsage: (usage: UsageSnapshot) => void;
  onNotice: (message: string, tone: "info" | "success" | "warning" | "error") => void;
  onSessionInvalidating?: () => void;
  onSessionReset?: (session: SessionReset) => void;
  onQuestion?: (questions: Question[], signal?: AbortSignal) => Promise<Question[]>;
  onPlanBindingChange?: (binding: PlanBinding | undefined) => void;
  onGoalChange?: (goal: StoredGoal | undefined) => void;
  onEffectivePrompt?: (segments: EffectivePromptSegment[]) => void;
  onWorkflowSnapshot?: (snapshot: WorkflowSnapshot) => void;
  onAgentSnapshot?: (snapshot: AgentSnapshot) => void;
  onCronSnapshot?: (tasks: readonly CronTask[]) => void;
  onSessionWait?: (waiting: boolean) => void;
  onSessionReady?: () => void;
  onSessionError?: (error: Error) => void;
  onSessionOwnerRecovery?: (
    owner: SessionLeaseOwner,
    phase: "terminate" | "kill",
  ) => Promise<SessionOwnerRecoveryAction>;
  onHandoffInteraction?: (
    interaction: SessionHandoffInteraction,
    signal?: AbortSignal,
  ) => Promise<SessionHandoffResponse>;
  onHandoffProjection?: (projection: SessionHandoffProjection) => void;
  onHandoffPending?: (relay: SessionHandoffRelay) => void;
  onHandoffCancelled?: () => void;
  onTakeover?: () => void;
}

export interface ChatQueueState {
  steering: number;
  followUp: number;
}

export type SessionResetReason = "startup" | "new" | "resume" | "fork" | "import";

export interface SessionReset {
  id: string;
  reason: SessionResetReason;
  continuePlan?: boolean;
}

export interface NewSessionOptions {
  defaults: boolean;
  continuePlan: boolean;
}

export interface SendResult {
  status: "completed" | "cancelled" | "queued";
  delivery?: "steer" | "followUp";
}

export interface CancelResult {
  queuedMessages: string[];
}

export interface SendOptions {
  attachments: Attachment[];
  effort: EffortLevel;
  behavior: "prompt" | "followUp";
  clientMessageId?: string;
}

export interface ChatBackend {
  readonly kind: "fixture" | "pi";
  readonly modelLabel: string;
  readonly modelId: string;
  readonly modelProvider?: string | undefined;
  readonly supportsVision: boolean;
  isSessionReady?(): boolean;
  start(events: ChatBackendEvents): Promise<void>;
  // Existing extension backends may not report a result; VSPi backends return SendResult.
  // biome-ignore lint/suspicious/noConfusingVoidType: void preserves the public backend compatibility contract.
  send(text: string, options: SendOptions): Promise<void | SendResult>;
  // biome-ignore lint/suspicious/noConfusingVoidType: void preserves extension backend compatibility.
  cancel(): Promise<void | CancelResult>;
  compact(options?: CompactOptions): Promise<void>;
  abortCompaction?(): void;
  newSession(options?: NewSessionOptions): Promise<void>;
  listSessions(): Promise<SessionOption[]>;
  switchSession(id: string): Promise<void>;
  consumeResolvedModelFallback?(): boolean;
  forkSession?(id: string): Promise<void>;
  listExternalSessions?(options?: {
    source?: ExternalSessionSource;
    query?: string;
    limit?: number;
  }): Promise<ExternalSessionSummary[]>;
  previewExternalSession?(id: string): Promise<ExternalSessionPreview>;
  importExternalSession?(id: string, expectedFingerprint: string): Promise<void>;
  listSkills?(): Promise<SkillCatalogSnapshot>;
  installSkill?(source: string, scope: SkillScope, enable: boolean): Promise<SkillInstallResult>;
  setSkillEnabled?(id: string, enabled: boolean, scope?: SkillScope): Promise<void>;
  updateSkill?(id: string): Promise<void>;
  removeSkill?(id: string): Promise<void>;
  getPlanBinding?(): PlanBinding | undefined;
  bindPlan?(planId: string | undefined): Promise<void>;
  getGoalBinding?(): GoalBinding | undefined;
  getGoal?(): Promise<StoredGoal | undefined>;
  createGoal?(request: string, limits?: Partial<GoalLimits>): Promise<StoredGoal>;
  pauseGoal?(): Promise<StoredGoal>;
  resumeGoal?(): Promise<StoredGoal>;
  cancelGoal?(): Promise<StoredGoal>;
  acceptGoal?(): Promise<StoredGoal>;
  getEffectivePromptSegments?(): EffectivePromptSegment[];
  getModelOptions?(): Promise<RuntimeModelOption[]>;
  getModelGroups?(): Promise<ModelGroup[]>;
  getProviderOptions?(): Promise<ProviderOption[]>;
  selectModel?(provider: string, id: string): Promise<ModelSelectionResult>;
  getEffortOptions?(): Promise<EffortLevel[]>;
  setEffort?(level: EffortLevel): Promise<void>;
  setPolicy?(policy: PolicyLevel): Promise<PolicySnapshot>;
  getAgentSnapshot?(): AgentSnapshot;
  listCronTasks?(): readonly CronTask[];
  createCronTask?(
    input: { cron: string; prompt: string; recurring?: boolean } | { runAt: number; prompt: string },
  ): Promise<CronTask>;
  deleteCronTask?(id: string): Promise<boolean>;
  switchTeammateModel?(id: string, model: string): Promise<void>;
  resetTeammateLane?(id: string, lane?: string): Promise<void>;
  overrideRequiredTeammate?(id: string, scope: AgentOverrideScope): Promise<void>;
  setAgentPoolRole?(provider: string, role: AgentRole, model: string): Promise<void>;
  isProjectTrusted?(): boolean;
  runProviderProbe?(
    providerId: string,
    mode: ProviderProbeMode,
    confirmCost?: () => Promise<boolean>,
  ): Promise<{ ok: boolean; diagnostic: string }>;
  loginProvider?(providerId: string, type: "api_key" | "oauth", interaction: ProviderAuthInteraction): Promise<void>;
  logoutProvider?(providerId: string): Promise<void>;
  dispose(): Promise<void>;
}

export type { SkillManager };
