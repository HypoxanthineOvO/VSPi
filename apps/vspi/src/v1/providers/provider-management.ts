import type { Klient } from '@moonshot-ai/klient';
import { builtinProviderProtocol } from '@vsp/vsp-runtime';
import type { ProviderOption } from '../domain/types.js';
import type { GatewayFormValue } from '../ui/provider-manager.js';
import { customProviderId, fetchProviderModels, type CustomProviderProtocol } from './custom-provider.js';

export async function loadProviderOptions(klient: Klient, label: (id: string) => string): Promise<ProviderOption[]> {
  const [providers, builtins, logins, inspection, local, defaultModel, models] = await Promise.all([
    klient.global.kosong.listProviders(), klient.global.kosong.listBuiltinProviders(), klient.global.auth.listLoginProviders(),
    klient.global.config.inspect<Record<string, Record<string, unknown>>>('providers'),
    klient.global.auth.listLocalCredentials(), klient.global.config.get<string | undefined>('defaultModel'), klient.global.kosong.listModels(),
  ]);
  const all = new Map([...logins.map(item => ({ id: item.id, type: item.id, status: 'unconfigured', has_api_key: false, models: [] as string[], base_url: undefined as string | undefined })), ...builtins, ...providers].map(item => [item.id, item]));
  return [...all.values()].filter(item => !item.id.startsWith('managed:') || inspection.userValue?.[item.id] !== undefined).map(item => {
    const config = inspection.userValue?.[item.id];
    const oauth = config?.oauth;
    const source = config?.source as { credential?: string } | undefined;
    const isDevin = item.type === 'devin' || item.id === 'devin';
    const localCredential = local.find(entry => entry.provider === item.id);
    const latest = models.filter(model => model.provider === item.id && model.health !== undefined)
      .sort((left, right) => Math.max(right.health?.lastSuccess ?? 0, right.health?.lastFailure?.at ?? 0) - Math.max(left.health?.lastSuccess ?? 0, left.health?.lastFailure?.at ?? 0))[0];
    return {
      modelHealth: latest?.health === undefined ? undefined : { model: latest.model, health: latest.health },
      id: item.id, label: typeof config?.name === 'string' ? config.name : label(item.id), protocol: isDevin ? item.type : builtinProviderProtocol(item.type) ?? item.type,
      status: item.status === 'connected' ? '已配置' : item.status === 'error' ? '异常' : '未配置',
      detail: `${(item.models?.length ?? 0)} 个模型`, models: item.models, baseUrl: item.base_url, custom: true, localCredential,
      storedCredential: oauth !== undefined ? 'oauth' : item.has_api_key || config?.apiKeyEnv !== undefined ? 'api_key' : undefined,
      authLabel: oauth !== undefined ? source?.credential === 'local-cli' || (oauth as { key?: string }).key?.startsWith('local-cli/')
        ? `复用本机 ${localCredential?.name ?? (isDevin ? 'Devin CLI' : 'CLI')} 凭据` : source?.credential === 'browser' ? '浏览器登录' : '订阅账号（来源未标注）' : undefined,
      defaultModel: models.some(model => model.model === defaultModel && model.provider === item.id) ? defaultModel : undefined,
      authMethods: [
        ...isDevin ? [] : [{ type: 'api_key' as const, label: 'API Key' }],
        ...localCredential || logins.some(login => login.id === item.id || login.id === item.type)
          ? [{ type: 'oauth' as const, label: '本机凭据 / 订阅账号' }] : [],
      ],
    } satisfies ProviderOption;
  });
}

export async function saveProviderGateway(klient: Klient, value: GatewayFormValue, provider?: ProviderOption): Promise<void> {
  const providerInspection = await klient.global.config.inspect<Record<string, Record<string, unknown>>>('providers');
  const id = provider?.id ?? customProviderId(value.name, value.baseUrl);
  const current = providerInspection.userValue?.[id];
  if (!provider && current) throw new Error('同名中转站已存在，请选择它并编辑');
  const key = value.apiKey.trim() || (typeof current?.apiKey === 'string' ? current.apiKey : '');
  const connectionChanged = value.baseUrl !== provider?.baseUrl || value.protocol !== provider?.protocol;
  if (!key && (value.apiKey || connectionChanged || !provider)) throw new Error('更改连接或添加中转站需要 API Key；账号凭据不能发送到自定义 Endpoint');
  const models = key ? await fetchProviderModels(value.baseUrl, value.protocol as CustomProviderProtocol, key) : [];
  const [latestProviders, latestModels, defaultModel] = await Promise.all([
    klient.global.config.inspect<Record<string, Record<string, unknown>>>('providers'),
    klient.global.config.inspect<Record<string, unknown>>('models'),
    klient.global.config.get<string | undefined>('defaultModel'),
  ]);
  if (JSON.stringify(latestProviders.userValue?.[id]) !== JSON.stringify(current)) throw new Error('测试期间 Provider 配置已改变，请重新保存');
  const nextModels = { ...latestModels.userValue };
  for (const model of models) {
    const alias = `${id}/${model.id}`;
    nextModels[alias] = { maxContextSize: 128_000, displayName: model.name, ...(nextModels[alias] as object | undefined), provider: id, model: model.id, protocol: value.protocol };
  }
  await klient.global.config.replaceSections({ sections: {
    providers: { ...latestProviders.userValue, [id]: { ...current, name: value.name, type: value.protocol === provider?.protocol ? current?.type ?? value.protocol : value.protocol, baseUrl: value.baseUrl,
      apiKey: key || current?.apiKey, apiKeyEnv: key ? undefined : current?.apiKeyEnv, oauth: key ? undefined : current?.oauth, source: key ? undefined : current?.source } },
    models: nextModels,
    defaultModel: defaultModel || (models[0] ? `${id}/${models[0].id}` : undefined),
  } });
}

export async function checkProvider(klient: Klient, id: string): Promise<{ ok: boolean; diagnostic: string }> {
  const provider = await klient.global.kosong.getProvider(id);
  const ok = provider.status === 'connected' && (provider.models?.length ?? 0) > 0;
  return { ok, diagnostic: `离线检查：${ok ? `配置完整，${(provider.models?.length ?? 0)} 个模型` : '缺少可用凭据或模型'}；当前 Core 不提供无计费网络探测` };
}
