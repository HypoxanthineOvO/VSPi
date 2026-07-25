export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface UsageSnapshot {
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  currency: "CNY";
  source: string;
  asOf: string;
  fxRate: number;
}

export interface Attachment {
  id: string;
  alias: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
  size: number;
  path: string;
  status: "ready" | "uploading" | "failed";
  error?: string;
}

export interface TextMessage {
  id: string;
  role: "user" | "assistant";
  kind: "text";
  text: string;
  streaming?: boolean;
  attachments?: Attachment[];
  delivery?: "steer" | "followUp" | "cancelled";
}

export interface ThinkingMessage {
  id: string;
  role: "assistant";
  kind: "thinking";
  effort: EffortLevel;
  durationMs?: number;
  text: string;
  collapsed: boolean;
  streaming?: boolean;
}

export interface ToolMessage {
  id: string;
  role: "assistant";
  kind: "tool";
  groupId?: string;
  name: string;
  summary: string;
  status: "queued" | "running" | "success" | "error" | "cancelled";
  output?: string;
  expanded: boolean;
}

export interface SubAgentMessage {
  id: string;
  role: "assistant";
  kind: "subagent";
  model: string;
  effort: EffortLevel;
  task: string;
  status: "queued" | "running" | "success" | "error";
}

export type TranscriptMessage = TextMessage | ThinkingMessage | ToolMessage | SubAgentMessage;

export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ModelOption {
  id: string;
  provider?: string;
  brand: string;
  label: string;
  releasedAt?: string;
  vision: boolean;
  efforts: EffortLevel[];
  price: ModelPrice;
}

export interface ModelGroupRole {
  role: string;
  modelId: string;
  effort: EffortLevel;
}

export interface ModelGroup {
  id: string;
  label: string;
  roles: ModelGroupRole[];
}

export type ProviderStatus = "已配置" | "已验证" | "检测中" | "未配置" | "异常";

export interface ProviderOption {
  id: string;
  label: string;
  protocol: string;
  status: ProviderStatus;
  detail: string;
  baseUrl?: string;
  custom?: boolean;
}

export interface PlanItem {
  id: string;
  label: string;
  status: "done" | "current" | "pending";
  depth: number;
  collapsed?: boolean;
}

export interface SessionOption {
  id: string;
  label: string;
  relativeTime: string;
  branchDepth: number;
  current?: boolean;
}

export type QuestionKind = "singleChoice" | "multiChoice" | "ranking" | "freeText";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  title: string;
  prompt: string;
  kind: QuestionKind;
  options?: QuestionOption[];
  answer?: string | string[];
  skipped?: boolean;
}

export interface AppSettings {
  scope: "global" | "project";
  theme: "VSPi Dark" | "VSPi Light" | "Terminal";
  reducedMotion: boolean;
  thinkingDisplay: "hidden" | "collapsed" | "expanded";
  wrapCode: boolean;
  collapseTools: boolean;
  bridgeEnabled: boolean;
}
