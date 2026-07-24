export type ProviderProtocol =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative-ai";

export type ProtocolProbeMode = "check-config" | "test-connection" | "minimal-generation";

export interface ProtocolProbeOptions {
  api: ProviderProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  mode: ProtocolProbeMode;
  confirmCost?: () => Promise<boolean>;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface ProtocolProbeResult {
  ok: boolean;
  diagnostic: string;
}

export async function runProtocolProbe(options: ProtocolProbeOptions): Promise<ProtocolProbeResult> {
  const baseUrl = validateProbeOptions(options);
  if (options.mode === "check-config") return { ok: true, diagnostic: "配置结构有效；未发起网络请求" };
  if (options.mode === "minimal-generation") {
    if (!options.confirmCost) return { ok: false, diagnostic: "minimal-generation 需要显式费用确认" };
    if ((await options.confirmCost()) !== true) return { ok: false, diagnostic: "用户取消了最小生成测试" };
  }

  const request = buildRequest(options, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, diagnostic: `${options.mode} 成功（HTTP ${response.status}）` };
    const body = await response.text();
    return {
      ok: false,
      diagnostic: redact(`HTTP ${response.status}: ${boundedError(body)}`, options.apiKey),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "网络请求失败";
    return { ok: false, diagnostic: redact(detail, options.apiKey) };
  } finally {
    clearTimeout(timer);
  }
}

function validateProbeOptions(options: ProtocolProbeOptions): URL {
  if (!options.model.trim()) throw new Error("model 不能为空");
  if (options.mode !== "check-config" && !options.apiKey) throw new Error("credential 未配置");
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new Error("baseUrl 必须是有效 URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("baseUrl 只允许无凭据 HTTP(S) URL");
  }
  return url;
}

function buildRequest(
  options: ProtocolProbeOptions,
  baseUrl: URL,
): { url: URL; method: "GET" | "POST"; headers: Record<string, string>; body?: Record<string, unknown> } {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.api === "anthropic-messages") {
    headers["x-api-key"] = options.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (options.api === "google-generative-ai") headers["x-goog-api-key"] = options.apiKey;
  else headers.authorization = `Bearer ${options.apiKey}`;

  if (options.mode === "test-connection") {
    const endpoint = options.api === "google-generative-ai" ? "/v1beta/models" : "/v1/models";
    return { url: endpointUrl(baseUrl, endpoint), method: "GET", headers };
  }

  headers["content-type"] = "application/json";
  if (options.api === "openai-responses") {
    return {
      url: endpointUrl(baseUrl, "/v1/responses"),
      method: "POST",
      headers,
      body: { model: options.model, input: "Reply OK", max_output_tokens: 1 },
    };
  }
  if (options.api === "openai-completions") {
    return {
      url: endpointUrl(baseUrl, "/v1/chat/completions"),
      method: "POST",
      headers,
      body: { model: options.model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 1 },
    };
  }
  if (options.api === "anthropic-messages") {
    return {
      url: endpointUrl(baseUrl, "/v1/messages"),
      method: "POST",
      headers,
      body: { model: options.model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 1 },
    };
  }
  return {
    url: endpointUrl(baseUrl, `/v1beta/models/${encodeURIComponent(options.model)}:generateContent`),
    method: "POST",
    headers,
    body: { contents: [{ parts: [{ text: "Reply OK" }] }], generationConfig: { maxOutputTokens: 1 } },
  };
}

function endpointUrl(baseUrl: URL, endpoint: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const endpointPath = basePath.endsWith("/v1") && endpoint.startsWith("/v1/") ? endpoint.slice(3) : endpoint;
  url.pathname = `${basePath}${endpointPath}`.replace(/\/+/g, "/");
  url.search = "";
  url.hash = "";
  return url;
}

function boundedError(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
        return (error as { message: string }).message.slice(0, 500);
      }
    }
  } catch {
    // Plain-text errors are bounded below.
  }
  return body.slice(0, 500) || "请求被拒绝";
}

function redact(value: string, apiKey: string): string {
  const exact = apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  return exact
    .replace(/\b(?:sk|pk|api)[-_][a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/((?:authorization|x-api-key|token|secret|password|credential)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}
