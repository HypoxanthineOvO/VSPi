import { getProviderDefinition } from '@moonshot-ai/agent-core-v2/llm-adapter/provider/provider-definition';

export function builtinProviderProtocol(id: string): string | undefined {
  if (['openai', 'openai_responses', 'anthropic', 'google-genai'].includes(id)) return id;
  return getProviderDefinition(id)?.baseProtocol;
}

export * from './client.js';
export * from './config-migration.js';
export * from './daemon.js';
export * from './feature-defaults.js';
export * from './identity.js';
export * from './lease.js';
export * from './legacy-provider-compat.js';
export * from './paths.js';
export * from './remote.js';
export * from './state.js';
export * from './thinking-effort-repair.js';
export * from './types.js';
export { normalizeProxyAddress } from '@moonshot-ai/agent-core-v2/_base/utils/proxyAddress';
export { withScopedProxy } from '@moonshot-ai/agent-core-v2/_base/utils/scopedProxy';
export { accountProxyForUrl, accountProxyPreference, usesAccountProxy } from '@moonshot-ai/agent-core-v2/app/auth/proxy';
export type { ProxyConfig, OAuthNetworkConfig } from '@moonshot-ai/agent-core-v2/app/auth/configSection';
