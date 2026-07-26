import { createHash } from "node:crypto";
import type { ProviderModelRecord, SupportedProviderApi } from "./config-service.js";

export interface CustomProviderDraft {
  name: string;
  baseUrl: string;
  protocol: SupportedProviderApi;
  apiKey: string;
}

export function customProviderId(name: string, baseUrl: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const identity = createHash("sha256").update(`${name}\n${baseUrl}`).digest("hex").slice(0, 8);
  return slug ? `custom-${slug}-${identity}` : `custom-${identity}`;
}

export async function discoverProviderModels(
  draft: CustomProviderDraft,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ProviderModelRecord[]> {
  const fetcher = options.fetch ?? fetch;
  const endpoint = modelListEndpoint(draft.baseUrl);
  const response = await fetcher(endpoint, {
    headers: discoveryHeaders(draft.protocol, draft.apiKey),
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
  const body: unknown = await response.json();
  const entries = modelEntries(body);
  const models = new Map<string, ProviderModelRecord>();
  for (const entry of entries) {
    const id = modelId(entry);
    if (!id || models.has(id)) continue;
    models.set(id, {
      id,
      name: modelName(entry, id),
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    if (models.size >= 200) break;
  }
  if (models.size === 0) throw new Error("接口没有返回可识别的模型 ID");
  return [...models.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function modelsFromManualInput(value: string): ProviderModelRecord[] {
  const ids = value
    .split(/[，,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(ids)].map((id) => ({
    id,
    name: id,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
  }));
}

function modelListEndpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL 只支持 HTTP(S)");
  if (url.username || url.password) throw new Error("Base URL 不能包含账号或密码");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL("models", url);
}

function discoveryHeaders(protocol: SupportedProviderApi, apiKey: string): Record<string, string> {
  if (protocol === "anthropic-messages") {
    return { Accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey };
  }
  if (protocol === "google-generative-ai") {
    return { Accept: "application/json", "x-goog-api-key": apiKey };
  }
  return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}

function modelEntries(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const candidates = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : [];
  return candidates.filter(isRecord);
}

function modelId(value: Record<string, unknown>): string | undefined {
  const raw = typeof value.id === "string" ? value.id : typeof value.name === "string" ? value.name : undefined;
  return raw?.replace(/^models\//u, "").trim() || undefined;
}

function modelName(value: Record<string, unknown>, fallback: string): string {
  const name = value.display_name ?? value.displayName ?? value.name;
  return typeof name === "string" ? name.replace(/^models\//u, "").trim() || fallback : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
