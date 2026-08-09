import type {
  AppSettings,
  ModelGroup,
  ModelOption,
  PlanItem,
  ProviderOption,
  Question,
  SessionOption,
  UsageSnapshot,
} from "./types.js";

export const FX = { currency: "CNY", source: "中国外汇交易中心参考价", asOf: "2026-07-23", fxRate: 7.18 } as const;

export const MODELS: ModelOption[] = [
  {
    id: "kimi-k2.5",
    brand: "Moonshot",
    label: "Kimi K2.5",
    releasedAt: "2026-06-01",
    vision: true,
    efforts: ["low", "medium", "high"],
    price: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 },
  },
  {
    id: "kimi-k3",
    brand: "Moonshot",
    label: "Kimi K3",
    releasedAt: "2026-07-15",
    vision: true,
    efforts: ["medium", "high"],
    price: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
  },
  {
    id: "gpt-5.4",
    brand: "OpenAI",
    label: "GPT-5.4",
    releasedAt: "2026-06-30",
    vision: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    price: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
  },
  {
    id: "glm-5",
    brand: "智谱",
    label: "GLM-5",
    vision: false,
    efforts: ["low", "medium", "high"],
    price: { inputUsdPerMillion: 0.7, outputUsdPerMillion: 2.8 },
  },
  {
    id: "qwen3-coder",
    brand: "千问",
    label: "Qwen3 Coder",
    vision: false,
    efforts: ["low", "medium"],
    price: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 2 },
  },
  {
    id: "deepseek-v3.2",
    brand: "DeepSeek",
    label: "DeepSeek V3.2",
    releasedAt: "2026-05-12",
    vision: false,
    efforts: ["low", "medium"],
    price: { inputUsdPerMillion: 0.28, outputUsdPerMillion: 0.42 },
  },
];

export const MODEL_GROUPS: ModelGroup[] = [
  {
    id: "auto-safe",
    label: "auto/safe",
    roles: [
      { role: "默认", modelId: "kimi-k3", effort: "medium" },
      { role: "复杂代码", modelId: "gpt-5.4", effort: "high" },
      { role: "总结", modelId: "deepseek-v3.2", effort: "low" },
    ],
  },
];

export const PROVIDERS: ProviderOption[] = [
  { id: "moonshot", label: "Moonshot", protocol: "OpenAI compatible", status: "已验证", detail: "2 个模型" },
  { id: "openai", label: "OpenAI", protocol: "Responses", status: "已配置", detail: "等待连通性检查" },
  { id: "deepseek", label: "DeepSeek", protocol: "OpenAI compatible", status: "已验证", detail: "1 个模型" },
  { id: "zhipu", label: "智谱", protocol: "OpenAI compatible", status: "未配置", detail: "需要 API key" },
  { id: "qwen", label: "千问", protocol: "OpenAI compatible", status: "异常", detail: "上次验证超时" },
  { id: "custom", label: "自定义 Provider", protocol: "Custom", status: "未配置", detail: "添加端点", custom: true },
];

export const PLAN_ITEMS: PlanItem[] = [
  { id: "cover", label: "启动封面", status: "done", depth: 0 },
  { id: "input", label: "输入与状态栏", status: "in_progress", depth: 0 },
  { id: "shape", label: "输入框形态：完整圆角框", status: "done", depth: 1 },
  { id: "placement", label: "确定模型、上下文与路径的位置", status: "in_progress", depth: 1 },
  { id: "wrap", label: "多行增长、滚动与换行", status: "pending", depth: 1 },
  { id: "provider", label: "Provider 选择器", status: "pending", depth: 0 },
];

export const SESSIONS: SessionOption[] = [
  { id: "current", label: "TUI v1 交互打磨", relativeTime: "现在", branchDepth: 0, current: true },
  { id: "layout", label: "布局探索", relativeTime: "昨天", branchDepth: 1 },
  { id: "provider", label: "Provider 调研", relativeTime: "2 天前", branchDepth: 0 },
];

export const QUESTIONS: Question[] = [
  {
    id: "density",
    title: "界面密度",
    prompt: "默认信息密度采用哪一种？",
    kind: "singleChoice",
    options: [
      { id: "compact", label: "紧凑", description: "优先显示更多上下文" },
      { id: "balanced", label: "均衡", description: "密度与留白平衡" },
      { id: "relaxed", label: "舒展", description: "更适合宽终端" },
    ],
  },
  {
    id: "signals",
    title: "状态信号",
    prompt: "哪些状态需要持续显示？",
    kind: "multiChoice",
    options: [
      { id: "context", label: "上下文" },
      { id: "usage", label: "Token" },
      { id: "cost", label: "费用" },
    ],
  },
  {
    id: "priority",
    title: "快捷入口顺序",
    prompt: "拖动不可用时，用上下键调整顺序。",
    kind: "ranking",
    options: [
      { id: "model", label: "模型" },
      { id: "provider", label: "Provider" },
      { id: "session", label: "Sessions" },
    ],
  },
  { id: "note", title: "补充说明", prompt: "还有什么必须保留的细节？", kind: "freeText" },
];

export const DEFAULT_USAGE: UsageSnapshot = {
  contextTokens: 0,
  contextWindow: 0,
  contextPercent: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  currency: "CNY",
  source: FX.source,
  asOf: FX.asOf,
  fxRate: FX.fxRate,
};

export const DEFAULT_SETTINGS: AppSettings = {
  scope: "project",
  theme: "VSPi Dark",
  tuiMode: "fullscreen",
  fullscreenScrollbar: "auto",
  mermaidRendering: "final",
  reducedMotion: false,
  workingStyle: 3,
  thinkingDisplay: "collapsed",
  thinkingTranslationEndpoint: "",
  wrapCode: false,
  collapseTools: true,
  bridgeEnabled: true,
};
