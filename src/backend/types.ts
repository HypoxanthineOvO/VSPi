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
import type {
  ExternalSessionPreview,
  ExternalSessionSource,
  ExternalSessionSummary,
} from "../sessions/external-history.js";

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
  onSessionWait?: (waiting: boolean) => void;
  onHandoffPending?: () => void;
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
  listExternalSessions?(options?: {
    source?: ExternalSessionSource;
    query?: string;
    limit?: number;
  }): Promise<ExternalSessionSummary[]>;
  previewExternalSession?(id: string): Promise<ExternalSessionPreview>;
  importExternalSession?(id: string, expectedFingerprint: string): Promise<void>;
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
  loginProvider?(providerId: string, type: "api_key" | "oauth", interaction: ProviderAuthInteraction): Promise<void>;
  logoutProvider?(providerId: string): Promise<void>;
  dispose(): Promise<void>;
}
