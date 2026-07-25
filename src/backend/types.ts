import type { CompactOptions } from "../continuity/compaction-profiles.js";
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
import type { PlanBinding } from "../plans/types.js";
import type { EffectivePromptSegment } from "../prompts/effective-prompt.js";

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
  onEffectivePrompt?: (segments: EffectivePromptSegment[]) => void;
}

export interface ChatQueueState {
  steering: number;
  followUp: number;
}

export type SessionResetReason = "startup" | "new" | "resume" | "fork";

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
}

export interface ChatBackend {
  readonly kind: "fixture" | "pi";
  readonly modelLabel: string;
  readonly modelId: string;
  readonly modelProvider?: string | undefined;
  readonly supportsVision: boolean;
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
  forkSession?(id: string): Promise<void>;
  getPlanBinding?(): PlanBinding | undefined;
  bindPlan?(planId: string | undefined): Promise<void>;
  getEffectivePromptSegments?(): EffectivePromptSegment[];
  getModelOptions?(): Promise<RuntimeModelOption[]>;
  getModelGroups?(): Promise<ModelGroup[]>;
  getProviderOptions?(): Promise<ProviderOption[]>;
  selectModel?(provider: string, id: string): Promise<ModelSelectionResult>;
  getEffortOptions?(): Promise<EffortLevel[]>;
  setEffort?(level: EffortLevel): Promise<void>;
  isProjectTrusted?(): boolean;
  runProviderProbe?(
    providerId: string,
    mode: ProviderProbeMode,
    confirmCost?: () => Promise<boolean>,
  ): Promise<{ ok: boolean; diagnostic: string }>;
  dispose(): Promise<void>;
}
