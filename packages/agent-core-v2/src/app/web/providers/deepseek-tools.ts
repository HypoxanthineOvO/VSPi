import { z } from 'zod';
import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';
import type { DeepSeekServiceConfig } from '#/app/auth/configSection';
import { Error2, ErrorCodes } from '#/errors';
import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../tools/fetch-url-types';

const SearchResponseSchema = z.object({ results: z.array(z.object({
  title: z.string(), url: z.url(), snippet: z.string(), date: z.string().nullable().optional(),
})) });
const FetchResponseSchema = z.object({ title: z.string(), content: z.string() });
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

class DeepSeekToolsClient {
  constructor(private readonly config: DeepSeekServiceConfig, private readonly operation: 'search' | 'fetch') {}

  async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const apiKey = (this.config.apiKeyEnv === undefined ? this.config.apiKey : process.env[this.config.apiKeyEnv])?.trim();
    if (!apiKey) throw new Error2(ErrorCodes.AUTH_TOKEN_MISSING, `DeepSeek ${this.operation} requires its own services credential (api_key or api_key_env).`);
    const endpoint = new URL(this.config.baseUrl ?? `https://api.deepseek.com/v1/tools/${this.operation}`);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'DeepSeek tools endpoint must be HTTP(S), without credentials, query or fragment.');
    const headers = new Headers(this.config.customHeaders);
    headers.set('Authorization', `Bearer ${apiKey}`);
    headers.set('Content-Type', 'application/json');
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 60000);
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'manual',
      headers,
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpFetchError(response.status, `DeepSeek ${this.operation} failed: HTTP ${response.status}.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `DeepSeek ${this.operation} returned an empty response.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'DeepSeek tools response exceeds the 10 MiB limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `DeepSeek ${this.operation} returned invalid JSON.`); }
  }
}

export class DeepSeekWebSearchProvider implements WebSearchProvider {
  private readonly client: DeepSeekToolsClient;
  constructor(private readonly config: DeepSeekServiceConfig & { count?: number }) {
    this.client = new DeepSeekToolsClient(config, 'search');
  }

  async search(query: string, options?: { toolCallId?: string; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    if (Array.from(query).length < 1 || Array.from(query).length > 128)
      throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'DeepSeek Search query must contain 1–128 characters.');
    const parsed = SearchResponseSchema.safeParse(await this.client.request({ query, count: this.config.count ?? 10 }, options?.signal));
    if (!parsed.success) throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'DeepSeek Search returned an invalid results payload.');
    return parsed.data.results.map(result => ({ title: result.title, url: result.url, snippet: result.snippet, date: result.date ?? undefined }));
  }
}

export class DeepSeekFetchURLProvider implements UrlFetcher {
  private readonly client: DeepSeekToolsClient;
  constructor(config: DeepSeekServiceConfig) { this.client = new DeepSeekToolsClient(config, 'fetch'); }

  async fetch(url: string, options?: { toolCallId?: string; signal?: AbortSignal }): Promise<UrlFetchResult> {
    let target: URL;
    try { target = new URL(url); }
    catch { throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'DeepSeek Fetch requires a valid HTTP(S) URL.'); }
    if (url.length > 8192 || !['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'DeepSeek Fetch requires an HTTP(S) URL of at most 8192 characters, without credentials.');
    const parsed = FetchResponseSchema.safeParse(await this.client.request({ url }, options?.signal));
    if (!parsed.success) throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'DeepSeek Fetch returned an invalid page payload.');
    return { content: parsed.data.content, kind: 'extracted' };
  }
}
