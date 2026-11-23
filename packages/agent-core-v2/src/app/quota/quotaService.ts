import { createHmac, randomBytes } from 'node:crypto';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { withScopedProxy } from '#/_base/utils/scopedProxy';
import { IOAuthService } from '#/app/auth/auth';
import { OAUTH_NETWORK_SECTION, PROXY_SECTION, type OAuthNetworkConfig, type ProxyConfig } from '#/app/auth/configSection';
import { accountProxyForUrl, accountProxyPreference } from '#/app/auth/proxy';
import { IConfigService } from '#/app/config/config';
import { MODELS_SECTION, PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import type { ModelsSection } from '#/llm-adapter/model/model';
import type { ProviderConfig } from '#/llm-adapter/provider/provider';
import { explainProviderEndpoint } from '#/llm-adapter/provider/provider-definition';
import { withProviderTransport } from '#/llm-adapter/provider/transport';
import { IQuotaService, type ProviderQuotaConfig, type ProviderQuotaItem, type QuotaQueryOptions, type QuotaRefreshOptions, type QuotaSnapshotResponse } from './quota-contract';
import { checkStatus, failure, managementRoot, QuotaError, retry, temporary, type Failure, type Reading, type RequestQuota } from './quota-parsers/common';
import { readCpa } from './quota-parsers/cpa';
import { readRelayQuota } from './quota-parsers/newapi';
import { inferRegion, matchOfficial, official, readOfficial } from './quota-parsers/official';

const FRESH_MS = 300_000;
const STALE_MS = 3_600_000;
const COOLDOWN_MS = 10_000;
const REQUEST_MS = 8_000;
const SIGNATURE_KEY = randomBytes(32);

const messages: Record<Failure, string> = {
  auth_expired: '额度鉴权失败，请重新登录或检查密钥',
  forbidden: '当前凭据无权查询额度',
  rate_limited: '额度查询达到上游限频',
  timeout: '额度查询超时',
  schema_mismatch: '无法识别额度接口返回的格式',
  unsupported: '此来源未配置可用的额度接口',
  disabled: '额度查询已停用',
  no_credential: '未配置可用于查询额度的凭据',
  account_unmatched: '未找到匹配的额度账号',
  network: '额度服务暂时无法连接',
};

type ConfiguredProvider = ProviderConfig & { enabled?: boolean; quota?: ProviderQuotaConfig };

type Card = Pick<ProviderQuotaItem, 'id' | 'providerId' | 'providerLabel' | 'accountLabel' | 'upstream' | 'category'>;

interface CacheEntry {
  signature: string;
  items: ProviderQuotaItem[];
  good: Map<string, ProviderQuotaItem>;
  accounts: Map<string, number>;
  manualAt?: number;
  nextListAt: number;
  inFlight?: Promise<void>;
}

function signature(value: unknown): string {
  return createHmac('sha256', SIGNATURE_KEY).update(JSON.stringify(value)).digest('hex');
}

function localId(value: string, secrets: readonly (string | undefined)[]): boolean {
  return /^(?!.*[/:]{2})[\p{L}\p{N}_.:/-]{1,128}$/u.test(value) &&
    !secrets.some(secret => secret && value.includes(secret));
}

function view(item: ProviderQuotaItem, now: number): ProviderQuotaItem {
  if (item.stale && item.staleUntil !== undefined && now >= item.staleUntil) {
    return { ...item, status: 'network_error', windows: [], balances: [], stale: false };
  }
  return {
    ...item,
    windows: item.windows.map(w => ({ ...w, modelIds: w.modelIds?.slice(), resetsInMs: w.resetAt === undefined ? undefined : Math.max(0, w.resetAt - now) })),
    balances: item.balances.map(b => ({ ...b })),
  };
}

function bindRequest(proxy: string | undefined): RequestQuota {
  return async (url, init) => withScopedProxy(accountProxyForUrl(String(url), proxy), () => withProviderTransport(async () => {
    const post = init?.body !== undefined;
    const response = await fetch(url, {
      method: post ? 'POST' : 'GET',
      headers: { accept: 'application/json', ...init?.headers, ...(post ? { 'content-type': 'application/json' } : {}) },
      body: post ? JSON.stringify(init.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      checkStatus(response.status);
    }
    const text = await response.text();
    try { return JSON.parse(text); } catch { throw new QuotaError('schema_mismatch'); }
  }));
}

export class QuotaService implements IQuotaService {
  declare readonly _serviceBrand: undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private revision = 0;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
  ) {}

  getQuotas(options?: QuotaQueryOptions): Promise<QuotaSnapshotResponse> {
    return this.snapshot(options?.providerId, options?.includeDisabled ?? false, false);
  }

  refreshQuotas(options?: QuotaRefreshOptions): Promise<QuotaSnapshotResponse> {
    return this.snapshot(options?.providerId, false, true);
  }

  private async snapshot(selected: string | undefined, includeDisabled: boolean, manual: boolean): Promise<QuotaSnapshotResponse> {
    await this.config.ready;
    const providers = this.config.get<Record<string, ConfiguredProvider>>(PROVIDERS_SECTION) ?? {};
    const models = this.config.get<ModelsSection>(MODELS_SECTION) ?? {};
    const proxy = accountProxyPreference(this.config.get<ProxyConfig>(PROXY_SECTION), this.config.get<OAuthNetworkConfig>(OAUTH_NETWORK_SECTION));
    for (const key of this.cache.keys()) if (!Object.hasOwn(providers, key)) this.cache.delete(key);
    const queries = await Promise.all(Object.entries(providers).filter(([id, provider]) =>
      (selected === undefined || id === selected) && (includeDisabled || provider.enabled !== false),
    ).map(([id, provider]) => this.collect(id, provider, models, proxy, manual)));
    const now = Date.now();
    const cooldownRemainingMs = Math.max(0, ...queries.map(q => (q.blockedUntil ?? 0) - now));
    return { items: queries.flatMap(q => q.entry.items.map(item => view(item, now))), now, revision: this.revision, cooldownRemainingMs: cooldownRemainingMs || undefined };
  }

  private async collect(id: string, provider: ConfiguredProvider, models: ModelsSection, proxy: string | undefined, manual: boolean): Promise<{ entry: CacheEntry; blockedUntil?: number }> {
    const quota = provider.quota ?? {};
    const enabled = provider.enabled !== false && quota.mode !== 'off';
    const env = { ...process.env, ...provider.env };
    const providerType = provider.type ?? id;
    const vsplab = id === 'vsplab' || provider.type === 'vsplab' || provider.source?.['kind'] === 'vsp-models';
    const endpoint = explainProviderEndpoint(vsplab ? 'vsplab' : providerType, env);
    const base = provider.baseUrl ?? endpoint.baseUrl;
    const kind = matchOfficial(id, provider.type, base);
    const hasManagementCredential = quota.managementKey !== undefined || quota.managementKeyEnv !== undefined || quota.managementKeyRef !== undefined;
    const profile = quota.mode === 'cpa' ? quota.apiProfile ?? 'v8' : quota.mode === 'newapi-account' ? 'account'
      : quota.mode === 'newapi-token' ? 'token' : quota.apiProfile ?? (vsplab ? 'token' : kind === undefined && hasManagementCredential ? 'account' : undefined);
    const managementKey = quota.managementKeyRef !== undefined ? undefined : quota.managementKey?.trim() || (quota.managementKeyEnv === undefined ? undefined : process.env[quota.managementKeyEnv]?.trim());
    const endpointKey = vsplab ? endpoint.apiKey : kind !== undefined && profile === undefined
      ? explainProviderEndpoint(official[kind].aliases.includes(providerType) ? providerType : official[kind].aliases[0]!, env).apiKey
      : explainProviderEndpoint(providerType, provider.env ?? {}).apiKey;
    const key = provider.apiKey?.trim() || (provider.apiKeyEnv ? env[provider.apiKeyEnv]?.trim() : endpointKey?.trim());
    let oauthToken: string | undefined;
    if (enabled && profile === undefined && kind !== undefined && provider.oauth !== undefined) {
      try { oauthToken = await this.oauth.getCachedAccessToken(id, provider.oauth); } catch {}
    }
    const token = provider.oauth === undefined ? key : oauthToken;
    const projectId = env['ANTIGRAVITY_PROJECT_ID'] ?? env['GOOGLE_CLOUD_PROJECT'];
    const secrets = [key, token, managementKey, provider.oauth?.key, quota.userId];
    const modelIds = [...new Set(Object.values(models).filter(m => (m.providerId ?? m.provider) === id)
      .map(m => m.name ?? m.model).filter((model): model is string => model !== undefined && localId(model, [key, token, managementKey])))].toSorted();
    const category = quota.mode === 'cpa' || profile === 'v8' || profile === 'v0-compat' ? 'cpa'
      : profile !== undefined || kind === undefined ? 'balance' : official[kind].category;
    const providerId = localId(id, secrets) ? id : `provider-${signature(id).slice(0, 16)}`;
    const card: Card = { id: providerId, providerId, providerLabel: vsplab ? 'VSPLab' : undefined, category };
    const fingerprint = signature([provider, base, token, managementKey, modelIds, proxy, projectId]);
    let entry = this.cache.get(id);
    if (entry?.signature !== fingerprint) {
      entry = { signature: fingerprint, items: [], good: new Map(), accounts: new Map(), nextListAt: 0 };
      this.cache.set(id, entry);
    }
    if (entry.inFlight !== undefined) {
      await entry.inFlight;
      return { entry };
    }
    const now = Date.now(), blockedUntil = (entry.manualAt ?? -Infinity) + COOLDOWN_MS;
    if (manual && now < blockedUntil) return { entry, blockedUntil };
    if (!manual && now < entry.nextListAt) return { entry };
    if (manual && enabled) entry.manualAt = now;
    const run = async () => {
      let items: ProviderQuotaItem[];
      try {
        if (!enabled) throw new QuotaError('disabled');
        const request = bindRequest(proxy);
        if (category === 'cpa') {
          if (!managementKey) throw new QuotaError('no_credential');
          if (profile !== 'v8' && profile !== 'v0-compat') throw new QuotaError('unsupported');
          const accounts = await readCpa(request, managementRoot(base, quota.managementUrl), {
            profile, key: managementKey, filter: quota.accountFilter, modelIds, now,
          });
          items = accounts.map(account => {
            const key = signature(account.ref);
            const index = entry.accounts.get(key) ?? entry.accounts.size + 1;
            entry.accounts.set(key, index);
            const owner = account.upstream === 'claude' ? 'Claude' : account.upstream === 'codex' ? 'Codex' : '账号';
            return this.settle(entry, { ...card, id: `${providerId}:${index}`, accountLabel: `CPA · ${owner} #${index}`, upstream: account.upstream }, account.result);
          });
          const live = new Set(items.map(item => item.id));
          for (const id of entry.good.keys()) if (!live.has(id)) entry.good.delete(id);
        } else {
          const safeRequest: RequestQuota = (url, init) => retry(() => request(url, init));
          if (profile === 'account' || profile === 'token') {
            const relayToken = profile === 'account' ? managementKey : key;
            if (!relayToken) throw new QuotaError('no_credential');
            const data = await readRelayQuota(safeRequest, managementRoot(base, quota.managementUrl), {
              profile, token: relayToken, userId: quota.userId, multiplier: quota.billingMultiplier, sub2api: vsplab,
            });
            items = [this.settle(entry, card, data)];
          } else {
            if (kind === undefined) throw new QuotaError('unsupported');
            if ((kind === 'claude' || kind === 'codex' || kind === 'antigravity') && provider.oauth === undefined) throw new QuotaError('no_credential');
            if (!token) throw new QuotaError(provider.oauth === undefined ? 'no_credential' : 'auth_expired');
            const data = await readOfficial(safeRequest, kind, { token, modelIds, projectId, region: quota.region ?? inferRegion(id, provider.type, base) }, now);
            items = [this.settle(entry, { ...card, upstream: kind }, data)];
          }
        }
      } catch (error) {
        const reason = failure(error);
        if (temporary(reason) && category === 'cpa' && entry.good.size > 0) {
          items = [...entry.good.values()].map(item => {
            const { id, providerId, providerLabel, accountLabel, upstream, category } = item;
            return this.settle(entry, { id, providerId, providerLabel, accountLabel, upstream, category }, reason);
          });
        } else {
          if (!temporary(reason)) entry.good.clear();
          items = [this.settle(entry, card, reason)];
        }
      }
      entry.items = items;
      const current = Date.now();
      entry.nextListAt = Math.min(...items.map(item => item.freshUntil !== undefined && item.status === 'ok'
        ? item.freshUntil : current + (item.status === 'unconfigured' ? FRESH_MS : COOLDOWN_MS)));
      this.revision++;
    };
    entry.inFlight = run();
    try { await entry.inFlight; } finally { entry.inFlight = undefined; }
    return { entry };
  }

  private settle(entry: CacheEntry, card: Card, data: Reading | Failure): ProviderQuotaItem {
    const checkedAt = Date.now();
    if (typeof data !== 'string') {
      const item: ProviderQuotaItem = { ...card, ...data, status: 'ok', stale: false, updatedAt: checkedAt, checkedAt, freshUntil: checkedAt + FRESH_MS, staleUntil: checkedAt + STALE_MS };
      entry.good.set(card.id, item);
      return item;
    }
    const diagnosis = { errorReason: data === 'network' ? undefined : data, errorMessage: messages[data] };
    const old = entry.good.get(card.id);
    if (temporary(data) && old?.staleUntil !== undefined && checkedAt < old.staleUntil) {
      return {
        ...old, ...card, ...diagnosis, status: 'stale', stale: true, checkedAt,
        windows: old.windows.map(w => ({ ...w, stale: true })), balances: old.balances.map(b => ({ ...b, stale: true })),
      };
    }
    entry.good.delete(card.id);
    const status = data === 'auth_expired' || data === 'forbidden' ? 'auth_error'
      : data === 'unsupported' || data === 'no_credential' || data === 'disabled' || data === 'account_unmatched' ? 'unconfigured' : 'network_error';
    return { ...card, ...diagnosis, status, stale: false, updatedAt: null, checkedAt, windows: [], balances: [] };
  }
}

registerScopedService(LifecycleScope.App, IQuotaService, QuotaService, ScopeActivation.OnScopeCreated, 'quotaService');
