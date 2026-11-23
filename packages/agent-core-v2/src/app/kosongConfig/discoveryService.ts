import {
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
  type RefreshProviderHost,
  type RefreshResult,
} from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';
import { CoreErrors } from '#/_base/errors/codes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { LifecycleScope } from '#/app/scopes';
import { IOAuthService } from '#/app/auth/auth';
import { providerFetch } from '#/llm-adapter/provider/transport';
import { withScopedProxy } from '#/_base/utils/scopedProxy';
import { accountProxyForUrl, accountProxyPreference } from '#/app/auth/proxy';
import { OAUTH_NETWORK_SECTION, PROXY_SECTION, type OAuthNetworkConfig, type ProxyConfig } from '#/app/auth/configSection';
import { AuthErrors } from '#/app/auth/errors';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ModelCatalogErrors } from '#/llm-adapter/model/errors';
import { IModelService, type ModelRecord } from '#/llm-adapter/model/model';
import { lookupBuiltinModelMetadata } from '#/llm-adapter/model/metadata-lookup';
import { effectiveModelConfig, nonEmpty, resolveEndpointBaseUrl, resolveModelAuthMaterial, resolveModelProtocol } from '#/llm-adapter/model/model-auth';
import {
  IProviderService,
  type ModelSource,
  type OAuthRef,
  type ProviderConfig,
} from '#/llm-adapter/provider/provider';
import { getProviderDefinition } from '#/llm-adapter/provider/provider-definition';
import type { ProviderConnectivityProbeKind, ProviderConnectivityTestResult } from './provider-probe-contract';

import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  THINKING_SECTION,
} from './configSection';
import { ModelsDevImportErrors } from './errors';
import { fetchRelayCatalog, isRelayCatalogProvider, mergeRelayCatalog } from './relayCatalog';
import {
  IProviderDiscoveryService,
  ModelCatalogChanged,
  type QueryAvailableModelsResponse,
  type RefreshProviderModelsOptions,
  type RefreshProviderModelsResponse,
} from './discovery';

interface StaticExclusion {
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: Readonly<Record<string, ModelRecord>>;
  readonly defaultModel?: string;
  readonly thinking?: ManagedKimiConfigShape['thinking'];
}

const EMPTY_EXCLUSION: StaticExclusion = { providers: {}, models: {} };
const availableModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
}).passthrough();
const AVAILABILITY_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;
const googleModelsResponseSchema = z.object({ models: z.array(z.object({ name: z.string().min(1) })) });

export class ProviderDiscoveryService implements IProviderDiscoveryService {
  declare readonly _serviceBrand: undefined;

  private refreshChain: Promise<unknown> = Promise.resolve();

  constructor(
    @IProviderService private readonly providerService: IProviderService,
    @IModelService private readonly modelService: IModelService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IEventService private readonly events: IEventService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  refreshProviderModels(
    options: RefreshProviderModelsOptions = {},
  ): Promise<RefreshProviderModelsResponse> {
    const run = this.refreshChain.then(() => this.doRefreshProviderModels(options));
    this.refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async queryAvailableModels(providerId: string): Promise<QueryAvailableModelsResponse> {
    await this.config.reload();
    const provider = this.providerService.get(providerId);
    const preference = accountProxyPreference(this.config.get<ProxyConfig>(PROXY_SECTION), this.config.get<OAuthNetworkConfig>(OAUTH_NETWORK_SECTION));
    return withScopedProxy(accountProxyForUrl(provider?.baseUrl, preference), () => this.queryProviderModels(providerId, provider));
  }

  async testProvider(providerId: string): Promise<ProviderConnectivityTestResult> {
    const start = performance.now();
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const finish = (
      category: ProviderConnectivityTestResult['category'],
      diagnostic: string,
      probeKind: ProviderConnectivityProbeKind,
      httpStatus?: number,
      modelCount?: number,
    ): ProviderConnectivityTestResult => ({
      ok: category === 'ok', providerId, category, durationMs: Math.round(performance.now() - start),
      httpStatus, modelCount, probeKind, diagnostic,
    });
    let kind: ProviderConnectivityProbeKind = 'offline';
    let onTimeout: () => void = () => {};
    const expired = new Promise<ProviderConnectivityTestResult>(resolve => {
      onTimeout = () => resolve(finish('timeout', '✗ 连接超时 (8s)', kind));
      signal.addEventListener('abort', onTimeout, { once: true });
    });
    const run = async () => {
      try { await this.config.reload(); } catch { return finish('config_error', '✗ 无法读取 Provider 配置', 'offline'); }
      const provider = this.providerService.get(providerId);
      if (!provider) return finish('config_error', '✗ Provider 未配置', 'offline');
      const type = provider.type ?? 'openai';
      const protocol = resolveModelProtocol({}, { type });
      const account = type === 'openai-codex' || type === 'devin';
      if (!protocol && !account) return finish('config_error', '✗ Provider 协议未配置', 'offline');
      let baseUrl: URL;
      try {
        const defaults = type === 'anthropic' ? 'https://api.anthropic.com' : type === 'google-genai' || type === 'gemini'
          ? 'https://generativelanguage.googleapis.com/v1beta' : type === 'openai' || type === 'openai_responses' ? 'https://api.openai.com/v1' : undefined;
        baseUrl = new URL(resolveEndpointBaseUrl({}, { ...provider, type }) ?? defaults ?? '');
        if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error();
      } catch { return finish('config_error', '✗ Provider Endpoint 无效', 'offline'); }
      const preference = accountProxyPreference(this.config.get<ProxyConfig>(PROXY_SECTION), this.config.get<OAuthNetworkConfig>(OAUTH_NETWORK_SECTION));
      let credential;
      let oauth = false;
      try {
        const material = resolveModelAuthMaterial({ modelId: providerId, model: {}, provider: { ...provider, type }, providerName: providerId });
        if (material.oauth) {
          oauth = !material.oauth.key.startsWith('local-cli/omp-');
          credential = await withScopedProxy(accountProxyForUrl(baseUrl.href, preference), () => this.oauth.resolveRequestAuth(providerId, material.oauth));
          if (!oauth) oauth = credential.headers?.['anthropic-beta'] !== undefined;
        } else credential = { apiKey: material.apiKey ?? (material.apiKeyEnv ? process.env[material.apiKeyEnv] : undefined) };
      } catch (error) {
        const diagnostic = error instanceof Error && error.name === 'OmpCredentialExpiredError' ? error.message : 'Provider 凭据不可用';
        return finish('config_error', `✗ ${diagnostic}`, 'offline');
      }
      const apiKey = nonEmpty(credential.apiKey);
      if (!apiKey || /[\r\n]/u.test(apiKey)) return finish('config_error', '✗ Provider 缺少可用凭据', 'offline');
      signal.throwIfAborted();
      const headers = new Headers(provider.customHeaders);
      for (const name of credential.removeHeaders ?? []) headers.delete(name);
      for (const [name, value] of Object.entries(credential.headers ?? {})) headers.set(name, value);
      for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) headers.delete(name);
      headers.set('accept', 'application/json');
      let url = new URL(baseUrl);
      if (credential.baseUrl !== undefined) {
        try {
          const fromCredential = new URL(credential.baseUrl);
          if (!['http:', 'https:'].includes(fromCredential.protocol) || fromCredential.username || fromCredential.password || fromCredential.search || fromCredential.hash) throw new Error();
          url = fromCredential;
        } catch { return finish('config_error', '✗ Provider 凭据 Endpoint 无效', 'offline'); }
      }
      let body: string | undefined;
      kind = account ? 'account' : 'models';
      if (type === 'openai-codex') {
        url = new URL('https://chatgpt.com/backend-api/wham/usage');
        headers.set('authorization', `Bearer ${apiKey}`);
        headers.set('originator', 'codex_cli_rs');
      } else if (type === 'devin') {
        url = new URL('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus');
        const token = apiKey.startsWith('devin-session-token$') ? apiKey : `devin-session-token$${apiKey}`;
        headers.set('x-api-key', token);
        headers.set('content-type', 'application/json');
        headers.set('connect-protocol-version', '1');
        body = JSON.stringify({ metadata: { ide_name: 'devin-cli', ide_version: '3000.11.3', extension_name: 'devin', extension_version: '3000.11.3', api_key: token, locale: 'en-US', os: process.platform, auth_source: 'API_KEY' } });
      } else {
        const prefix = url.pathname.replace(/\/+$/u, '');
        if (protocol === 'anthropic') {
          url.pathname = `${prefix}${prefix.endsWith('/v1') ? '' : '/v1'}/models`;
          headers.set('anthropic-version', '2023-06-01');
          if (oauth) headers.set('authorization', `Bearer ${apiKey}`);
          else headers.set('x-api-key', apiKey);
        } else {
          const defaultPrefix = url.origin === 'https://api.openai.com' ? '/v1' : url.origin === 'https://generativelanguage.googleapis.com' ? '/v1beta' : '';
          url.pathname = `${prefix || defaultPrefix}/models`;
          if (protocol === 'google-genai') headers.set('x-goog-api-key', apiKey);
          else headers.set('authorization', `Bearer ${apiKey}`);
        }
      }
      const fetchProbe = (endpoint: URL) => withScopedProxy(accountProxyForUrl(endpoint.href, preference), () => providerFetch(endpoint, {
        method: body === undefined ? 'GET' : 'POST', headers, body, redirect: 'manual', signal,
      }));
      let response: Response;
      try {
        response = await fetchProbe(url);
        if (type === 'deepseek' && url.origin === 'https://api.deepseek.com' && [404, 405].includes(response.status)) {
          void response.body?.cancel().catch(() => {});
          kind = 'balance';
          response = await fetchProbe(new URL('/user/balance', url));
        }
      } catch {
        return signal.aborted ? finish('timeout', '✗ 连接超时 (8s)', kind) : finish('network_error', '✗ 代理或网络不可达', kind);
      }
      const status = response.status;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (status === 401 || status === 403) return finish('auth_error', `✗ 鉴权失败 (HTTP ${status})`, kind, status);
        if (status >= 500) return finish('network_error', `✗ 上游暂不可用 (HTTP ${status})`, kind, status);
        return finish('protocol_error', `✗ 协议或路径不匹配 (HTTP ${status})`, kind, status);
      }
      if (kind === 'account') {
        void response.body?.cancel().catch(() => {});
        return finish('ok', `✓ 可用（账号状态正常 / 耗时 ${Math.round(performance.now() - start)}ms）`, kind, status);
      }
      let count: number | undefined;
      try {
        const payload: unknown = await response.json();
        if (kind === 'balance') {
          if (!z.object({ is_available: z.boolean(), balance_infos: z.array(z.unknown()) }).safeParse(payload).success) throw new Error();
        } else if (protocol === 'google-genai') count = googleModelsResponseSchema.parse(payload).models.length;
        else count = availableModelsResponseSchema.parse(payload).data.length;
      } catch {
        return signal.aborted ? finish('timeout', '✗ 连接超时 (8s)', kind) : finish('protocol_error', '✗ 协议或路径不匹配 (非模型/余额 JSON)', kind, status);
      }
      const detail = count === undefined ? '余额接口正常' : `发现 ${count} 个模型`;
      return finish('ok', `✓ 可用（${detail} / 耗时 ${Math.round(performance.now() - start)}ms）`, kind, status, count);
    };
    try { return await Promise.race([run(), expired]); }
    catch { return signal.aborted ? finish('timeout', '✗ 连接超时 (8s)', kind) : finish('unknown_error', '✗ Provider 探测失败', kind); }
    finally { signal.removeEventListener('abort', onTimeout); }
  }

  private async queryProviderModels(providerId: string, provider: ProviderConfig | undefined): Promise<QueryAvailableModelsResponse> {
    if (provider === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
        `provider ${providerId} does not exist`,
      );
    }
    if (provider.type !== 'openai' && provider.type !== 'openai_responses') {
      throw new Error2(
        CoreErrors.codes.VALIDATION_FAILED,
        `provider ${providerId} does not support model availability queries`,
      );
    }
    const baseUrl = provider.baseUrl?.trim();
    const apiKey = provider.apiKey?.trim();
    if (baseUrl === undefined || baseUrl.length === 0 || apiKey === undefined || apiKey.length === 0) {
      throw new Error2(
        CoreErrors.codes.VALIDATION_FAILED,
        `provider ${providerId} requires a base URL and API key`,
      );
    }
    const headers = new Headers(provider.customHeaders);
    headers.set('Authorization', `Bearer ${apiKey}`);
    let response: Response;
    try {
      response = await providerFetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
    } catch {
      throw new Error2(
        ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE,
        `provider ${providerId} model availability request failed`,
      );
    }
    if (!response.ok) {
      throw new Error2(
        ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE,
        `provider ${providerId} model availability request failed with HTTP ${response.status}`,
        { details: { provider_id: providerId, status: response.status } },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error2(
        ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE,
        `provider ${providerId} returned an invalid model availability response`,
      );
    }
    const parsed = availableModelsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error2(
        ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE,
        `provider ${providerId} returned an invalid model availability response`,
      );
    }
    const availableWireIds = new Set(parsed.data.data.map((model) => model.id));
    const defaultProvider = this.providerService.getDefaultProvider();
    const modelIds = Object.entries(this.modelService.list())
      .filter(([, record]) => {
        const effective = effectiveModelConfig(record);
        const owner = effective.providerId ?? effective.provider ?? defaultProvider;
        const wireId = effective.name ?? effective.model;
        return owner === providerId && wireId !== undefined && availableWireIds.has(wireId);
      })
      .map(([modelId]) => modelId);
    return { providerId, modelIds };
  }

  private async doRefreshProviderModels(
    options: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse> {
    await this.config.reload();
    const userProviders = this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const relayIds = options.scope === 'oauth' ? [] : Object.entries(this.providerService.list())
      .filter(([id, provider]) => (options.providerId === undefined || options.providerId === id) && provider.enabled !== false &&
        isRelayCatalogProvider(id, { ...provider, modelSource: userProviders[id]?.modelSource }))
      .map(([id]) => id);
    if (options.providerId !== undefined && relayIds.includes(options.providerId)) {
      const response = await this.refreshRelayProviders(relayIds);
      if (response.changed.length > 0) this.events.publish(new ModelCatalogChanged({ payload: response }));
      return response;
    }
    if (options.providerId !== undefined) {
      const provider = this.providerService.get(options.providerId);
      if (provider === undefined) {
        throw new Error2(
          ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
          `provider ${options.providerId} does not exist`,
        );
      }
      if (provider.enabled === false || this.effectiveModelSource(provider) === 'static') {
        return { changed: [], unchanged: [options.providerId], failed: [] };
      }
    }

    const exclusion = this.computeStaticExclusion();
    const { outboundUserAgent } = await this.identity.resolved();
    const result = await refreshProviderModels(this.buildRefreshHost(exclusion, outboundUserAgent), {
      scope: options.scope,
      providerId: options.providerId,
    });
    const response = mapRefreshResult(result);
    if (relayIds.length > 0) {
      const relay = await this.refreshRelayProviders(relayIds);
      response.changed.push(...relay.changed);
      response.unchanged.push(...relay.unchanged);
      response.failed.push(...relay.failed);
    }
    if (response.changed.length > 0) {
      this.events.publish(new ModelCatalogChanged({ payload: response }));
    }
    return response;
  }

  private async refreshRelayProviders(ids: readonly string[]): Promise<RefreshProviderModelsResponse> {
    const response: RefreshProviderModelsResponse = { changed: [], unchanged: [], failed: [] };
    for (const id of ids) {
      const provider = this.providerService.get(id);
      if (!provider) continue;
      try {
        const payload = await fetchRelayCatalog(provider);
        if (JSON.stringify(this.providerService.get(id)) !== JSON.stringify(provider)) throw new Error('Provider changed during discovery; retry refresh');
        const inspected = this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION);
        const current = inspected.userValue ?? {};
        const merged = mergeRelayCatalog(current, id, provider, payload, lookupBuiltinModelMetadata);
        for (const [alias, record] of Object.entries(merged)) {
          if ((record.providerId ?? record.provider) !== id || inspected.value?.[alias]?.pricing === undefined) continue;
          record.pricing = current[alias]?.pricing;
          record.pricingSource = current[alias]?.pricingSource;
        }
        if (JSON.stringify(current) === JSON.stringify(merged)) { response.unchanged.push(id); continue; }
        await this.config.replace(MODELS_SECTION, merged);
        response.changed.push({ provider_id: id, provider_name: id, added: Object.keys(merged).length - Object.keys(current).length, removed: 0 });
      } catch (error) {
        response.failed.push({ provider: id, reason: error instanceof Error ? error.message : 'Relay catalog refresh failed' });
      }
    }
    return response;
  }

  private effectiveModelSource(provider: ProviderConfig): ModelSource | undefined {
    return (
      provider.modelSource ??
      (provider.type === undefined ? undefined : getProviderDefinition(provider.type)?.modelSource)
    );
  }

  private computeStaticExclusion(): StaticExclusion {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const staticIds = Object.entries(providers)
      .filter(([, provider]) => provider.enabled === false || this.effectiveModelSource(provider) === 'static')
      .map(([id]) => id);
    if (staticIds.length === 0) return EMPTY_EXCLUSION;

    const excludedProviders: Record<string, ProviderConfig> = {};
    for (const id of staticIds) {
      const provider = providers[id];
      if (provider !== undefined) excludedProviders[id] = provider;
    }
    const models =
      this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const excludedModels: Record<string, ModelRecord> = {};
    for (const [modelId, record] of Object.entries(models)) {
      if (record.provider !== undefined && record.provider in excludedProviders) {
        excludedModels[modelId] = record;
      }
    }
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const thinking = this.config.inspect<ManagedKimiConfigShape['thinking']>(
      THINKING_SECTION,
    ).userValue;
    return {
      providers: excludedProviders,
      models: excludedModels,
      defaultModel:
        defaultModel !== undefined && defaultModel in excludedModels ? defaultModel : undefined,
      thinking:
        defaultModel !== undefined && defaultModel in excludedModels ? thinking : undefined,
    };
  }

  private buildRefreshHost(exclusion: StaticExclusion, userAgent: string): RefreshProviderHost {
    return {
      getConfig: async () => this.readUserConfigShape(exclusion),
      removeProvider: (providerId) => this.shapeWithoutProvider(providerId),
      setConfig: (patch) => this.applyRefreshPatch(patch, exclusion),
      resolveOAuthToken: (providerName, oauthRef) => this.resolveOAuthToken(providerName, oauthRef),
      userAgent,
    };
  }

  private readUserConfigShape(exclusion: StaticExclusion = EMPTY_EXCLUSION): ManagedKimiConfigShape {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models =
      this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const thinking =
      this.config.inspect<ManagedKimiConfigShape['thinking']>(THINKING_SECTION).userValue;
    const visibleModels = withoutKeys(models, exclusion.models);
    const excludedDefaultModel = exclusion.defaultModel;
    const excludedDefaultRecord =
      excludedDefaultModel !== undefined ? models[excludedDefaultModel] : undefined;
    return {
      providers: withoutKeys(providers, exclusion.providers) as ManagedKimiConfigShape['providers'],
      models: (excludedDefaultModel !== undefined && excludedDefaultRecord !== undefined
        ? { ...visibleModels, [excludedDefaultModel]: excludedDefaultRecord }
        : visibleModels) as ManagedKimiConfigShape['models'],
      defaultModel,
      thinking: thinking === undefined ? undefined : { ...thinking },
    };
  }

  private shapeWithoutProvider(providerId: string): Promise<ManagedKimiConfigShape> {
    const current = this.readUserConfigShape();
    const providers = current.providers as Record<string, ProviderConfig>;
    const restProviders = Object.fromEntries(
      Object.entries(providers).filter(([id]) => id !== providerId),
    );
    const models = (current.models ?? {}) as Record<string, ModelRecord>;
    const restModels = Object.fromEntries(
      Object.entries(models).filter(([, record]) => record.provider !== providerId),
    );
    return Promise.resolve({
      ...current,
      providers: restProviders,
      models: restModels,
    } as ManagedKimiConfigShape);
  }

  private async applyRefreshPatch(
    patch: ManagedKimiConfigShape,
    exclusion: StaticExclusion,
  ): Promise<ManagedKimiConfigShape> {
    const userProviders =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const userModels =
      this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const sections: Record<string, unknown> = {};
    if (patch.providers !== undefined) {
      sections[PROVIDERS_SECTION] = {
        ...exclusion.providers,
        ...patch.providers,
      };
    }
    if (patch.models !== undefined) {
      sections[MODELS_SECTION] = {
        ...exclusion.models,
        ...(patch.models as Record<string, ModelRecord>),
      };
    }
    const restoreDefault = exclusion.defaultModel !== undefined;
    if ('defaultModel' in patch) {
      sections[DEFAULT_MODEL_SECTION] = restoreDefault
        ? exclusion.defaultModel
        : patch.defaultModel;
    }
    if ('thinking' in patch) {
      sections[THINKING_SECTION] = restoreDefault ? exclusion.thinking : patch.thinking;
    }
    await this.config.replaceSections(sections);
    return {
      providers:
        patch.providers !== undefined
          ? ({ ...exclusion.providers, ...patch.providers } as ManagedKimiConfigShape['providers'])
          : (userProviders as ManagedKimiConfigShape['providers']),
      models:
        patch.models !== undefined
          ? ({ ...exclusion.models, ...patch.models } as ManagedKimiConfigShape['models'])
          : (userModels as ManagedKimiConfigShape['models']),
      defaultModel:
        'defaultModel' in patch
          ? restoreDefault
            ? exclusion.defaultModel
            : patch.defaultModel
          : this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue,
      thinking:
        'thinking' in patch
          ? restoreDefault
            ? exclusion.thinking
            : patch.thinking
          : this.config.inspect<ManagedKimiConfigShape['thinking']>(THINKING_SECTION).userValue,
    };
  }

  private async resolveOAuthToken(
    providerName: string,
    oauthRef?: ManagedKimiOAuthRef,
  ): Promise<string> {
    const tokenProvider = this.oauth.resolveTokenProvider(
      providerName,
      oauthRef as unknown as OAuthRef | undefined,
    );
    if (tokenProvider === undefined) {
      throw new Error2(AuthErrors.codes.AUTH_TOKEN_MISSING, 'OAuth token provider is not configured.', {
        details: { provider_id: providerName },
      });
    }
    return tokenProvider.getAccessToken();
  }
}

function withoutKeys<T>(
  record: Readonly<Record<string, T>>,
  excluded: Readonly<Record<string, unknown>>,
): Record<string, T> {
  if (Object.keys(excluded).length === 0) return { ...record };
  return Object.fromEntries(Object.entries(record).filter(([key]) => !(key in excluded)));
}

function mapRefreshResult(result: RefreshResult): RefreshProviderModelsResponse {
  return {
    changed: result.changed.map((change) => ({
      provider_id: change.providerId,
      provider_name: change.providerName,
      added: change.added,
      removed: change.removed,
    })),
    unchanged: [...result.unchanged],
    failed: result.failed.map((failure) => ({
      provider: failure.provider,
      reason: failure.reason,
    })),
  };
}

registerScopedService(
  LifecycleScope.App,
  IProviderDiscoveryService,
  ProviderDiscoveryService,
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
