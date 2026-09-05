import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProviderModelRecord, ProviderRecord } from "./config-service.js";

/**
 * VSPLab 复合中转站的远程模型目录发现。
 *
 * 设计目标：模型名单与规格（名称、上下文、输出上限）由中转站维护并优先采用；
 * VSPi 内置目录退化为 fallback（中转站未登记时仍可用）与调用兼容性来源
 * （api/baseUrl/inheritFrom/compat 等远程无从知晓的字段完全由本地决定）。
 * 发现是 best-effort：无凭据、网络失败、超时、响应异常都静默回退到内置目录，
 * 绝不阻塞或阻断启动。
 */

/** 服务端 /v1/models 返回的单个模型条目（仅携带动态事实字段）。 */
export interface RemoteModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface RemoteCatalogResult {
  models: RemoteModelInfo[];
  /** fetch 或解析失败原因；成功时为 undefined。 */
  error?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 4_000;

function firstNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * 解析中转站 /v1/models 响应。兼容 OpenAI `data[]` 风格与 `{models:[]}` 风格；
 * 条目可以是纯 id 字符串或对象；无法识别的条目静默跳过。
 */
export function parseRemoteCatalog(payload: unknown): RemoteModelInfo[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? ((payload as { data?: unknown }).data ?? (payload as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) return [];
  const models: RemoteModelInfo[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry.trim()) models.push({ id: entry.trim() });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = firstString(record.id, record.model);
    if (!id) continue;
    const name = firstString(record.name, record.display_name);
    const contextWindow = firstNumber(
      record.context_window,
      record.contextWindow,
      record.max_context_tokens,
      record.context_length,
    );
    const maxTokens = firstNumber(
      record.max_output_tokens,
      record.maxTokens,
      record.max_tokens,
      record.max_completion_tokens,
    );
    models.push({
      id,
      ...(name !== undefined ? { name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  return models;
}

/** Best-effort 拉取中转站模型目录；任何失败都不 throw，由调用方回退到本地目录。 */
export async function fetchRemoteCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<RemoteCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return { models: [], error: `HTTP ${response.status}` };
    return { models: parseRemoteCatalog(await response.json()), error: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { models: [], error: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 合并远程目录与本地 fallback 目录。
 *
 * - 名单：remote ∪ local。远程条目在前（中转站是模型存在性的权威），
 *   本地独有模型按原顺序追加在尾部——中转站短暂缺登记时本地模型不消失。
 * - 规格（name/contextWindow/maxTokens）：远程值优先，远程未提供时保留本地声明。
 * - 调用兼容性（api/baseUrl/inheritFrom/compat/cost 等）：完全继承本地条目。
 * - remote 为 undefined（发现失败或未启用）时原样返回本地目录。
 */
export function mergeRemoteCatalog(
  local: readonly ProviderModelRecord[],
  remote: readonly RemoteModelInfo[] | undefined,
): ProviderModelRecord[] {
  if (!remote) return [...local];
  const localById = new Map(local.map((model) => [model.id, model]));
  const merged: ProviderModelRecord[] = [];
  const seen = new Set<string>();
  for (const entry of remote) {
    seen.add(entry.id);
    const fallback = localById.get(entry.id);
    if (!fallback) {
      merged.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
        ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
      });
      continue;
    }
    merged.push({
      ...fallback,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    });
  }
  for (const model of local) {
    if (!seen.has(model.id)) merged.push(model);
  }
  return merged;
}

async function readProviderApiKey(authPath: string, providerId: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(authPath, "utf8")) as {
      [id: string]: { key?: unknown } | undefined;
    };
    const key = raw[providerId]?.key;
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface EnrichedBuiltinProviders {
  providers: readonly ProviderRecord[];
  /** 远程登记的模型 id（目标 provider 下）；发现被跳过或失败时为空集合。 */
  remoteModelIds: ReadonlySet<string>;
}

/**
 * 用远程目录补强内置复合中转站 provider。只影响内置目录的内存副本，
 * 不写回任何文件；发现失败时原样返回 builtins。remoteModelIds 供可见性
 * 联动使用：中转站登记即视为应展示，不再受 curated 家族正则限制。
 */
export async function enrichBuiltinProvidersWithRemoteCatalog(
  builtins: readonly ProviderRecord[],
  options: { authPath?: string; timeoutMs?: number; fetchImpl?: typeof fetch; providerId?: string } = {},
): Promise<EnrichedBuiltinProviders> {
  const providerId = options.providerId ?? "vsplab";
  const fallback: EnrichedBuiltinProviders = { providers: builtins, remoteModelIds: new Set<string>() };
  const provider = builtins.find((item) => item.id === providerId);
  if (!provider?.baseUrl) return fallback;
  const apiKey = await readProviderApiKey(options.authPath ?? join(getAgentDir(), "auth.json"), providerId);
  // 未配置凭据 = provider 未启用；跳过发现避免每次启动都白发一次注定 401 的请求。
  if (!apiKey) return fallback;
  const result = await fetchRemoteCatalog(provider.baseUrl, apiKey, options);
  if (result.error !== undefined || result.models.length === 0) return fallback;
  return {
    providers: builtins.map((item) =>
      item.id === providerId ? { ...item, models: mergeRemoteCatalog(item.models, result.models) } : item,
    ),
    remoteModelIds: new Set(result.models.map((model) => model.id)),
  };
}
