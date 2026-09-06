import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EFFORT_LEVELS, type EffortLevel } from "../domain/types.js";
import type { ProviderModelRecord, ProviderRecord } from "./config-service.js";

/**
 * VSPLab 复合中转站的远程模型目录发现。
 *
 * 数据来自两个端点，并行 best-effort 拉取：
 * - `<baseUrl>/models`（标准 OpenAI /v1/models）：模型名单的权威，决定存在性；
 * - `<origin>/vsp/models`（中转站自有非标准接口，公开静态 JSON）：按 id 补强标准接口
 *   不携带的元数据——reasoning/effort（thinkingLevelMap）、定价（cost）、输入能力、
 *   上下文规格。没有它，远程优先合并会把 effort 选项与定价抹掉。
 *
 * 设计目标：名单与规格（名称、上下文、输出上限、effort、定价）由中转站维护并优先采用；
 * VSPi 内置目录退化为 fallback（中转站未登记时仍可用）与调用兼容性来源
 * （api/baseUrl/inheritFrom/compat 等远程无从知晓的字段完全由本地决定）。
 * 发现是 best-effort：无凭据、网络失败、超时、响应异常都静默回退到内置目录，
 * 绝不阻塞或阻断启动；/vsp/models 失败只丢元数据增强，不影响名单发现。
 */

/** 远程目录单个模型条目（仅携带动态事实字段；除 id 外全部可选，缺省即“未知”）。 */
export interface RemoteModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<EffortLevel, string | null>>;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

function firstBoolean(...values: readonly unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/** cost 单位：美元 / 百万 token；input/output 任一存在即认定有效，缺省项按 0 计。 */
function parseRemoteCost(value: unknown): RemoteModelInfo["cost"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const input = firstNumber(record.input, record.input_usd_per_million);
  const output = firstNumber(record.output, record.output_usd_per_million);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: firstNumber(record.cacheRead, record.cache_read) ?? 0,
    cacheWrite: firstNumber(record.cacheWrite, record.cache_write) ?? 0,
  };
}

/** 只保留合法档位的 thinking 映射（值 string=上游取值、null=显式禁用）；空映射视为未提供。 */
function parseRemoteThinkingLevelMap(value: unknown): RemoteModelInfo["thinkingLevelMap"] {
  if (typeof value !== "object" || value === null) return undefined;
  const result: NonNullable<RemoteModelInfo["thinkingLevelMap"]> = {};
  for (const [level, mapped] of Object.entries(value as Record<string, unknown>)) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) continue;
    if (typeof mapped === "string" || mapped === null) result[level as EffortLevel] = mapped;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseRemoteInput(value: unknown): RemoteModelInfo["input"] {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
  if (items.length === 0) return undefined;
  return items.includes("text") ? items : ["text", ...items];
}

/**
 * 解析中转站 /v1/models 或 /vsp/models 响应。兼容 OpenAI `data[]` 风格与 `{models:[]}` 风格；
 * 条目可以是纯 id 字符串或对象；无法识别的条目与字段静默跳过。
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
    const input = parseRemoteInput(record.input);
    const reasoning = firstBoolean(record.reasoning, record.supports_reasoning);
    const thinkingLevelMap = parseRemoteThinkingLevelMap(record.thinkingLevelMap ?? record.thinking_level_map);
    const cost = parseRemoteCost(record.cost);
    models.push({
      id,
      ...(name !== undefined ? { name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
      ...(cost !== undefined ? { cost } : {}),
    });
  }
  return models;
}

/** 非标准元数据端点：baseUrl 去掉末尾 `/v1` 段后拼 `/vsp/models`（如 …/v1 → …/vsp/models）。 */
function metadataEndpointUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/vsp/models`;
}

/**
 * /vsp/models 元数据只补强 /models 名单内的条目：名单是模型存在性的权威，
 * 元数据登记了名单外的 id 时不新增模型（中转站可能登记了尚未上线的条目）。
 */
function applyModelMetadata(
  roster: readonly RemoteModelInfo[],
  metadata: readonly RemoteModelInfo[],
): RemoteModelInfo[] {
  if (metadata.length === 0) return [...roster];
  const metadataById = new Map(metadata.map((entry) => [entry.id, entry]));
  return roster.map((entry) => {
    const extra = metadataById.get(entry.id);
    return extra ? { ...entry, ...remoteSpecOverrides(extra) } : entry;
  });
}

/** 远程条目中已声明的字段（远程优先），供合并时展开覆盖；未声明字段不覆盖本地值。 */
function remoteSpecOverrides(entry: RemoteModelInfo) {
  return {
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.input !== undefined ? { input: [...entry.input] } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(entry.thinkingLevelMap !== undefined ? { thinkingLevelMap: { ...entry.thinkingLevelMap } } : {}),
    ...(entry.cost !== undefined ? { cost: { ...entry.cost } } : {}),
  };
}

/**
 * Best-effort 拉取中转站模型目录；任何失败都不 throw，由调用方回退到本地目录。
 * 名单（/models，带凭据）与元数据（/vsp/models，公开）共享超时并行拉取；
 * /vsp/models 失败只丢元数据增强，不影响名单发现的结果与错误语义。
 */
export async function fetchRemoteCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<RemoteCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestJson = async (url: string, headers: Record<string, string>): Promise<unknown> => {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  try {
    const [roster, metadata] = await Promise.all([
      requestJson(`${baseUrl.replace(/\/+$/, "")}/models`, {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      })
        .then((payload) => parseRemoteCatalog(payload))
        .catch((error: unknown) => {
          throw controller.signal.aborted
            ? new Error(`timeout after ${timeoutMs}ms`)
            : error instanceof Error
              ? error
              : new Error(String(error));
        }),
      requestJson(metadataEndpointUrl(baseUrl), { Accept: "application/json" })
        .then((payload) => parseRemoteCatalog(payload))
        .catch(() => [] as RemoteModelInfo[]),
    ]);
    return { models: applyModelMetadata(roster, metadata), error: undefined };
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
 * - 规格（name/contextWindow/maxTokens/input）与能力成本（reasoning/
 *   thinkingLevelMap/cost，通常来自 /vsp/models 元数据）：远程声明的字段优先，
 *   未声明的字段保留本地值（含 inheritFrom 继承结果）。
 * - 调用兼容性（api/baseUrl/inheritFrom/compat/headers）：完全继承本地条目。
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
    const overrides = remoteSpecOverrides(entry);
    if (!fallback) {
      merged.push({ id: entry.id, name: entry.name ?? entry.id, ...overrides });
      continue;
    }
    merged.push({ ...fallback, ...overrides });
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
