import type { ProviderRecord } from "./config-service.js";

/**
 * 出厂内置 Provider。只包含公开元数据（baseUrl、协议、模型目录），
 * 绝不包含 credential；API key 通过 `$<ID>_API_KEY` 环境变量引用注入。
 */

/**
 * VSPLab 中转站模型目录。模型通用元数据（contextWindow、maxTokens、输入能力、
 * reasoning、thinking map 与成本）在注册时继承 Pi `openai-codex` 目录；
 * VSPLab 只声明模型 identity 与显示名，不再手抄可能漂移的规格。
 * Codex API 通道的 272K 上限由上游目录单一维护。
 */
const VSPLAB_MODELS: ProviderRecord["models"] = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
];

export const BUILTIN_PROVIDERS: ProviderRecord[] = [
  {
    id: "vsplab",
    name: "VSPLab",
    source: "builtin",
    baseUrl: "https://api.vsplab.cn/v1",
    protocol: "openai-responses",
    inheritModelsFrom: "openai-codex",
    models: VSPLAB_MODELS,
  },
];

/**
 * Provider 面板与模型品牌的优先顺序。未列出的 provider 按 label 字母序排在其后。
 * id 对齐 pi 内置 catalog：deepseek / xiaomi(MiMo) / kimi-coding、moonshotai(-cn)(Kimi) /
 * zai、zai-coding-cn(GLM) / minimax(-cn) / openai / anthropic。
 */
export const PROVIDER_PRIORITY: readonly string[] = [
  "vsplab",
  "deepseek",
  "xiaomi",
  "kimi-coding",
  "moonshotai-cn",
  "moonshotai",
  "moonshot",
  "zai",
  "zai-coding-cn",
  "zhipu",
  "minimax",
  "minimax-cn",
  "openai",
  "anthropic",
];

export function providerPriorityIndex(id: string): number {
  const index = PROVIDER_PRIORITY.indexOf(id);
  return index === -1 ? PROVIDER_PRIORITY.length : index;
}

/** 与 PROVIDER_PRIORITY 同序的品牌序（品牌由 formatProviderName 从 provider id/name 派生）。 */
export const BRAND_PRIORITY: readonly string[] = [
  "VSPLab",
  "DeepSeek",
  "Xiaomi",
  "Kimi Coding",
  "Moonshot AI",
  "Moonshot",
  "Zai",
  "Zhipu AI",
  "MiniMax",
  "OpenAI",
  "Anthropic",
];
