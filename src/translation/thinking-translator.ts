const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SOURCE_CHARACTERS = 200_000;

export interface ThinkingTranslator {
  translate(text: string, endpoint: string, signal?: AbortSignal): Promise<string>;
}

type TranslationRequest = Record<string, string>;

const REQUEST_FORMATS: TranslationRequest[] = [
  { source: "auto", target: "zh-CN" },
  { source: "auto", target: "zh", format: "text" },
  { source_lang: "auto", target_lang: "ZH" },
];

export function normalizeTranslationEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length > 500) throw new Error("翻译服务地址不能超过 500 个字符");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("翻译服务地址无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("翻译服务只支持 HTTP 或 HTTPS");
  if (url.username || url.password) throw new Error("翻译服务地址不能包含用户名或密码");
  url.hash = "";
  if (url.pathname === "/") url.pathname = "/translate";
  return url.toString();
}

export class HttpThinkingTranslator implements ThinkingTranslator {
  constructor(private readonly request: typeof fetch = fetch) {}

  async translate(text: string, endpoint: string, signal?: AbortSignal): Promise<string> {
    const source = text.trim();
    if (!source) return "";
    if (source.length > MAX_SOURCE_CHARACTERS) throw new Error("待翻译 Thinking 超过 200,000 个字符");
    const url = normalizeTranslationEndpoint(endpoint);
    if (!url) return "";
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("翻译服务响应超时")), REQUEST_TIMEOUT_MS);
    try {
      let lastError: Error | undefined;
      for (const format of REQUEST_FORMATS) {
        const response = await this.request(url, {
          method: "POST",
          headers: { accept: "application/json, text/plain", "content-type": "application/json" },
          body: JSON.stringify(requestBody(source, format)),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`翻译服务返回 HTTP ${response.status}`);
          if ([400, 415, 422].includes(response.status)) {
            lastError = error;
            continue;
          }
          throw error;
        }
        const body = await readLimitedResponse(response);
        const translated = extractTranslation(body);
        if (translated) return translated;
        lastError = new Error("翻译服务没有返回译文");
      }
      throw lastError ?? new Error("翻译服务调用失败");
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError(controller.signal.reason);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function requestBody(text: string, format: TranslationRequest): TranslationRequest {
  if ("source_lang" in format) return { text, ...format };
  if (format.format) return { q: text, ...format };
  return { text, ...format };
}

async function readLimitedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("翻译服务响应超过 1 MiB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("翻译服务响应超过 1 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function extractTranslation(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["translatedText", "translation", "translated_text", "data", "text"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const choices = record.choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return "";
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content.trim() : "";
}

function timeoutError(reason: unknown): Error {
  if (reason instanceof Error && reason.message === "翻译服务响应超时") return reason;
  const error = new Error("翻译服务调用已取消");
  error.name = "AbortError";
  return error;
}
