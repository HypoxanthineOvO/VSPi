import { normalizeProxyAddress } from '#/_base/utils/proxyAddress';
import type { OAuthNetworkConfig, ProxyConfig } from './configSection';

export function usesAccountProxy(provider: string): boolean {
  return ['openai', 'openai_responses', 'openai-codex', 'anthropic', 'google', 'google-genai', 'google-vertex', 'xai'].includes(provider);
}

export function accountProxyPreference(config: ProxyConfig | undefined, legacy: OAuthNetworkConfig | undefined): string | undefined {
  if (config?.url !== undefined) return config.url === '' ? '' : normalizeProxyAddress(config.url);
  const port = legacy?.openaiProxyPort;
  return port === undefined ? undefined : port === 0 ? '' : `http://127.0.0.1:${port}`;
}

export function accountProxyForUrl(url: string | undefined, preference: string | undefined): string | undefined {
  if (!url || !preference) return undefined;
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') return undefined;
    const official = ['api.openai.com', 'chatgpt.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'aiplatform.googleapis.com', 'api.x.ai'];
    return official.includes(target.hostname) || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/u.test(target.hostname) ? preference : undefined;
  } catch { return undefined; }
}
