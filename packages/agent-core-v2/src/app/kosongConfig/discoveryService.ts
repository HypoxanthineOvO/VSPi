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
import { AuthErrors } from '#/app/auth/errors';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { effectiveModelConfig } from '#/kosong/model/modelAuth';
import {
  IProviderService,
  type ModelSource,
  type OAuthRef,
  type ProviderConfig,
} from '#/kosong/provider/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';

import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  THINKING_SECTION,
} from './configSection';
import { ModelsDevImportErrors } from './errors';
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
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
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
    if (options.providerId !== undefined) {
      const provider = this.providerService.get(options.providerId);
      if (provider === undefined) {
        throw new Error2(
          ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
          `provider ${options.providerId} does not exist`,
        );
      }
      if (this.effectiveModelSource(provider) === 'static') {
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
    if (response.changed.length > 0) {
      this.events.publish(new ModelCatalogChanged({ payload: response }));
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
      .filter(([, provider]) => this.effectiveModelSource(provider) === 'static')
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
