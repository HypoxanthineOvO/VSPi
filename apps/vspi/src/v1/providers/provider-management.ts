import type { Klient } from '@moonshot-ai/klient';
import { accountProxyForUrl, builtinProviderProtocol, lookupBuiltinModelMetadata, withScopedProxy } from '@vsp/vsp-runtime';
import type { ProviderOption } from '../domain/types.js';
import type { GatewayFormValue } from '../ui/provider-manager.js';
import type { LookupBuiltinModelMetadataView, ProviderConnectivityTestResult, ProviderModelOverridePatch, ProviderQuotaConfig } from './provider-contract.js';
import { configuredProxy } from './proxy-setup.js';
import { customProviderId, fetchProviderModels, modelsFromManualInput, type CustomProviderProtocol, type DiscoveredModel } from './custom-provider.js';

type ConfigRecord = Record<string, unknown>;
type ConfigRecords = Record<string, ConfigRecord>;

export async function loadProviderOptions(klient: Klient, label: (id: string) => string): Promise<ProviderOption[]> {
  const [providers, builtins, logins, inspection, local, defaultModel, models, modelInspection] = await Promise.all([
    klient.global.kosong.listProviders(), klient.global.kosong.listBuiltinProviders(), klient.global.auth.listLoginProviders(),
    klient.global.config.inspect<Record<string, Record<string, unknown>>>('providers'),
    klient.global.auth.listLocalCredentials(), klient.global.config.get<string | undefined>('defaultModel'), klient.global.kosong.listModels(),
    klient.global.config.inspect<ConfigRecords>('models'),
  ]);
  const all = new Map([...logins.map(item => ({ id: item.id, type: item.id, status: 'unconfigured', enabled: undefined as boolean | undefined, has_api_key: false, models: [] as string[], base_url: undefined as string | undefined })), ...builtins, ...providers].map(item => [item.id, item]));
  return [...all.values()].filter(item => !item.id.startsWith('managed:') || inspection.userValue?.[item.id] !== undefined).map(item => {
    const config = inspection.userValue?.[item.id];
    const oauth = config?.oauth;
    const source = config?.source as { credential?: string; modelProtocol?: 'auto' | 'explicit' } | undefined;
    const stationAuto = source?.modelProtocol === 'auto' || (source?.modelProtocol === undefined &&
      (item.type === 'vsplab' || (item.id === 'vsplab' && item.type === 'openai')));
    const isDevin = item.type === 'devin' || item.id === 'devin';
    const linkedId = (oauth as { key?: string } | undefined)?.key?.split('local-cli/')[1];
    const localCredential = local.find(entry => entry.provider === item.id && entry.id === linkedId)
      ?? local.find(entry => entry.provider === item.id);
    const modelEntries = item.models?.map(id => {
      const model = models.find(entry => entry.model === id && entry.provider === item.id);
      const record = modelInspection.value?.[id];
      const overrides = record?.overrides as ConfigRecord | undefined;
      const userRecord = modelInspection.userValue?.[id];
      const userOverrides = userRecord?.overrides as ConfigRecord | undefined;
      const overrideProtocol = textField(userRecord?.protocol);
      const overrideContextWindow = numberField(userOverrides?.maxContextSize) ?? numberField(userRecord?.maxContextSize);
      return {
        id, wireModel: model?.wire_model ?? textField(record?.name) ?? textField(record?.model) ?? id,
        displayName: model?.display_name ?? textField(overrides?.displayName) ?? textField(record?.displayName),
        protocol: model?.protocol ?? textField(record?.protocol) ?? textField(record?.defaultProtocol),
        contextWindow: model?.max_context_size ?? numberField(overrides?.maxContextSize) ?? numberField(record?.maxContextSize),
        overrideProtocol, overrideContextWindow,
      };
    });
    const latest = models.filter(model => model.provider === item.id && model.health !== undefined)
      .toSorted((left, right) => Math.max(right.health?.lastSuccess ?? 0, right.health?.lastFailure?.at ?? 0) - Math.max(left.health?.lastSuccess ?? 0, left.health?.lastFailure?.at ?? 0))[0];
    return {
      modelHealth: latest?.health === undefined ? undefined : { model: latest.model, health: latest.health },
      id: item.id, label: typeof config?.name === 'string' ? config.name : label(item.id), protocol: stationAuto ? 'auto' : isDevin ? item.type : builtinProviderProtocol(item.type) ?? item.type,
      enabled: item.enabled,
      status: item.enabled === false ? '已停用' : item.status === 'connected' ? '已配置' : item.status === 'error' ? '异常' : '未配置',
      detail: `${(item.models?.length ?? 0)} 个模型`, models: item.models, modelEntries, baseUrl: item.base_url, custom: true, localCredential,
      storedCredential: oauth !== undefined ? 'oauth' : item.has_api_key || config?.apiKeyEnv !== undefined ? 'api_key' : undefined,
      authLabel: oauth !== undefined ? source?.credential === 'local-cli' || (oauth as { key?: string }).key?.startsWith('local-cli/')
        ? `复用本机 ${localCredential?.name ?? (isDevin ? 'Devin CLI' : 'CLI')} 凭据` : source?.credential === 'browser' ? '浏览器登录' : '订阅账号（来源未标注）' : undefined,
      defaultModel: item.models?.includes(defaultModel ?? '') ? defaultModel : undefined,
      authMethods: [
        ...isDevin ? [] : [{ type: 'api_key' as const, label: 'API Key' }],
        ...(localCredential !== undefined && !localCredential.id.startsWith('omp-')) || logins.some(login => login.id === item.id || login.id === item.type)
          ? [{ type: 'oauth' as const, label: '本机凭据 / 订阅账号' }] : [],
      ],
    } satisfies ProviderOption;
  });
}

export async function saveProviderGateway(
  klient: Klient,
  value: GatewayFormValue,
  provider?: ProviderOption,
  lookupMetadata: LookupBuiltinModelMetadataView = lookupBuiltinModelMetadata,
  requireDiscovery = false,
): Promise<void> {
  const providerInspection = await klient.global.config.inspect<ConfigRecords>('providers');
  const id = provider?.id ?? customProviderId(value.name, value.baseUrl);
  const current = providerInspection.userValue?.[id];
  if (!provider && current) throw new Error('同名中转站已存在，请选择它并编辑');
  const siteProtocol = gatewayProtocol(value.protocol);
  const auto = siteProtocol === undefined;
  const existingType = textField(current?.type);
  const type = auto ? id === 'vsplab' ? 'vsplab' : 'openai' : value.protocol === provider?.protocol ? existingType ?? siteProtocol : siteProtocol;
  const inlineKey = value.apiKey.trim() || textField(current?.apiKey) || '';
  const protocolChanged = value.protocol !== provider?.protocol;
  const connectionChanged = value.baseUrl !== provider?.baseUrl || protocolChanged;
  if (!inlineKey && (value.apiKey || connectionChanged || !provider || requireDiscovery)) throw new Error('更改连接或添加中转站需要 API Key；账号凭据不能发送到自定义 Endpoint');
  let discovered: DiscoveredModel[] = [];
  if (inlineKey) {
    try {
      const proxy = accountProxyForUrl(value.baseUrl, await configuredProxy(klient));
      discovered = await withScopedProxy(proxy, () => fetchProviderModels(value.baseUrl, siteProtocol ?? 'openai', inlineKey));
    } catch (error) {
      if (requireDiscovery) throw error;
      if (value.modelIds?.trim()) discovered = modelsFromManualInput(value.modelIds);
      else if (connectionChanged || !provider?.models?.length) throw new Error(`请填写模型 ID 后重试：${error instanceof Error ? error.message : '自动发现失败'}`, { cause: error });
    }
  }
  const [latestProviders, latestModels, defaultModel] = await Promise.all([
    klient.global.config.inspect<ConfigRecords>('providers'),
    klient.global.config.inspect<ConfigRecords>('models'),
    klient.global.config.get<string | undefined>('defaultModel'),
  ]);
  if (JSON.stringify(latestProviders.userValue?.[id]) !== JSON.stringify(current)) throw new Error('测试期间 Provider 配置已改变，请重新保存');
  const nextModels = { ...latestModels.userValue };
  const modelEntries = new Map(discovered.map(model => [model.id, model]));
  if (connectionChanged) {
    for (const record of Object.values(latestModels.value ?? nextModels)) {
      const wireId = textField(record.name) ?? textField(record.model);
      if (wireId && (record.providerId ?? record.provider) === id && !modelEntries.has(wireId)) {
        modelEntries.set(wireId, { id: wireId, name: textField(record.displayName) ?? wireId });
      }
    }
  }
  const existingModels = latestModels.value ?? nextModels;
  for (const model of modelEntries.values()) {
    const aliases = Object.entries(existingModels).filter(([, record]) => (record.providerId ?? record.provider) === id &&
      ((record.name ?? record.model) === model.id || Array.isArray(record.aliases) && record.aliases.includes(model.id))).map(([alias]) => alias);
    for (const alias of aliases.length > 0 ? aliases : [`${id}/${model.id}`]) {
      const existing = nextModels[alias];
      const effective = latestModels.value?.[alias];
      const metadata = lookupMetadata(model.id, { providerType: id === 'vsplab' ? id : undefined, protocol: siteProtocol });
      const defaultProtocol = siteProtocol ?? metadata?.defaultProtocol ?? 'openai';
      const inherited = {
        canonical: metadata?.canonical, displayName: model.name !== model.id ? model.name : metadata?.displayName ?? model.name,
        maxContextSize: metadata?.maxContextSize ?? 131_072, maxOutputSize: metadata?.maxOutputSize,
        capabilities: metadata?.capabilities, thinking: metadata?.thinking, supportEfforts: metadata?.supportEfforts,
        defaultEffort: metadata?.defaultEffort, effortMapping: metadata?.effortMapping, effortProfileRevision: metadata?.effortProfileRevision,
        adaptiveThinking: metadata?.adaptiveThinking, pricing: metadata?.pricing, pricingSource: metadata?.pricingSource,
        defaultProtocol,
      };
      const missing = Object.fromEntries(Object.entries(inherited).filter(([key, field]) => field !== undefined && effective?.[key] === undefined));
      nextModels[alias] = { ...missing, ...existing, provider: id, model: existing?.model ?? effective?.model ?? model.id,
        defaultProtocol: protocolChanged ? defaultProtocol : existing?.defaultProtocol ?? effective?.defaultProtocol ?? defaultProtocol };
    }
  }
  const source = current?.source as ConfigRecord | undefined;
  await klient.global.config.replaceSections({ sections: {
    providers: { ...latestProviders.userValue, [id]: { ...current, name: value.name, type, baseUrl: value.baseUrl,
      apiKey: inlineKey || current?.apiKey, apiKeyEnv: inlineKey ? undefined : current?.apiKeyEnv, oauth: inlineKey ? undefined : current?.oauth,
      source: { ...source, kind: source?.kind ?? (id === 'vsplab' ? 'vsp-models' : 'custom-gateway'), modelProtocol: auto ? 'auto' : 'explicit', credential: inlineKey ? undefined : source?.credential } } },
    models: nextModels,
    defaultModel: defaultModel || Object.entries(nextModels).find(([, model]) => current?.enabled !== false && (model.providerId ?? model.provider) === id)?.[0],
  } });
}

function gatewayProtocol(value: string): CustomProviderProtocol | undefined {
  if (value === 'auto') return undefined;
  if (value === 'openai' || value === 'openai_responses' || value === 'anthropic' || value === 'google-genai') return value;
  throw new Error('无效的中转站协议');
}

function textField(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function numberField(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }

export async function setProviderEnabled(klient: Klient, id: string, enabled: boolean): Promise<void> {
  await updateProvider(klient, id, { enabled });
}

export interface ProviderQuotaSettings extends Omit<ProviderQuotaConfig, 'managementKey' | 'managementKeyRef'> {
  hasManagementKey?: boolean;
  hasManagementKeyRef?: boolean;
}

type ProviderQuotaPatch = Omit<ProviderQuotaConfig, 'managementKey'> & { managementKey?: string | null };

export async function getProviderQuotaSettings(klient: Klient, id: string): Promise<ProviderQuotaSettings> {
  const config = await klient.global.config.get<ConfigRecords>('providers');
  const quota = config[id]?.quota as ProviderQuotaSettings | undefined;
  return {
    mode: quota?.mode, apiProfile: quota?.apiProfile, managementUrl: quota?.managementUrl,
    managementKeyEnv: quota?.managementKeyEnv, userId: quota?.userId, billingMultiplier: quota?.billingMultiplier,
    region: quota?.region, accountFilter: quota?.accountFilter,
    hasManagementKey: quota?.hasManagementKey || !!quota?.managementKeyEnv || quota?.hasManagementKeyRef,
    hasManagementKeyRef: quota?.hasManagementKeyRef,
  };
}

export async function setProviderQuota(klient: Klient, id: string, patch: ProviderQuotaPatch): Promise<void> {
  const { userValue, value } = await klient.global.config.inspect<ConfigRecords>('providers');
  if (!value?.[id] && !userValue?.[id]) throw new Error('Provider 未配置');
  const previous = userValue?.[id]?.quota as ConfigRecord | undefined;
  const next: ConfigRecord = { ...previous, ...Object.fromEntries(Object.entries(patch).filter(([, field]) => field !== undefined)) };
  if (patch.managementKey !== undefined) {
    next.managementKey = patch.managementKey === null ? null : patch.managementKey.trim() || null;
    next.managementKeyRef = null;
    delete next.managementKeyEnv;
  }
  await klient.global.config.replace({ domain: 'providers', value: { ...userValue, [id]: { ...userValue?.[id], quota: next } } });
}

async function updateProvider(klient: Klient, id: string, patch: ConfigRecord): Promise<void> {
  const { userValue, value } = await klient.global.config.inspect<ConfigRecords>('providers');
  if (!value?.[id] && !userValue?.[id]) throw new Error('Provider 未配置');
  await klient.global.config.replace({ domain: 'providers', value: { ...userValue, [id]: { ...userValue?.[id], ...patch } } });
}

export async function setProviderModelOverride(klient: Klient, id: string, alias: string, patch: ProviderModelOverridePatch): Promise<void> {
  const { userValue, value } = await klient.global.config.inspect<ConfigRecords>('models');
  const model = value?.[alias] ?? userValue?.[alias];
  if (!model || (model.providerId ?? model.provider) !== id) throw new Error('该模型不属于此 Provider');
  if (patch.protocol !== undefined && gatewayProtocol(patch.protocol) === undefined) throw new Error('请选择单模型协议');
  if (patch.maxContextSize !== undefined && (!Number.isSafeInteger(patch.maxContextSize) || patch.maxContextSize < 1)) throw new Error('上下文窗口须为正整数');
  const record = { ...userValue?.[alias] };
  const overrides = record.overrides as ConfigRecord | undefined;
  if (patch.protocol !== undefined) record.protocol = patch.protocol;
  if (patch.maxContextSize !== undefined) {
    if (overrides?.maxContextSize !== undefined) record.overrides = { ...overrides, maxContextSize: patch.maxContextSize };
    else record.maxContextSize = patch.maxContextSize;
  }
  if (patch.displayName !== undefined) record.displayName = patch.displayName;
  await klient.global.config.replace({ domain: 'models', value: { ...userValue, [alias]: record } });
}

export async function refreshProviderGateway(klient: Klient, provider: ProviderOption): Promise<void> {
  if (provider.enabled === false) throw new Error('Provider 已停用，启用后再刷新');
  if (provider.id.startsWith('custom-') && provider.baseUrl) {
    await saveProviderGateway(klient, { name: provider.label, baseUrl: provider.baseUrl, protocol: provider.protocol, apiKey: '' }, provider, lookupBuiltinModelMetadata, true);
    return;
  }
  const result = await klient.global.kosong.refreshProviders({ providerId: provider.id });
  if (result.failed.length > 0) throw new Error(result.failed[0]!.reason);
}

export function checkProvider(klient: Klient, id: string): Promise<ProviderConnectivityTestResult> {
  return klient.global.kosong.testProvider(id);
}
