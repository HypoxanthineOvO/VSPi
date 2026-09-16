import type { Klient } from '@moonshot-ai/klient';
import { accountProxyPreference, normalizeProxyAddress, usesAccountProxy, type OAuthNetworkConfig, type ProxyConfig } from '@vsp/vsp-runtime';
import type { ProviderAuthInteraction } from '../backend/types.js';

export async function configuredProxy(klient: Klient): Promise<string | undefined> {
  const [current, legacy] = await Promise.all([
    klient.global.config.get<ProxyConfig>('proxy'),
    klient.global.config.get<OAuthNetworkConfig>('oauthNetwork'),
  ]);
  return accountProxyPreference(current, legacy);
}

export async function ensureProviderProxy(klient: Klient, providerId: string, interaction: ProviderAuthInteraction): Promise<void> {
  const type = usesAccountProxy(providerId) ? providerId
    : (await klient.global.kosong.listProviders()).find(provider => provider.id === providerId)?.type;
  if (!usesAccountProxy(type ?? '') || await configuredProxy(klient) !== undefined) return;
  await configureProxy(klient, interaction);
}

export async function configureProxy(klient: Klient, interaction: ProviderAuthInteraction): Promise<void> {
  const invalid = '请输入有效的代理地址（端口 1–65535）。仅支持 HTTP/HTTPS，不含账号密码或路径。';
  const value = await interaction.prompt({
    type: 'text', message: '请输入代理地址',
    description: '支持端口、主机或域名、HTTP/HTTPS 地址。仅填端口时使用后台所在机器；跳过则沿用已有环境网络。',
    placeholder: '7890 / proxy.example.com:7890 / https://proxy.example.com:8443',
    skip: { label: '跳过', value: '' },
    validate: input => normalizeProxyAddress(input) === undefined ? invalid : undefined,
    signal: interaction.signal,
  });
  const url = value === '' ? '' : normalizeProxyAddress(value);
  if (url === undefined) throw new Error(invalid);
  interaction.signal?.throwIfAborted();
  await klient.global.config.set({ domain: 'proxy', patch: { url } });
  interaction.notify({ type: 'info', message: url === ''
    ? '已保存：沿用已有环境网络。后续登录不再询问，可用 vspi proxy 重新配置。'
    : `已保存代理 ${url}。适用厂商的登录、令牌刷新和模型调用将使用此代理；浏览器沿用自身网络。可用 vspi proxy 修改。` });
}
