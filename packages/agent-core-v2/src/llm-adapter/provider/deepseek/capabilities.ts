import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ChatProviderError } from '#/llm-adapter/contract/errors';
import type { Protocol } from '#/llm-adapter/protocol/protocol';

export const DeepSeekConfigSchema = z.object({
  nativeMessages: z.boolean().optional(),
  systemPromptUpdate: z.enum(['leading-only', 'in-history']).optional(),
  toolUpdate: z.enum(['none', 'addition-only', 'in-history']).optional(),
}).strict();

export type DeepSeekConfig = z.infer<typeof DeepSeekConfigSchema>;

export interface DeepSeekCapabilities {
  readonly nativeMessages: boolean;
  readonly systemPromptUpdate: 'leading-only' | 'in-history';
  readonly toolUpdate: 'none' | 'addition-only' | 'in-history';
  readonly thinkingReplay: 'reasoning-content' | 'signed';
}

export interface DeepSeekRoute {
  readonly protocol: Protocol;
  readonly modelName: string;
  readonly providerType?: string;
  readonly providerName?: string;
  readonly baseUrl?: string;
}

export function deepSeekBaseUrl(route: DeepSeekRoute): string | undefined {
  if (route.protocol !== 'anthropic' || route.providerType !== 'deepseek') return route.baseUrl;
  const url = new URL(route.baseUrl ?? 'https://api.deepseek.com/anthropic');
  if (url.hostname === 'api.deepseek.com' && ['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    url.pathname = '/anthropic';
    return url.href.replace(/\/$/, '');
  }
  return route.baseUrl ?? 'https://api.deepseek.com/anthropic';
}

export function resolveDeepSeekCapabilities(route: DeepSeekRoute, config?: DeepSeekConfig): DeepSeekCapabilities {
  const parsed = DeepSeekConfigSchema.parse(config ?? {});
  const baseUrl = deepSeekBaseUrl(route);
  const url = new URL(route.providerType === 'deepseek' || parsed.nativeMessages === true ? baseUrl ?? 'https://example.invalid' : 'https://example.invalid');
  const official = route.providerType === 'deepseek' && url.protocol === 'https:' &&
    url.hostname === 'api.deepseek.com' && /^\/anthropic(?:\/v1)?\/?$/.test(url.pathname);
  const nativeMessages = parsed.nativeMessages ?? (route.protocol === 'anthropic' && official);
  if (nativeMessages && route.protocol !== 'anthropic')
    throw new ChatProviderError('DeepSeek native_messages requires protocol = "anthropic". OpenAI-compatible relays keep their existing protocol.');
  if (nativeMessages && (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)))
    throw new ChatProviderError('DeepSeek Messages requires an HTTP(S) endpoint without URL credentials, query or fragment.');
  if (!nativeMessages && (parsed.systemPromptUpdate !== undefined || parsed.toolUpdate !== undefined))
    throw new ChatProviderError('DeepSeek system/tool update capabilities require native_messages = true.');
  const flash = /^(?:deepseek-flash|deepseek-v4\.1-flash)$/.test(route.modelName.split('/').at(-1) ?? '');
  const systemPromptUpdate = nativeMessages ? parsed.systemPromptUpdate ?? (official && flash ? 'in-history' : 'leading-only') : 'leading-only';
  const toolUpdate = nativeMessages ? parsed.toolUpdate ?? (official && flash ? 'addition-only' : 'none') : 'none';
  if (toolUpdate !== 'none' && systemPromptUpdate !== 'in-history')
    throw new ChatProviderError('DeepSeek tool updates require system_prompt_update = "in-history".');
  return {
    nativeMessages,
    systemPromptUpdate,
    toolUpdate,
    thinkingReplay: nativeMessages ? 'signed' : 'reasoning-content',
  };
}

export function deepSeekRouteIdentity(route: DeepSeekRoute): string {
  const url = deepSeekBaseUrl(route)?.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  return createHash('sha256').update(JSON.stringify([route.providerName ?? route.providerType, route.protocol, route.modelName, url])).digest('hex');
}
