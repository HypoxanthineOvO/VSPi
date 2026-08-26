import type { ProviderModelRecord, ProviderRecord } from "./config-service.js";

/**
 * 出厂内置 Provider。只包含公开元数据（baseUrl、协议、模型目录），
 * 绝不包含 credential；API key 通过 `$<ID>_API_KEY` 环境变量引用注入。
 */

/**
 * VSPLab 中转站（VSP Open）复合模型目录，覆盖国产模型与海外模型。
 *
 * - 协议：GPT / DeepSeek / GLM 走 `openai-responses`（provider 默认，中转站原生支持）；
 *   Kimi 家族走 `openai-completions`（per-model `api` 覆盖）；
 *   Claude 家族走 `anthropic-messages`，且 baseUrl 去掉 `/v1` 后缀——
 *   Anthropic SDK 会在 baseUrl 后自行拼接 `/v1/messages`，保留 `/v1` 会得到 `/v1/v1/messages`。
 * - 元数据：能对上 Pi 上游目录的模型通过 per-model `inheritFrom` 按模型继承共享规格
 *   （contextWindow、maxTokens、input 能力、reasoning、thinking map、cost）；
 *   对不上的模型不继承、不手抄，保持运行时默认（128K / 8192），避免规格漂移。
 */
const VSPLAB_MODELS: ProviderModelRecord[] = [
  // GLM（智谱）
  { id: "glm-5.3", name: "GLM 5.3", inheritFrom: "zai" },
  { id: "glm-5.2", name: "GLM 5.2", inheritFrom: "zai" },
  { id: "glm-5.1", name: "GLM 5.1", inheritFrom: "zai-coding-cn" },
  { id: "glm-5", name: "GLM 5" },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", inheritFrom: "zai" },
  { id: "glm-4.7", name: "GLM 4.7", inheritFrom: "zai" },
  { id: "glm-4.6", name: "GLM 4.6" },
  { id: "glm-4.5", name: "GLM 4.5" },
  { id: "glm-4.5-air", name: "GLM 4.5 Air" },
  // Kimi（月之暗面）
  { id: "kimi-for-coding", name: "Kimi For Coding", api: "openai-completions", inheritFrom: "kimi-coding" },
  {
    id: "kimi-for-coding-highspeed",
    name: "Kimi For Coding Highspeed",
    api: "openai-completions",
    inheritFrom: "kimi-coding",
  },
  { id: "k3", name: "Kimi K3", api: "openai-completions", inheritFrom: "kimi-coding" },
  { id: "k3-256k", name: "Kimi K3 256K", api: "openai-completions", inheritFrom: "kimi-coding" },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "openai-completions", inheritFrom: "moonshotai" },
  // DeepSeek
  { id: "deepseek-chat", name: "DeepSeek Chat" },
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", inheritFrom: "deepseek" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", inheritFrom: "deepseek" },
  // GPT（OpenAI）
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", inheritFrom: "openai-codex" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", inheritFrom: "openai-codex" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", inheritFrom: "openai-codex" },
  { id: "gpt-5.5", name: "GPT-5.5", inheritFrom: "openai-codex" },
  { id: "gpt-5.4", name: "GPT-5.4", inheritFrom: "openai-codex" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", inheritFrom: "openai-codex" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
  // Claude（Anthropic）
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    api: "anthropic-messages",
    baseUrl: "https://api.vsplab.cn",
    inheritFrom: "anthropic",
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    api: "anthropic-messages",
    baseUrl: "https://api.vsplab.cn",
    inheritFrom: "anthropic",
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    api: "anthropic-messages",
    baseUrl: "https://api.vsplab.cn",
    inheritFrom: "anthropic",
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    baseUrl: "https://api.vsplab.cn",
    inheritFrom: "anthropic",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    baseUrl: "https://api.vsplab.cn",
    inheritFrom: "anthropic",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    baseUrl: "https://api.vsplab.cn",
    inheritFrom: "anthropic",
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    api: "anthropic-messages",
    baseUrl: "https://api.vsplab.cn",
    inheritFrom: "anthropic",
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
