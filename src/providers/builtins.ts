import type { ProviderRecord } from "./config-service.js";

/**
 * 出厂内置 Provider。只包含公开元数据（baseUrl、协议、模型目录），
 * 绝不包含 credential；API key 通过 `$<ID>_API_KEY` 环境变量引用注入。
 */

/** VSPLab 中转站模型目录。价格为 OpenAI 官方 USD/1M 刊例（2026-07），如中转站另有定价以实际为准。 */
const VSPLAB_MODELS: ProviderRecord["models"] = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    contextWindow: 1_050_000,
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 },
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    contextWindow: 1_050_000,
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 0 },
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    contextWindow: 1_050_000,
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 1.0, output: 6.0, cacheRead: 0.1, cacheWrite: 0 },
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 1_050_000,
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 },
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 1_050_000,
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 0 },
    maxTokens: 128_000,
  },
];

export const BUILTIN_PROVIDERS: ProviderRecord[] = [
  {
    id: "vsplab",
    name: "VSPLab",
    source: "builtin",
    baseUrl: "https://api.vsplab.cn/v1",
    protocol: "openai-responses",
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
