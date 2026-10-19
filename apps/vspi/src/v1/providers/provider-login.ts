import type { Klient } from '@moonshot-ai/klient';
import type { ProviderAuthInteraction } from '../backend/types.js';
import { fetchProviderModels, type CustomProviderProtocol } from './custom-provider.js';
import { loginWithOAuth } from './oauth-login.js';
import { configuredProxy, ensureProviderProxy } from './proxy-setup.js';
import { accountProxyForUrl, builtinProviderProtocol, usesAccountProxy, withScopedProxy } from '@vsp/vsp-runtime';

export async function loginProvider(klient: Klient, providerId: string, type: 'api_key' | 'oauth', interaction: ProviderAuthInteraction): Promise<void> {
  if (type === 'oauth') {
    const local = (await klient.global.auth.listLocalCredentials()).find(item => item.provider === providerId);
    if (local) {
      const method = await interaction.prompt({ type: 'select', message: '认证方式', options: [{ id: 'local', label: `复用本机 ${local.name} 凭据` }, { id: 'browser', label: '浏览器登录' }], signal: interaction.signal });
      if (method === 'local') { await klient.global.auth.useLocalCredential(local.id); return; }
      if (method !== 'browser') throw new Error('认证方式无效');
    }
    await ensureProviderProxy(klient, providerId, interaction);
    await loginWithOAuth(klient.global.auth, providerId, interaction);
    return;
  }
  await ensureProviderProxy(klient, providerId, interaction);
  const apiKey = (await interaction.prompt({ type: 'secret', message: `${providerId} API Key`, placeholder: 'API Key', signal: interaction.signal })).trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  const [inspection, catalog] = await Promise.all([klient.global.config.inspect<Record<string, Record<string, unknown>>>('providers'), klient.global.kosong.listBuiltinProviders()]);
  const current = inspection.userValue?.[providerId];
  const builtin = catalog.find(item => item.id === providerId);
  const baseUrl = typeof current?.baseUrl === 'string' ? current.baseUrl : builtin?.base_url;
  const providerType = typeof current?.type === 'string' ? current.type : builtin?.type;
  const protocol = providerType === undefined ? undefined : builtinProviderProtocol(providerType);
  if (!baseUrl || !protocol) throw new Error('Provider 没有可验证的 Endpoint，请使用编辑配置连接');
  const preference = await configuredProxy(klient);
  const proxy = usesAccountProxy(providerId) ? preference : accountProxyForUrl(baseUrl, preference);
  await withScopedProxy(proxy || undefined, () => fetchProviderModels(baseUrl, protocol as CustomProviderProtocol, apiKey));
  interaction.signal?.throwIfAborted();
  if (!current) await klient.global.kosong.configureBuiltinProvider(providerId, apiKey);
  else await klient.global.config.replace({ domain: 'providers', value: { ...inspection.userValue, [providerId]: { ...current, apiKey, apiKeyEnv: undefined, oauth: undefined, source: undefined } } });
  interaction.notify({ type: 'info', message: 'API Key 已验证并保存到 VSPi Core 配置' });
}
