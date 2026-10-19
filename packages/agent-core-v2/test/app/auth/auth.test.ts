import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { OAuthCredential, OAuthAuth } from '@earendil-works/pi-ai';
import {
  clearManagedKimiCodeConfig,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IAuthSummaryService, IOAuthService, IOAuthToolkit } from '#/app/auth/auth';
import { AuthSummaryService, OAuthService } from '#/app/auth/authService';
import {
  SERVICES_SECTION,
  PROXY_SECTION,
  servicesFromToml,
  servicesToToml,
  ServicesConfigSchema,
  type ServicesConfig,
} from '#/app/auth/configSection';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';
import { WebSearchProviderService } from '#/app/auth/webSearch/webSearchService';
import { IAuthLegacyService } from '#/app/authLegacy/authLegacy';
import { AuthLegacyService } from '#/app/authLegacy/authLegacyService';
import { IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { IEventService } from '#/app/event/event';
import type { Event2 } from '#/app/event/event2';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IModelService, type ModelRecord } from '#/llm-adapter/model/model';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IProviderService, type ProviderConfig, type ProvidersChangedEvent } from '#/llm-adapter/provider/provider';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';


import { registerBootstrapServices } from '../bootstrap/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';
import { stubAgentIdentity } from '../../app/agentIdentity/stubs';

const OAUTH_PROVIDER = 'managed:kimi-code';
const piMocks = vi.hoisted(() => ({ oauth: undefined as OAuthAuth | undefined, provider: 'anthropic' }));
vi.mock('@earendil-works/pi-ai/providers/all', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>();
  return {
    ...original,
    builtinProviders: () => original.builtinProviders().map((provider) =>
      provider.id === piMocks.provider && piMocks.oauth !== undefined
        ? { ...provider, auth: { oauth: piMocks.oauth } } : provider,
    ),
  };
});
const NON_OAUTH_PROVIDER = 'openai-main';

const deviceAuth = {
  userCode: 'ABCD-EFGH',
  deviceCode: 'device-code',
  verificationUri: 'https://example.com/device',
  verificationUriComplete: 'https://example.com/device?code=ABCD-EFGH',
  expiresIn: 900,
  interval: 5,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const EXAMPLE_COM_SCOPED_REF = {
  storage: 'file',
  key: resolveKimiCodeOAuthKey({ baseUrl: 'https://api.example.com' }),
  oauthHost: 'https://auth.kimi.com',
} as const;

const ENV_SCOPED_REF = {
  storage: 'file',
  key: resolveKimiCodeOAuthKey({
    oauthHost: 'https://env-auth.example.com',
    baseUrl: 'https://env-api.example.com/coding/v1',
  }),
  oauthHost: 'https://env-auth.example.com',
} as const;

const OVERSEAS_SCOPED_REF = {
  storage: 'file',
  key: resolveKimiCodeOAuthKey({
    oauthHost: 'https://auth.kimi.ai',
    baseUrl: 'https://api.kimi.ai/coding/v1',
  }),
  oauthHost: 'https://auth.kimi.ai',
} as const;

interface FakeToolkit {
  readonly login: Mock<(...args: any[]) => any>;
  readonly logout: ReturnType<typeof vi.fn>;
  readonly getCachedAccessToken: ReturnType<typeof vi.fn>;
  readonly tokenProvider: ReturnType<typeof vi.fn>;
  readonly getManagedUsage: ReturnType<typeof vi.fn>;
  readonly getManagedUserInfo: ReturnType<typeof vi.fn>;
}

describe('OAuthService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelRecord>;
  let services: Record<string, unknown> | undefined;
  let defaultModel: string | undefined;
  let thinking: { enabled?: boolean; effort?: string } | undefined;
  let oauthNetwork: { openaiProxyPort: number } | undefined;
  let proxy: { url: string } | undefined;
  let toolkit: FakeToolkit;
  let providerSet: ReturnType<typeof vi.fn<(name: string, config: ProviderConfig) => Promise<void>>>;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn<(domain: string, value: unknown) => Promise<void>>>;
  let events: Event2[];
  let providerChangedEmitter: Emitter<ProvidersChangedEvent>;
  let documents: Map<string, unknown>;
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'example-codex-auth-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    disposables = new DisposableStore();
    documents = new Map();
    providerChangedEmitter = new Emitter<ProvidersChangedEvent>();
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    providerSet = vi.fn(async (name: string, config: ProviderConfig) => {
      providers = { ...providers, [name]: config };
    });
    models = {};
    services = undefined;
    defaultModel = undefined;
    thinking = undefined;
    oauthNetwork = undefined;
    proxy = undefined;
    configSet = vi.fn(async (domain: string, value: unknown) => {
      if (domain === 'defaultModel') {
        defaultModel = value as string | undefined;
        return;
      }
      if (domain === 'thinking') {
        thinking = value as { enabled?: boolean; effort?: string } | undefined;
        return;
      }
      throw new Error(`unexpected config set: ${domain}`);
    });
    configReplace = vi.fn(async (domain: string, value: unknown) => {
      if (domain === 'providers') {
        providers = value as Record<string, ProviderConfig>;
        return;
      }
      if (domain === 'models') {
        models = value as Record<string, ModelRecord>;
        return;
      }
      if (domain === 'services') {
        services = value as Record<string, unknown> | undefined;
        return;
      }
      if (domain === 'defaultModel') {
        defaultModel = value as string | undefined;
        return;
      }
      if (domain === 'thinking') {
        thinking = value as { enabled?: boolean; effort?: string } | undefined;
        return;
      }
      throw new Error(`unexpected config replace: ${domain}`);
    });
    events = [];
    toolkit = {
      login: vi.fn<(...args: any[]) => any>(),
      logout: vi.fn().mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true }),
      getCachedAccessToken: vi.fn().mockResolvedValue(undefined),
      tokenProvider: vi.fn().mockReturnValue({ getAccessToken: async () => 'access-token' }),
      getManagedUsage: vi.fn().mockResolvedValue({ kind: 'error', message: 'not configured' }),
      getManagedUserInfo: vi.fn().mockResolvedValue({ kind: 'error', message: 'not configured' }),
    };
    ix = createServices(disposables, {
      base: [registerBootstrapServices, registerTelemetryServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IAtomicDocumentStore, {
          get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
          set: async (_scope, key, value) => { documents.set(key, structuredClone(value)); },
          delete: async (_scope, key) => { documents.delete(key); },
        });
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
          list: (() => providers) as IProviderService['list'],
          set: providerSet as unknown as IProviderService['set'],
          onDidChangeProviders: providerChangedEmitter.event as IProviderService['onDidChangeProviders'],
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => configBacking()[domain]) as IConfigService['get'],
          inspect: ((domain: string) => ({
            value: configBacking()[domain],
            defaultValue: undefined,
            userValue: configBacking()[domain],
            memoryValue: undefined,
          })) as IConfigService['inspect'],
          set: configSet as unknown as IConfigService['set'],
          replace: configReplace as unknown as IConfigService['replace'],
          replaceSections: async (sections) => { for (const [domain, value] of Object.entries(sections)) await configReplace(domain, value); },
          reload: vi.fn().mockResolvedValue(undefined) as unknown as IConfigService['reload'],
          onDidChangeConfiguration: (() => ({ dispose: () => { } })) as IConfigService['onDidChangeConfiguration'],
          onDidSectionChange: (() => ({ dispose: () => { } })) as IConfigService['onDidSectionChange'],
        });
        reg.definePartialInstance(ILogService, {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        });
        reg.definePartialInstance(IEventService, {
          publish: (event: Event2) => events.push(event),
          subscribe: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(IOAuthToolkit, toolkit as unknown as IOAuthToolkit);
        reg.definePartialInstance(ITelemetryService, { track2: vi.fn() });
        reg.define(IOAuthService, OAuthService);
      },
    });
  });
  afterEach(async () => {
    disposables.dispose();
    await rm(codexHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    piMocks.oauth = undefined;
    piMocks.provider = 'anthropic';
  });

  function createService(): IOAuthService {
    return ix.get(IOAuthService);
  }

  it('persists a local credential reference without copying tokens and removes only that reference', async () => {
    const { registerLocalCredentialDetector } = await import('#/app/auth/localCredentials');
    const unregister = registerLocalCredentialDetector({ id: 'example-local', provider: 'anthropic', name: 'Example CLI', detect: async () => ({}), resolve: async () => ({ apiKey: 'EXAMPLE_LOCAL_TOKEN' }) });
    try {
      const service = createService();
      await service.useLocalCredential('example-local');
      expect(providers['anthropic']?.oauth).toEqual({ storage: 'file', key: 'local-cli/example-local' });
      expect(JSON.stringify(providers)).not.toContain('EXAMPLE_LOCAL_TOKEN');
      expect(documents.size).toBe(0);
      expect(await service.resolveRequestAuth('anthropic')).toEqual({ apiKey: 'EXAMPLE_LOCAL_TOKEN' });
      await service.logout('anthropic');
      expect(providers['anthropic']?.oauth).toBeUndefined();
      expect(await service.listLocalCredentials()).toContainEqual(expect.objectContaining({ id: 'example-local' }));
    } finally { unregister(); }
  });

  it('keeps the previous provider connection when local validation fails', async () => {
    const { registerLocalCredentialDetector } = await import('#/app/auth/localCredentials');
    providers['anthropic'] = { type: 'anthropic', apiKey: 'EXAMPLE_EXISTING_KEY' };
    const unregister = registerLocalCredentialDetector({ id: 'example-invalid', provider: 'anthropic', name: 'Example CLI', detect: async () => ({}), resolve: async () => undefined });
    try {
      await expect(createService().useLocalCredential('example-invalid')).rejects.toThrow();
      expect(providers['anthropic']).toEqual({ type: 'anthropic', apiKey: 'EXAMPLE_EXISTING_KEY' });
      expect(providerSet).not.toHaveBeenCalled();
      expect(documents.size).toBe(0);
    } finally { unregister(); }
  });

  it.each([401, 403])('keeps the working provider when Kimi local credential validation returns HTTP %s', async status => {
    const { LocalCredentialRegistry } = await import('#/app/auth/localCredentials');
    vi.spyOn(LocalCredentialRegistry.prototype, 'detect').mockResolvedValue([{ id: 'kimi-cli', provider: 'kimi-coding', name: 'Kimi CLI' }]);
    vi.spyOn(LocalCredentialRegistry.prototype, 'resolve').mockResolvedValue({ apiKey: 'EXAMPLE_REVOKED_TOKEN', baseUrl: 'https://api.example.test/coding' });
    const request = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal('fetch', request);
    providers['kimi-coding'] = { type: 'kimi-coding', apiKey: 'EXAMPLE_WORKING_KEY' };
    const before = structuredClone(providers);
    await expect(createService().useLocalCredential('kimi-cli')).rejects.toThrow(`HTTP ${status}`);
    expect(request).toHaveBeenCalledWith('https://api.example.test/coding/models', expect.objectContaining({ headers: { Authorization: 'Bearer EXAMPLE_REVOKED_TOKEN' }, redirect: 'error' }));
    expect(providers).toEqual(before);
    expect(documents.size).toBe(0);
  });

  it('does not commit a cancelled local credential after a successful delayed validation', async () => {
    const { LocalCredentialRegistry } = await import('#/app/auth/localCredentials');
    vi.spyOn(LocalCredentialRegistry.prototype, 'detect').mockResolvedValue([{ id: 'kimi-cli', provider: 'kimi-coding', name: 'Kimi CLI' }]);
    vi.spyOn(LocalCredentialRegistry.prototype, 'resolve').mockResolvedValue({ apiKey: 'EXAMPLE_NEW_TOKEN', baseUrl: 'https://api.example.test/coding' });
    let release!: () => void;
    const request = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', request);
    providers['kimi-coding'] = { type: 'kimi-coding', apiKey: 'EXAMPLE_WORKING_KEY' };
    const before = structuredClone(providers);
    const service = createService();
    const pending = service.useLocalCredential('kimi-cli', 'example-cancel-operation');
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    service.cancelLocalCredential('example-cancel-operation');
    expect((request.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
    release();
    await rejected;
    expect(providers).toEqual(before);
    expect(models).toEqual({});
    expect(documents.size).toBe(0);
  });

  it('validates a Kimi local candidate before publishing only its reference', async () => {
    const { LocalCredentialRegistry } = await import('#/app/auth/localCredentials');
    vi.spyOn(LocalCredentialRegistry.prototype, 'detect').mockResolvedValue([{ id: 'kimi-cli', provider: 'kimi-coding', name: 'Kimi CLI' }]);
    vi.spyOn(LocalCredentialRegistry.prototype, 'resolve').mockResolvedValue({ apiKey: 'EXAMPLE_VALID_TOKEN', baseUrl: 'https://api.example.test/coding' });
    providers['kimi-coding'] = { type: 'kimi-coding', apiKey: 'EXAMPLE_WORKING_KEY' };
    const request = vi.fn(async () => {
      expect(providers['kimi-coding']?.apiKey).toBe('EXAMPLE_WORKING_KEY');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', request);
    await createService().useLocalCredential('kimi-cli');
    expect(providers['kimi-coding']?.oauth).toEqual({ storage: 'file', key: 'local-cli/kimi-cli' });
    expect(Object.keys(models).some(key => key.startsWith('kimi-coding/'))).toBe(true);
    expect(JSON.stringify(providers)).not.toContain('EXAMPLE_VALID_TOKEN');
  });

  it('keeps a working Copilot provider when a fresh local token exchange is rejected', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', codexHome);
    await mkdir(join(codexHome, 'github-copilot'), { recursive: true });
    await writeFile(join(codexHome, 'github-copilot', 'hosts.json'), JSON.stringify({ 'github.com': { oauth_token: 'EXAMPLE_REVOKED_TOKEN' } }));
    piMocks.provider = 'github-copilot';
    const refresh = vi.fn(async () => { throw new Error('Rejected token'); });
    piMocks.oauth = { name: 'Example Copilot', login: vi.fn(), refresh, toAuth: vi.fn() };
    providers['github-copilot'] = { type: 'github-copilot', apiKey: 'EXAMPLE_WORKING_KEY' };
    const before = structuredClone(providers);
    await expect(createService().useLocalCredential('github-copilot-cli')).rejects.toThrow();
    expect(refresh).toHaveBeenCalledOnce();
    expect(providers).toEqual(before);
    expect(documents.size).toBe(0);
  });

  it('uses browser login even when valid Codex CLI credentials are available', async () => {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify(codexFile()));
    piMocks.provider = 'openai-codex';
    const login = vi.fn(async () => ({ ...piCredentials, expires: Date.now() + 3600_000 }));
    registerPi(login);
    const service = createService();
    await service.startLogin('openai-codex', { source: 'browser' });
    expect(login).toHaveBeenCalledOnce();
    expect(documents.get(providers['openai-codex']!.oauth!.key)).not.toHaveProperty('codexAuthPath');
    expect(providers['openai-codex']?.source?.['credential']).toBe('browser');
  });

  it.each(['validation', 'persistence'])('preserves previous OAuth credentials on candidate %s failure', async failure => {
    registerPi(async () => ({ ...piCredentials, access: 'EXAMPLE_OLD_TOKEN', expires: Date.now() + 3600_000 }));
    const service = createService();
    await service.startLogin('anthropic');
    const previous = structuredClone(providers);
    const previousDocuments = structuredClone([...documents.entries()]);
    registerPi(async () => ({ ...piCredentials, access: 'EXAMPLE_NEW_TOKEN', expires: Date.now() + 3600_000 }));
    if (failure === 'validation') piMocks.oauth!.toAuth = async () => { throw new Error('Invalid candidate'); };
    else vi.spyOn(ix.get(IConfigService), 'replaceSections').mockRejectedValueOnce(new Error('Atomic write failed'));
    await expect(service.startLogin('anthropic', { source: 'browser' })).rejects.toThrow('OAuth login failed');
    expect(providers).toEqual(previous);
    expect([...documents.entries()]).toEqual(previousDocuments);
    expect(await service.getCachedAccessToken('anthropic')).toBe('EXAMPLE_OLD_TOKEN');
  });

  it.each(['rejected', 'cancelled'])('keeps the working Devin config when a local link is %s', async failure => {
    const { LocalCredentialRegistry } = await import('#/app/auth/localCredentials');
    const devin = await import('#/app/auth/devinCredential');
    const catalog = await import('#/llm-adapter/provider/devin/catalog');
    vi.spyOn(LocalCredentialRegistry.prototype, 'detect').mockResolvedValue([{ id: 'devin-cli', provider: 'devin', name: 'Devin CLI' }]);
    const path = join(codexHome, 'local-devin.toml');
    vi.spyOn(devin, 'devinAuthPath').mockReturnValue(path);
    await writeFile(path, `windsurf_api_key = "header.${Buffer.from(JSON.stringify({ session_id: 'example-session' })).toString('base64url')}.signature"`);
    let release!: () => void;
    const discovery = vi.spyOn(catalog, 'fetchDevinModels').mockImplementation(async () => {
      if (failure === 'rejected') throw new Error('HTTP 401');
      await new Promise<void>(resolve => { release = resolve; });
      return { 'devin/example': { provider: 'devin', model: 'example' } };
    });
    providers['devin'] = { type: 'devin', apiKey: 'EXAMPLE_WORKING_KEY' };
    const before = structuredClone(providers);
    const service = createService();
    const pending = service.useLocalCredential('devin-cli', 'example-devin-operation');
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(discovery).toHaveBeenCalledOnce());
    if (failure === 'cancelled') {
      service.cancelLocalCredential('example-devin-operation');
      expect(discovery.mock.calls[0]?.[3]?.aborted).toBe(true);
      release();
    }
    await rejected;
    expect(providers).toEqual(before);
    expect(models['devin/example']).toBeUndefined();
    expect(documents.size).toBe(0);
  });

  it('does not publish a cancelled Devin candidate after model discovery finishes', async () => {
    const devin = await import('#/app/auth/devinCredential');
    const catalog = await import('#/llm-adapter/provider/devin/catalog');
    const path = join(codexHome, 'cancelled-devin.toml');
    vi.spyOn(devin, 'devinAuthPath').mockReturnValue(path);
    await writeFile(path, `windsurf_api_key = "header.${Buffer.from(JSON.stringify({ session_id: 'example-session' })).toString('base64url')}.signature"`);
    let release!: () => void;
    const discovery = vi.spyOn(catalog, 'fetchDevinModels').mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { 'devin/example': { provider: 'devin', model: 'example' } };
    });
    providers['devin'] = { type: 'devin', apiKey: 'EXAMPLE_OLD_TOKEN' };
    const service = createService();
    const pending = service.startLogin('devin');
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(discovery).toHaveBeenCalledOnce());
    await service.cancelLogin('devin');
    release();
    await rejected;
    await vi.waitFor(() => expect(documents.size).toBe(0));
    expect(providers['devin']).toEqual({ type: 'devin', apiKey: 'EXAMPLE_OLD_TOKEN' });
    expect(models['devin/example']).toBeUndefined();
  });

  function registerPi(login: OAuthAuth['login'], refreshToken?: OAuthAuth['refresh']): void {
    piMocks.oauth = {
          name: 'Example OAuth', login,
          refresh: refreshToken ?? (async (credentials) => ({ ...credentials, access: 'refreshed-access', expires: Date.now() + 3600_000 })),
          toAuth: async (credentials) => ({ apiKey: `runtime:${credentials.access}`, headers: { 'X-Example-Account': 'example-account' }, baseUrl: 'https://example.com/api' }),
    };
  }

  const piCredentials: OAuthCredential = {
    type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 1,
  };

  function codexFile(accountId = 'example-account', exp = Math.floor(Date.now() / 1000) + 3600) {
    const claims = { exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } };
    const access = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
    return { auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: 'example-refresh', account_id: accountId } };
  }

  it('links Devin credentials without copying tokens, provisions models and rereads after auth failure', async () => {
    const devin = await import('#/app/auth/devinCredential');
    const { field, message } = await import('#/llm-adapter/provider/devin/protobuf');
    const path = join(codexHome, 'credentials.toml');
    vi.spyOn(devin, 'devinAuthPath').mockReturnValue(path);
    const jwt = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    await writeFile(path, `windsurf_api_key = "${token}"`);
    const fetchMock = vi.fn(async () => new Response(field(1, message(field(1, 'Example'), field(22, 'example-model')))));
    vi.stubGlobal('fetch', fetchMock);
    models['my-alias'] = { provider: 'devin', model: 'example-model', displayName: 'My label' };
    defaultModel = 'my-alias';
    const service = createService();
    expect(await service.startLogin('devin')).toMatchObject({ status: 'authenticated' });
    expect(documents.get('pi-ai/devin/devin')).toMatchObject({ devinAuthPath: path, access: '', refresh: '' });
    expect(JSON.stringify([...documents.values()])).not.toContain(token);
    expect(models['devin/example-model']).toMatchObject({ provider: 'devin', displayName: 'Example' });
    expect(models['my-alias']).toMatchObject({ displayName: 'My label' });
    expect(defaultModel).toBe('my-alias');
    const updated = jwt(Math.floor(Date.now() / 1000) + 7200);
    await writeFile(path, `windsurf_api_key = "${updated}"`);
    expect(await service.resolveRequestAuth('devin', undefined, { force: true })).toMatchObject({ apiKey: updated });
    await writeFile(path, `windsurf_api_key = "${jwt(1)}"`);
    await expect(service.resolveRequestAuth('devin')).rejects.toThrow('re-login required');
    expect(await service.getCachedAccessToken('devin')).toBeUndefined();
    await service.logout('devin');
    expect(await readFile(path, 'utf8')).toContain('windsurf_api_key');
  });

  it.each(['shared', 'legacy', 'disabled'] as const)('scopes Devin discovery to the %s account proxy preference', async preference => {
    const devin = await import('#/app/auth/devinCredential');
    const scoped = await import('#/_base/utils/scopedProxy');
    const catalog = await import('#/llm-adapter/provider/devin/catalog');
    const path = join(codexHome, 'devin-proxy.toml');
    vi.spyOn(devin, 'devinAuthPath').mockReturnValue(path);
    await writeFile(path, `windsurf_api_key = "header.${Buffer.from(JSON.stringify({ session_id: 'example-session' })).toString('base64url')}.signature"`);
    proxy = preference === 'legacy' ? undefined : { url: preference === 'disabled' ? '' : 'https://proxy.example.test:8443' };
    oauthNetwork = { openaiProxyPort: 7890 };
    const expected = preference === 'shared' ? 'https://proxy.example.test:8443' : preference === 'legacy' ? 'http://127.0.0.1:7890' : undefined;
    let activeProxy: string | undefined;
    const scope = vi.spyOn(scoped, 'withScopedProxy').mockImplementation(async (url, run) => {
      activeProxy = url;
      try { return await run(); } finally { activeProxy = undefined; }
    });
    const discover = vi.spyOn(catalog, 'fetchDevinModels').mockImplementation(async () => {
      expect(activeProxy).toBe(expected);
      return {};
    });
    expect(await createService().startLogin('devin')).toMatchObject({ status: 'authenticated' });
    expect(discover).toHaveBeenCalledOnce();
    expect(scope).toHaveBeenCalledWith(expected, expect.any(Function));
  });

  it('supports Devin PKCE manual callbacks, exchanges JSON and rejects expired browser credentials', async () => {
    const devin = await import('#/app/auth/devinCredential');
    vi.spyOn(devin, 'devinAuthPath').mockReturnValue(join(codexHome, 'missing.toml'));
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
    const { field, message } = await import('#/llm-adapter/provider/devin/protobuf');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === 'https://api.devin.ai/auth/cli/token') {
        expect(typeof init?.body).toBe('string');
        expect(JSON.parse(init?.body as string)).toMatchObject({ code: 'example-code', code_verifier: expect.any(String) });
        return Response.json({ token });
      }
      return new Response(field(1, message(field(1, 'Example'), field(22, 'example-model'))));
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = createService();
    const started = await service.startLogin('devin');
    expect(started.status).toBe('pending');
    const flow = service.getFlow('devin')!;
    const url = new URL(flow.auth_url!);
    expect(url.origin + url.pathname).toBe('https://app.devin.ai/auth/cli/continue');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    service.submitLogin('devin', flow.flow_id, flow.prompt!.id, `example-code#${url.searchParams.get('state')}`);
    await vi.waitFor(() => expect(service.getFlow('devin')?.status).toBe('authenticated'));
    expect(await service.resolveRequestAuth('devin')).toMatchObject({ apiKey: token });
    await expect(service.resolveRequestAuth('devin', undefined, { force: true })).rejects.toThrow('re-login required');
    expect(() => devin.devinCredential('header.eyJleHAiOjF9.signature')).toThrow('re-login required');
    expect(() => devin.devinCallback('code#wrong-state', 'expected-state')).toThrow('state');
    expect(() => devin.devinCallback('http://127.0.0.1/callback?code=example', 'expected-state')).toThrow('state');
  });

  it('reuses Codex without a browser or copying tokens and follows same-account token updates', async () => {
    const path = join(codexHome, 'auth.json');
    const original = codexFile();
    await writeFile(path, JSON.stringify(original));
    piMocks.provider = 'openai-codex';
    const login = vi.fn(async () => piCredentials);
    const refresh = vi.fn();
    registerPi(login, refresh);
    const service = createService();
    expect(await service.startLogin('openai-codex')).toMatchObject({ status: 'authenticated' });
    expect(login).not.toHaveBeenCalled();
    expect(JSON.stringify([...documents.values()])).not.toContain(original.tokens.access_token);
    expect(JSON.stringify([...documents.values()])).not.toContain(original.tokens.refresh_token);
    expect(await service.getCachedAccessToken('openai-codex')).toBe(original.tokens.access_token);
    const updated = codexFile('example-account', Math.floor(Date.now() / 1000) + 7200);
    await writeFile(path, JSON.stringify(updated));
    expect(await service.resolveRequestAuth('openai-codex')).toMatchObject({ apiKey: `runtime:${updated.tokens.access_token}`, baseUrl: 'https://chatgpt.com/backend-api' });
    await expect(service.resolveRequestAuth('openai-codex', undefined, { force: true })).rejects.toThrow('Codex authentication was rejected');
    expect(refresh).not.toHaveBeenCalled();
    await service.logout('openai-codex');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated);
    expect(await service.getCachedAccessToken('openai-codex')).toBeUndefined();
  });

  it.each(['expired', 'changed-account', 'removed'])('rejects %s Codex credentials without refreshing shared tokens', async state => {
    const path = join(codexHome, 'auth.json');
    await writeFile(path, JSON.stringify(codexFile()));
    piMocks.provider = 'openai-codex';
    const refresh = vi.fn();
    registerPi(async () => piCredentials, refresh);
    const service = createService();
    await service.startLogin('openai-codex');
    if (state === 'removed') await rm(path);
    else await writeFile(path, JSON.stringify(state === 'expired' ? codexFile('example-account', 1) : codexFile('other-account')));
    await expect(service.resolveRequestAuth('openai-codex')).rejects.toThrow('Codex login is unavailable');
    expect(await service.getCachedAccessToken('openai-codex')).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('allows an explicit new login after linking Codex even while its file remains valid', async () => {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify(codexFile()));
    piMocks.provider = 'openai-codex';
    const login = vi.fn(async () => piCredentials);
    registerPi(login);
    const service = createService();
    await service.startLogin('openai-codex');
    expect(login).not.toHaveBeenCalled();
    await service.startLogin('openai-codex');
    expect(login).toHaveBeenCalledOnce();
    expect(documents.get(providers['openai-codex']!.oauth!.key)).not.toHaveProperty('codexAuthPath');
  });

  it.each(['missing', 'invalid', 'api-key', 'expired', 'wrong-account'])('falls back to ordinary login for %s Codex state', async state => {
    if (state !== 'missing') {
      const value = state === 'invalid' ? '{' : JSON.stringify(state === 'api-key'
        ? { ...codexFile(), auth_mode: 'apikey', OPENAI_API_KEY: 'example-key' }
        : state === 'expired' ? codexFile('example-account', 1)
        : { ...codexFile(), tokens: { ...codexFile().tokens, account_id: 'other-account' } });
      await writeFile(join(codexHome, 'auth.json'), value);
    }
    piMocks.provider = 'openai-codex';
    const login = vi.fn(async () => piCredentials);
    registerPi(login);
    expect(await createService().startLogin('openai-codex')).toMatchObject({ status: 'authenticated' });
    expect(login).toHaveBeenCalledOnce();
  });

  it('supplies a stable installation ID to the OpenAI ChatGPT login', async () => {
    piMocks.provider = 'openai';
    const ids: Array<string | undefined> = [];
    registerPi(async (_interaction, options) => {
      ids.push(options?.getDeviceId?.());
      return piCredentials;
    });
    const service = createService();
    await service.startLogin('openai');
    await service.startLogin('openai');
    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it('completes the real Codex device-code flow without a browser callback', async () => {
    const access = codexFile().tokens.access_token;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'example-device', user_code: 'EXAMPLE', interval: 0 });
      if (path.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'example-code', code_verifier: 'example-verifier' });
      if (path === '/oauth/token') return Response.json({ access_token: access, refresh_token: 'example-refresh', expires_in: 3600 });
      throw new Error('Unexpected OAuth endpoint');
    });
    vi.stubGlobal('fetch', fetcher);
    const service = createService();
    const started = await service.startLogin('openai-codex');
    expect(started.status).toBe('pending');
    const flow = service.getFlow('openai-codex')!;
    expect(flow.prompt?.options).toContainEqual(expect.objectContaining({ id: 'device_code' }));
    service.submitLogin('openai-codex', flow.flow_id, flow.prompt!.id, 'device_code');
    await vi.waitFor(() => {
      expect(service.getFlow('openai-codex')?.status).toBe('authenticated');
    });
    expect(service.getFlow('openai-codex')).toMatchObject({ user_code: 'EXAMPLE', verification_uri: 'https://auth.openai.com/codex/device' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await service.resolveRequestAuth('openai-codex')).toMatchObject({ apiKey: access });
  });

  it('lists the public pi OAuth providers alongside Kimi', () => {
    expect(createService().listLoginProviders().map((entry) => entry.id))
      .toEqual(expect.arrayContaining(['managed:kimi-code', 'anthropic', 'openai-codex', 'github-copilot']));
  });

  it('keeps the OpenAI proxy attached to refreshed request auth without storing it in credentials', async () => {
    piMocks.provider = 'openai-codex';
    oauthNetwork = { openaiProxyPort: 7890 };
    const refresh = vi.fn(async (credential: OAuthCredential) => ({ ...credential, access: 'new-access', expires: Date.now() + 3600000 }));
    registerPi(async () => piCredentials, refresh);
    providers['openai-codex'] = { type: 'openai-codex', oauth: { storage: 'file', key: 'pi-ai/openai-codex/openai-codex' } };
    documents.set('pi-ai/openai-codex/openai-codex', piCredentials);
    const service = createService();
    expect(await service.resolveRequestAuth('openai-codex', providers['openai-codex'].oauth)).toMatchObject({ apiKey: 'runtime:new-access', proxyUrl: 'http://127.0.0.1:7890' });
    expect(refresh).toHaveBeenCalledOnce();
    expect(documents.get('pi-ai/openai-codex/openai-codex')).not.toHaveProperty('proxyUrl');
    oauthNetwork = { openaiProxyPort: 0 };
    expect((await service.resolveRequestAuth('openai-codex', providers['openai-codex'].oauth)).proxyUrl).toBeUndefined();
  });

  it.each(['anthropic', 'openai-codex', 'xai'])('uses the shared remote proxy for %s request auth', async provider => {
    piMocks.provider = provider;
    proxy = { url: 'https://proxy.example.com:8443' };
    registerPi(async () => piCredentials, async credential => ({ ...credential, expires: Date.now() + 3600000 }));
    const key = `pi-ai/${provider}/${provider}`;
    const oauth = { storage: 'file', key } as const;
    providers[provider] = { type: provider, oauth };
    documents.set(key, { ...piCredentials, expires: Date.now() + 3600000 });
    expect(await createService().resolveRequestAuth(provider, oauth)).toMatchObject({ proxyUrl: 'https://proxy.example.com:8443' });
  });

  it.each(['anthropic', 'openai-codex', 'xai'])('routes %s OAuth login through the configured proxy', async provider => {
    const original = getGlobalDispatcher();
    const gateway = createServer();
    gateway.on('connect', (_request, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied'));
    });
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('Missing local proxy');
    try {
      piMocks.provider = provider;
      proxy = { url: `http://localhost:${address.port}` };
      let route: string | undefined;
      registerPi(async () => {
        route = await (await fetch('http://oauth.example.test/authorize')).text();
        return { ...piCredentials, expires: Date.now() + 3600000 };
      });
      expect(await createService().startLogin(provider)).toMatchObject({ status: 'authenticated' });
      expect(route).toBe('proxied');
    } finally {
      setGlobalDispatcher(original); gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
  });

  it('honors a saved shared skip even when a legacy OpenAI port exists', async () => {
    piMocks.provider = 'openai-codex';
    oauthNetwork = { openaiProxyPort: 7890 };
    proxy = { url: '' };
    registerPi(async () => piCredentials);
    const oauth = { storage: 'file', key: 'pi-ai/openai-codex/openai-codex' } as const;
    providers['openai-codex'] = { type: 'openai-codex', oauth };
    documents.set(oauth.key, { ...piCredentials, expires: Date.now() + 3600000 });
    expect((await createService().resolveRequestAuth('openai-codex', oauth)).proxyUrl).toBeUndefined();
  });

  it('bridges browser and prompt login without exposing credentials in flow or config', async () => {
    providers['anthropic'] = { type: 'anthropic', apiKeyEnv: 'EXAMPLE_API_KEY' };
    registerPi(async (callbacks) => {
      callbacks.notify({ type: 'auth_url', url: 'https://example.com/authorize', instructions: 'Authorize the application.' });
      expect(await callbacks.prompt({ type: 'manual_code', message: 'Paste the code.' })).toBe('example-code');
      return piCredentials;
    });
    const service = createService();
    const start = await service.startLogin('anthropic');
    expect(start).toMatchObject({ status: 'pending', auth_url: 'https://example.com/authorize', user_code: '' });
    const pending = service.getFlow('anthropic')!;
    service.submitLogin('anthropic', pending.flow_id, pending.prompt!.id, 'example-code');
    await vi.waitFor(() => expect(service.getFlow('anthropic')?.status).toBe('authenticated'));
    expect(providers['anthropic']).toMatchObject({ type: 'anthropic', oauth: { key: 'pi-ai/anthropic/anthropic' } });
    expect(providers['anthropic']?.apiKey).toBeUndefined();
    expect(providers['anthropic']?.apiKeyEnv).toBeUndefined();
    expect(documents.get('pi-ai/anthropic/anthropic')).toEqual(piCredentials);
    expect(JSON.stringify(service.getFlow('anthropic'))).not.toContain('private-');
    expect(Object.keys(models).some((key) => key.startsWith('anthropic/'))).toBe(true);
    expect(defaultModel).toMatch(/^anthropic\//);
    expect(toolkit.login).not.toHaveBeenCalled();
  });

  it('supports prompts before a device authorization URL and rejects stale input', async () => {
    registerPi(async (callbacks) => {
      expect(await callbacks.prompt({ type: 'text', message: 'Domain' })).toBe('');
      callbacks.notify({ type: 'auth_url', url: 'https://example.com/device', instructions: 'Enter code EXAMPLE.' });
      await callbacks.prompt({ type: 'manual_code', message: 'Complete login.' });
      return piCredentials;
    });
    const service = createService();
    await service.startLogin('anthropic');
    const first = service.getFlow('anthropic')!;
    expect(first.prompt?.allow_empty).toBe(true);
    expect(() => service.submitLogin('anthropic', 'stale', first.prompt!.id, '')).toThrow();
    service.submitLogin('anthropic', first.flow_id, first.prompt!.id, '');
    await flush();
    expect(service.getFlow('anthropic')?.auth_url).toBe('https://example.com/device');
    expect(() => service.submitLogin('anthropic', first.flow_id, first.prompt!.id, '')).toThrow();
    await service.cancelLogin('anthropic');
    expect(service.getFlow('anthropic')?.status).toBe('cancelled');
    expect(documents.size).toBe(0);
  });

  it('ignores late successful login after cancellation', async () => {
    let resolveGrant!: (credentials: OAuthCredential) => void;
    const grant = new Promise<OAuthCredential>((resolve) => { resolveGrant = resolve; });
    registerPi(async (callbacks) => {
      callbacks.notify({ type: 'auth_url', url: 'https://example.com/authorize' });
      return grant;
    });
    const service = createService();
    await service.startLogin('anthropic');
    await service.cancelLogin('anthropic');
    resolveGrant(piCredentials);
    await flush();
    expect(service.getFlow('anthropic')?.status).toBe('cancelled');
    expect(documents.size).toBe(0);
    expect(providers['anthropic']).toBeUndefined();
  });

  it('refreshes expired pi OAuth credentials once for concurrent model requests', async () => {
    const refresh = vi.fn(async (credentials: OAuthCredential) => ({ ...credentials, access: 'new-access', refresh: 'new-refresh', expires: Date.now() + 3600_000 }));
    registerPi(async () => piCredentials, refresh);
    providers['anthropic'] = { type: 'anthropic', oauth: { storage: 'file', key: 'pi-ai/anthropic/anthropic' } };
    documents.set('pi-ai/anthropic/anthropic', piCredentials);
    const tokenProvider = createService().resolveTokenProvider('anthropic')!;
    expect(await Promise.all([tokenProvider.getAccessToken(), tokenProvider.getAccessToken()]))
      .toEqual(['runtime:new-access', 'runtime:new-access']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(documents.get('pi-ai/anthropic/anthropic')).toMatchObject({ refresh: 'new-refresh' });
    await tokenProvider.getAccessToken({ force: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('preserves request headers, removals and account endpoints without persisting them as API keys', async () => {
    registerPi(async () => piCredentials);
    piMocks.oauth!.toAuth = async (credential) => ({
      apiKey: credential.access,
      headers: { Authorization: `Bearer ${credential.access}`, 'X-API-Key': null },
      baseUrl: 'https://example.com/account-api',
    });
    providers['anthropic'] = { type: 'anthropic', oauth: { storage: 'file', key: 'pi-ai/anthropic/anthropic' } };
    documents.set('pi-ai/anthropic/anthropic', { ...piCredentials, expires: Date.now() + 3600_000 });
    const auth = await createService().resolveRequestAuth('anthropic');
    expect(auth).toEqual({
      apiKey: 'private-access', headers: { Authorization: 'Bearer private-access' },
      removeHeaders: ['X-API-Key'], baseUrl: 'https://example.com/account-api',
    });
    expect(providers['anthropic']?.apiKey).toBeUndefined();
    expect(providers['anthropic']?.apiKeyEnv).toBeUndefined();
  });

  it('withdraws only the cancelled native prompt while keeping the browser flow active', async () => {
    const controller = new AbortController();
    let resolveGrant!: (credentials: OAuthCredential) => void;
    const grant = new Promise<OAuthCredential>((resolve) => { resolveGrant = resolve; });
    registerPi(async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://example.com/authorize' });
      void interaction.prompt({ type: 'manual_code', message: 'Code', signal: controller.signal }).catch(() => {});
      return grant;
    });
    const service = createService();
    await service.startLogin('anthropic');
    expect(service.getFlow('anthropic')?.prompt).toBeDefined();
    controller.abort();
    expect(service.getFlow('anthropic')).toMatchObject({ status: 'pending', prompt: undefined });
    resolveGrant(piCredentials);
    await vi.waitFor(() => expect(service.getFlow('anthropic')?.status).toBe('authenticated'));
  });

  it('cancels pi OAuth flows when provider configuration changes', async () => {
    registerPi(async (interaction) => {
      await interaction.prompt({ type: 'manual_code', message: 'Code' });
      return piCredentials;
    });
    const service = createService();
    await service.startLogin('anthropic');
    providerChangedEmitter.fire({ changed: ['anthropic'], added: [], removed: [] });
    expect(service.getFlow('anthropic')?.status).toBe('cancelled');
    expect(documents.size).toBe(0);
  });

  it('invalidates an in-flight refresh when the provider switches to API key auth', async () => {
    let resolveRefresh!: (credentials: OAuthCredential) => void;
    const refreshed = new Promise<OAuthCredential>((resolve) => { resolveRefresh = resolve; });
    const refresh = vi.fn(() => refreshed);
    registerPi(async () => piCredentials, refresh);
    const ref = { storage: 'file' as const, key: 'pi-ai/anthropic/anthropic' };
    providers['anthropic'] = { type: 'anthropic', oauth: ref };
    documents.set(ref.key, piCredentials);
    const request = createService().resolveRequestAuth('anthropic', ref);
    const rejected = expect(request).rejects.toThrow('invalidated');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    providers['anthropic'] = { type: 'anthropic', apiKey: 'YOUR_API_KEY' };
    providerChangedEmitter.fire({ changed: ['anthropic'], added: [], removed: [] });
    resolveRefresh({ ...piCredentials, access: 'late-access' });
    await rejected;
    expect(documents.get(ref.key)).toEqual(piCredentials);
  });

  it('does not resurrect credentials when logout races a refresh', async () => {
    let resolveRefresh!: (credentials: OAuthCredential) => void;
    const refreshed = new Promise<OAuthCredential>((resolve) => { resolveRefresh = resolve; });
    const refresh = vi.fn(() => refreshed);
    registerPi(async () => piCredentials, refresh);
    providers['anthropic'] = { type: 'anthropic', oauth: { storage: 'file', key: 'pi-ai/anthropic/anthropic' } };
    documents.set('pi-ai/anthropic/anthropic', piCredentials);
    const service = createService();
    const token = service.resolveTokenProvider('anthropic')!.getAccessToken();
    const rejected = expect(token).rejects.toThrow('invalidated');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const logout = service.logout('anthropic');
    resolveRefresh({ ...piCredentials, access: 'late-access' });
    await rejected;
    await logout;
    expect(documents.size).toBe(0);
    expect(await service.status('anthropic')).toEqual({ loggedIn: false });
  });

  it('sanitizes pi login failures before returning a flow or RPC error', async () => {
    registerPi(async (callbacks) => {
      callbacks.notify({ type: 'auth_url', url: 'https://example.com/authorize' });
      throw new Error('Authorization failed: private-access private-refresh');
    });
    const service = createService();
    await service.startLogin('anthropic');
    await flush();
    expect(service.getFlow('anthropic')).toMatchObject({ status: 'denied' });
    expect(JSON.stringify(service.getFlow('anthropic'))).not.toContain('private-');
  });

  function configBacking(): Record<string, unknown> {
    return { providers, models, services, defaultModel, thinking, oauthNetwork, proxy };
  }

  function stubManagedModelsFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'kimi-k2',
            context_length: 131072,
            supports_reasoning: true,
            display_name: 'Kimi K2',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const managedK2Alias: ModelRecord = {
    provider: OAUTH_PROVIDER,
    model: 'kimi-k2',
    maxContextSize: 131072,
    capabilities: ['thinking', 'tool_use'],
    displayName: 'Kimi K2',
  };

  const managedK25Alias: ModelRecord = {
    provider: OAUTH_PROVIDER,
    model: 'kimi-k2.5',
    maxContextSize: 262144,
    capabilities: ['thinking', 'tool_use'],
    displayName: 'Kimi K2.5',
  };

  function stubGatedManagedModelsFetch(): {
    fetchMock: ReturnType<typeof vi.fn>;
    releaseFetch: () => void;
  } {
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'kimi-k2',
              context_length: 131072,
              supports_reasoning: true,
              display_name: 'Kimi K2',
            },
            {
              id: 'kimi-k2.5',
              context_length: 262144,
              supports_reasoning: true,
              display_name: 'Kimi K2.5',
            },
            {
              id: 'kimi-k3',
              context_length: 1048576,
              supports_reasoning: true,
              display_name: 'Kimi K3',
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, releaseFetch };
  }

  it('startLogin resolves a device-code flow and flips to authenticated on success', async () => {
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();

    const start = await svc.startLogin(OAUTH_PROVIDER);
    expect(start).toMatchObject({
      provider: OAUTH_PROVIDER,
      verification_uri: deviceAuth.verificationUri,
      verification_uri_complete: deviceAuth.verificationUriComplete,
      user_code: deviceAuth.userCode,
      interval: deviceAuth.interval,
      status: 'pending',
    });
    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: EXAMPLE_COM_SCOPED_REF,
        baseUrl: 'https://api.example.com',
        oauthHost: undefined,
      }),
    );

    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));
  });

  it('provisions the managed provider through the provider service after login', async () => {
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    await flush();

    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        apiKey: '',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
  });

  it('startLogin resolves an env-scoped oauth ref for the managed provider without oauth config', async () => {
    providers[OAUTH_PROVIDER] = { type: 'kimi', baseUrl: 'https://api.example.com' };
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: EXAMPLE_COM_SCOPED_REF,
        baseUrl: 'https://api.example.com',
      }),
    );
    await flush();
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
  });

  it('startLogin reuses the configured oauth ref when it matches the login environment', async () => {
    providers[OAUTH_PROVIDER] = {
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    };
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: { storage: 'file', key: 'oauth/kimi-code' },
        baseUrl: 'https://api.kimi.com/coding/v1',
      }),
    );
  });

  it('startLogin honors KIMI_CODE_BASE_URL / KIMI_CODE_OAUTH_HOST for the login environment', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://env-api.example.com/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://env-auth.example.com');
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: ENV_SCOPED_REF,
        baseUrl: 'https://env-api.example.com/coding/v1',
        oauthHost: 'https://env-auth.example.com',
      }),
    );
    await flush();
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://env-api.example.com/coding/v1',
        oauth: ENV_SCOPED_REF,
      }),
    );
  });

  it('startLogin with region global resolves the global login environment', async () => {
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER, { region: 'global' });

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: OVERSEAS_SCOPED_REF,
        baseUrl: 'https://api.kimi.ai/coding/v1',
        oauthHost: 'https://auth.kimi.ai',
      }),
    );
    await flush();
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.kimi.ai/coding/v1',
        oauth: OVERSEAS_SCOPED_REF,
      }),
    );
  });

  it('startLogin with a region still honors env endpoint overrides', async () => {
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://env-auth.example.com');
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER, { region: 'global' });

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthHost: 'https://env-auth.example.com',
        baseUrl: 'https://api.example.com',
      }),
    );
  });

  it('getRegion resolves cn by default and global from the persisted login host', () => {
    vi.stubEnv('KIMI_CODE_REGION_MARKER', 'off');
    const svc = createService();
    expect(svc.getRegion()).toBe('mainland-cn');

    providers[OAUTH_PROVIDER] = {
      type: 'kimi',
      oauth: { storage: 'file', key: OVERSEAS_SCOPED_REF.key, oauthHost: 'https://auth.kimi.ai' },
    };
    expect(svc.getRegion()).toBe('global');
  });

  it('getRegion reads the install marker from the bootstrapped home unless KIMI_CODE_REGION_MARKER=off', async () => {
    const home = ix.get(IBootstrapService).homeDir;
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'region'), 'global\n', 'utf-8');
      vi.stubEnv('KIMI_CODE_OAUTH_HOST', '');
      providers[OAUTH_PROVIDER] = { type: 'kimi' };
      expect(createService().getRegion()).toBe('global');

      vi.stubEnv('KIMI_CODE_REGION_MARKER', 'off');
      expect(createService().getRegion()).toBe('mainland-cn');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('getRegion reads the marker from the bootstrapped home, not KIMI_CODE_HOME', async () => {
    const bootstrapHome = ix.get(IBootstrapService).homeDir;
    const envHome = await mkdtemp(join(tmpdir(), 'kimi-v2-auth-envhome-'));
    try {
      await mkdir(bootstrapHome, { recursive: true });
      await writeFile(join(bootstrapHome, 'region'), 'global\n', 'utf-8');
      vi.stubEnv('KIMI_CODE_HOME', envHome);
      vi.stubEnv('KIMI_CODE_OAUTH_HOST', '');
      providers[OAUTH_PROVIDER] = { type: 'kimi' };
      expect(createService().getRegion()).toBe('global');
    } finally {
      await rm(bootstrapHome, { recursive: true, force: true });
      await rm(envHome, { recursive: true, force: true });
    }
  });

  it('getRegion resolves cn from the default-slot oauth ref despite an global marker', async () => {
    const home = ix.get(IBootstrapService).homeDir;
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'region'), 'global\n', 'utf-8');
      vi.stubEnv('KIMI_CODE_OAUTH_HOST', '');
      providers[OAUTH_PROVIDER] = {
        type: 'kimi',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      };
      expect(createService().getRegion()).toBe('mainland-cn');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('resolves the runtime credential slot to the env environment after an env-scoped login', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://env-api.example.com/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://env-auth.example.com');
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));

    await svc.status(OAUTH_PROVIDER);
    expect(toolkit.getCachedAccessToken).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        key: resolveKimiCodeOAuthKey({
          oauthHost: 'https://env-auth.example.com',
          baseUrl: 'https://env-api.example.com/coding/v1',
        }),
      }),
    );
  });

  it('startLogin rejects when the device authorization fails before onDeviceCode', async () => {
    toolkit.login.mockRejectedValue(new Error('device authorization request failed'));
    const svc = createService();
    await expect(svc.startLogin(OAUTH_PROVIDER)).rejects.toThrow(
      'device authorization request failed',
    );
  });

  it('startLogin returns authenticated when login resolves without issuing a device code (already-authenticated fast path)', async () => {
    const fetchMock = stubManagedModelsFetch();
    toolkit.login.mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true });
    const svc = createService();

    const start = await svc.startLogin(OAUTH_PROVIDER);
    expect(start).toMatchObject({
      provider: OAUTH_PROVIDER,
      status: 'authenticated',
      flow_id: expect.any(String),
    });
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
  });

  it('startLogin returns authenticated when model refresh fails on the already-authenticated fast path', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network disabled in test'));
    vi.stubGlobal('fetch', fetchMock);
    toolkit.login.mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true });
    const svc = createService();

    await expect(svc.startLogin(OAUTH_PROVIDER)).resolves.toMatchObject({
      provider: OAUTH_PROVIDER,
      status: 'authenticated',
      flow_id: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
    expect(configReplace).not.toHaveBeenCalledWith('defaultModel', expect.any(String));
  });

  it('keeps a device-code login authenticated when model fetch is unavailable after authorization', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network disabled in test'));
    vi.stubGlobal('fetch', fetchMock);
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();

    await expect(svc.startLogin(OAUTH_PROVIDER)).resolves.toMatchObject({
      provider: OAUTH_PROVIDER,
      status: 'pending',
    });
    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(configReplace).not.toHaveBeenCalledWith('defaultModel', expect.any(String));
  });

  it('refreshes managed models and sets the default model after a device-code login succeeds', async () => {
    const fetchMock = stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();

    await svc.startLogin(OAUTH_PROVIDER);
    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
    expect(configReplace).toHaveBeenCalledWith(
      'models',
      expect.objectContaining({
        'kimi-code/kimi-k2': expect.objectContaining({ model: 'kimi-k2' }),
      }),
    );
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
  });

  it('keeps an in-flight OAuth flow alive when unrelated providers change', async () => {
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    providerChangedEmitter.fire({ added: ['other-provider'], removed: [], changed: [] });

    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');
  });

  it('aborts an in-flight OAuth flow when its provider is removed from config', async () => {
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    providerChangedEmitter.fire({ added: [], removed: [OAUTH_PROVIDER], changed: [] });

    const flow = svc.getFlow(OAUTH_PROVIDER);
    expect(flow?.status).toBe('cancelled');
    expect(flow?.error_message).toBe('Provider configuration changed during login.');
  });

  it('marks an in-flight OAuth flow cancelled (not vanished) when its provider config changes', async () => {
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    providerChangedEmitter.fire({ added: [], removed: [], changed: [OAUTH_PROVIDER] });

    const flow = svc.getFlow(OAUTH_PROVIDER);
    expect(flow?.status).toBe('cancelled');
    expect(flow?.error_message).toBe('Provider configuration changed during login.');
  });

  it('does not finalize a login whose provider changed after toolkit.login resolved', async () => {
    let resolveLogin!: (value: { providerName: string; ok: true }) => void;
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise((resolve) => {
        resolveLogin = resolve;
      });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    resolveLogin({ providerName: OAUTH_PROVIDER, ok: true });
    providerChangedEmitter.fire({ added: [], removed: [], changed: [OAUTH_PROVIDER] });

    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('cancelled'));
  });

  it('reports pending until provisioning finishes after the grant settles', async () => {
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    let resolveProvision!: () => void;
    providerSet.mockImplementation((name: string, config: ProviderConfig) => {
      providers = { ...providers, [name]: config };
      return new Promise<void>((resolve) => {
        resolveProvision = resolve;
      });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    await vi.waitFor(() => {
      expect(providerSet).toHaveBeenCalled();
    });
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    resolveProvision();
    await vi.waitFor(() => {
      expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated');
    });
  });

  it('keeps the login authenticated when its own provisioning fires a provider change', async () => {
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    providerSet.mockImplementation((name: string, config: ProviderConfig) => {
      providers = { ...providers, [name]: config };
      providerChangedEmitter.fire({ added: [], removed: [], changed: [name] });
      return Promise.resolve();
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));
  });

  it('cancelLogin aborts a pending flow and marks it cancelled', async () => {
    let capturedSignal: AbortSignal | undefined;
    toolkit.login.mockImplementation((_provider, options) => {
      capturedSignal = options.signal;
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    const result = await svc.cancelLogin(OAUTH_PROVIDER);
    expect(result).toEqual({ cancelled: true, status: 'cancelled' });
    expect(capturedSignal?.aborted).toBe(true);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('cancelled');
  });

  it('logout delegates to the toolkit and clears any pending flow', async () => {
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    const result = await svc.logout(OAUTH_PROVIDER);
    expect(result).toEqual({ logged_out: true, provider: OAUTH_PROVIDER });
    expect(toolkit.logout).toHaveBeenCalledWith(OAUTH_PROVIDER, EXAMPLE_COM_SCOPED_REF);
    expect(configReplace).toHaveBeenCalledWith('providers', {
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    });
  });

  it('logout removes managed provider models and dangling defaults', async () => {
    models = {
      'kimi-code/kimi-k2': {
        provider: OAUTH_PROVIDER,
        model: 'kimi-k2',
        maxContextSize: 131072,
      },
      'custom-default': {
        provider: NON_OAUTH_PROVIDER,
        model: 'gpt-4o',
        maxContextSize: 8192,
      },
    };
    defaultModel = 'kimi-code/kimi-k2';
    thinking = { enabled: true };
    const svc = createService();

    const result = await svc.logout(OAUTH_PROVIDER);

    expect(result).toEqual({ logged_out: true, provider: OAUTH_PROVIDER });
    expect(configReplace).toHaveBeenCalledWith('providers', {
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    });
    expect(configReplace).toHaveBeenCalledWith('models', {
      'custom-default': {
        provider: NON_OAUTH_PROVIDER,
        model: 'gpt-4o',
        maxContextSize: 8192,
      },
    });
    expect(configReplace).toHaveBeenCalledWith('defaultModel', undefined);
    expect(configReplace).toHaveBeenCalledWith('thinking', undefined);
  });

  it('logout removes managed web services while preserving unrelated services', async () => {
    services = ServicesConfigSchema.parse({
      moonshotSearch: {
        baseUrl: 'https://api.example.com/search',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      moonshotFetch: {
        baseUrl: 'https://api.example.com/fetch',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      customService: {
        baseUrl: 'https://service.example.com',
      },
    });
    const svc = createService();

    await expect(svc.logout(OAUTH_PROVIDER)).resolves.toEqual({
      logged_out: true,
      provider: OAUTH_PROVIDER,
    });

    expect(configReplace).toHaveBeenCalledWith('services', {
      customService: {
        baseUrl: 'https://service.example.com',
      },
    });
  });

  it('logout surfaces managed provider cleanup write failures', async () => {
    const failure = new Error('config write failed');
    configReplace.mockRejectedValueOnce(failure);
    const svc = createService();

    await expect(svc.logout(OAUTH_PROVIDER)).rejects.toThrow('config write failed');
    expect(toolkit.logout).toHaveBeenCalledWith(OAUTH_PROVIDER, EXAMPLE_COM_SCOPED_REF);
  });

  it('status reports loggedIn based on the cached access token', async () => {
    const svc = createService();
    expect(await svc.status(OAUTH_PROVIDER)).toEqual({ loggedIn: false });

    toolkit.getCachedAccessToken.mockResolvedValue('cached-token');
    expect(await svc.status(OAUTH_PROVIDER)).toEqual({
      loggedIn: true,
      provider: OAUTH_PROVIDER,
    });
  });

  it('resolveTokenProvider delegates to the toolkit', () => {
    const svc = createService();
    const provider = svc.resolveTokenProvider(NON_OAUTH_PROVIDER, { storage: 'file', key: 'k' });
    expect(provider).toEqual({ getAccessToken: expect.any(Function) });
    expect(toolkit.tokenProvider).toHaveBeenCalledWith(NON_OAUTH_PROVIDER, {
      storage: 'file',
      key: 'k',
    });
  });

  it('resolveTokenProvider re-derives the managed provider oauth ref from the current base url', () => {
    const svc = createService();
    svc.resolveTokenProvider(OAUTH_PROVIDER, { storage: 'file', key: 'stale-key' });
    const expectedRef = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: 'https://api.example.com',
      configuredOAuthRef: { storage: 'file', key: 'stale-key' },
    }).oauthRef;
    expect(toolkit.tokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, expectedRef);
  });

  it('getManagedUsage resolves the managed runtime auth and delegates to the toolkit', async () => {
    const quota = {
      kind: 'ok' as const,
      quota: { usages: {}, extraUsage: null },
    };
    toolkit.getManagedUsage.mockResolvedValue(quota);
    const svc = createService();

    await expect(svc.getManagedUsage(OAUTH_PROVIDER)).resolves.toBe(quota);
    expect(toolkit.getManagedUsage).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      oauthRef: EXAMPLE_COM_SCOPED_REF,
      baseUrl: 'https://api.example.com',
    });
  });

  it('getManagedUserInfo resolves the managed runtime auth and delegates to the toolkit', async () => {
    const userInfo = {
      kind: 'ok' as const,
      userInfo: {
        userId: 'u_1',
        nickname: 'moonwalker',
        status: 'USER_STATUS_NORMAL',
        region: 'REGION_CN',
        userLevel: 30,
        userLevelName: 'Vivace',
        domain: 1,
        domainName: 'DOMAIN_EXAMPLE',
      },
    };
    toolkit.getManagedUserInfo.mockResolvedValue(userInfo);
    const svc = createService();

    await expect(svc.getManagedUserInfo(OAUTH_PROVIDER)).resolves.toBe(userInfo);
    expect(toolkit.getManagedUserInfo).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      oauthRef: EXAMPLE_COM_SCOPED_REF,
      baseUrl: 'https://api.example.com',
    });
  });

  it('refreshOAuthProviderModels returns an empty result when no Kimi Code provider is configured', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    const svc = createService();

    await expect(svc.refreshOAuthProviderModels()).resolves.toEqual({
      changed: [],
      unchanged: [],
      failed: [],
    });
    expect(toolkit.tokenProvider).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('refreshOAuthProviderModels fetches models and writes back the changed sections', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'kimi-k2',
            context_length: 131072,
            supports_reasoning: true,
            display_name: 'Kimi K2',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = createService();

    const result = await svc.refreshOAuthProviderModels();

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      {
        provider_id: OAUTH_PROVIDER,
        provider_name: 'Kimi Code',
        added: 1,
        removed: 0,
      },
    ]);
    expect(configReplace).toHaveBeenCalledWith(
      'providers',
      expect.objectContaining({ [OAUTH_PROVIDER]: expect.objectContaining({ type: 'kimi' }) }),
    );
    expect(configReplace).toHaveBeenCalledWith(
      'models',
      expect.objectContaining({
        'kimi-code/kimi-k2': expect.objectContaining({ model: 'kimi-k2' }),
      }),
    );
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
    expect(configReplace).toHaveBeenCalledWith('thinking', { enabled: true });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'event.model_catalog.changed',
        payload: result,
      }),
    ]);
  });

  it('serializes concurrent refreshOAuthProviderModels runs so they never overlap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'kimi-k2',
              context_length: 131072,
              supports_reasoning: true,
              display_name: 'Kimi K2',
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = createService();

    await Promise.all([svc.refreshOAuthProviderModels(), svc.refreshOAuthProviderModels()]);

    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts the refresh write when the managed provider was edited mid-fetch', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = createService();

    const pending = svc.refreshOAuthProviderModels();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    providers = {
      ...providers,
      [OAUTH_PROVIDER]: { ...providers[OAUTH_PROVIDER]!, baseUrl: 'https://api.changed.example.com' },
    };
    resolveFetch({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'kimi-k2',
            context_length: 131072,
            supports_reasoning: true,
            display_name: 'Kimi K2',
          },
        ],
      }),
    });

    await expect(pending).resolves.toEqual({ changed: [], unchanged: [], failed: [] });
    expect(configReplace).not.toHaveBeenCalled();
    expect(providers[OAUTH_PROVIDER]?.baseUrl).toBe('https://api.changed.example.com');
  });

  it('rewrites a lost default model on refresh even when the catalog is unchanged', async () => {
    stubManagedModelsFetch();
    const svc = createService();

    const first = await svc.refreshOAuthProviderModels();
    expect(first.changed).toHaveLength(1);
    expect(defaultModel).toBe('kimi-code/kimi-k2');

    configReplace.mockClear();
    events.length = 0;
    defaultModel = undefined;

    const second = await svc.refreshOAuthProviderModels();

    expect(second.failed).toEqual([]);
    expect(second.unchanged).toEqual([]);
    expect(second.changed).toEqual([
      {
        provider_id: OAUTH_PROVIDER,
        provider_name: 'Kimi Code',
        added: 0,
        removed: 0,
      },
    ]);
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
    expect(defaultModel).toBe('kimi-code/kimi-k2');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'event.model_catalog.changed',
        payload: second,
      }),
    ]);
  });

  it('reports unchanged on refresh when the catalog and the default model are both intact', async () => {
    stubManagedModelsFetch();
    const svc = createService();

    await svc.refreshOAuthProviderModels();
    expect(defaultModel).toBe('kimi-code/kimi-k2');

    configReplace.mockClear();
    events.length = 0;

    const second = await svc.refreshOAuthProviderModels();

    expect(second).toEqual({ changed: [], unchanged: [OAUTH_PROVIDER], failed: [] });
    expect(configReplace).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('keeps the default model the user selects while a refresh is in flight', async () => {
    const { fetchMock, releaseFetch } = stubGatedManagedModelsFetch();
    models = {
      'kimi-code/kimi-k2': managedK2Alias,
      'kimi-code/kimi-k2.5': managedK25Alias,
    };
    defaultModel = 'kimi-code/kimi-k2';
    const svc = createService();

    const refresh = svc.refreshOAuthProviderModels();
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await configReplace('defaultModel', 'kimi-code/kimi-k2.5');
    releaseFetch();
    const result = await refresh;

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      {
        provider_id: OAUTH_PROVIDER,
        provider_name: 'Kimi Code',
        added: 1,
        removed: 0,
      },
    ]);
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2.5');
    expect(defaultModel).toBe('kimi-code/kimi-k2.5');
  });

  it('writes back the refreshed catalog and default when the user does not intervene mid-flight', async () => {
    const { fetchMock, releaseFetch } = stubGatedManagedModelsFetch();
    models = {
      'kimi-code/kimi-k2': managedK2Alias,
      'kimi-code/kimi-k2.5': managedK25Alias,
    };
    defaultModel = 'kimi-code/kimi-k2';
    const svc = createService();

    const refresh = svc.refreshOAuthProviderModels();
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    releaseFetch();
    const result = await refresh;

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      {
        provider_id: OAUTH_PROVIDER,
        provider_name: 'Kimi Code',
        added: 1,
        removed: 0,
      },
    ]);
    expect(configReplace).toHaveBeenCalledWith(
      'models',
      expect.objectContaining({
        'kimi-code/kimi-k3': expect.objectContaining({ model: 'kimi-k3' }),
      }),
    );
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
    expect(defaultModel).toBe('kimi-code/kimi-k2');
  });

  it('keeps the thinking selection the user makes while a refresh is in flight', async () => {
    const { fetchMock, releaseFetch } = stubGatedManagedModelsFetch();
    models = {
      'kimi-code/kimi-k2': managedK2Alias,
      'kimi-code/kimi-k2.5': managedK25Alias,
    };
    defaultModel = 'kimi-code/kimi-k2';
    thinking = { enabled: true };
    const svc = createService();

    const refresh = svc.refreshOAuthProviderModels();
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await configReplace('thinking', { enabled: false });
    releaseFetch();
    const result = await refresh;

    expect(result.failed).toEqual([]);
    expect(result.changed).toHaveLength(1);
    expect(configReplace).toHaveBeenCalledWith('thinking', { enabled: false });
    expect(thinking).toEqual({ enabled: false });
  });
});

describe('WebSearchProviderService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let servicesConfig: ServicesConfig | undefined;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    servicesConfig = undefined;
    resolveTokenProvider = vi
      .fn()
      .mockReturnValue({ getAccessToken: async () => 'access-token' });
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
        });
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider:
            resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        const hostHeaders = {
          'User-Agent': 'kimi-code-cli/test',
          'X-Msh-Device-Id': 'device-test',
        };
        reg.defineInstance(
          IAgentIdentity,
          stubAgentIdentity({ hostRequestHeaders: hostHeaders }),
        );
        reg.definePartialInstance(IBootstrapService, {
          args: { requestHeaders: hostHeaders },
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === SERVICES_SECTION ? servicesConfig : undefined) as IConfigService['get'],
        });
        reg.define(IWebSearchProviderService, WebSearchProviderService);
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  function createService(): IWebSearchProviderService {
    return ix.get(IWebSearchProviderService);
  }

  it('uses explicitly configured DeepSeek Search before existing services and does not fall back on failure', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'deepseek', apiKey: 'PROVIDER_KEY' } };
    servicesConfig = { deepseekSearch: { apiKey: 'SEARCH_KEY' }, moonshotSearch: { baseUrl: 'https://example.test/search', apiKey: 'OTHER_KEY' } };
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(createService().hasWebSearchProvider()).toBe(true);
    await expect(createService().getWebSearchProvider()!.search('query')).rejects.toMatchObject({ status: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.deepseek.com/v1/tools/search');
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('returns undefined when the managed provider is not configured', () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    expect(createService().getWebSearchProvider()).toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('returns undefined when the managed provider is not an OAuth kimi provider', () => {
    providers = { [OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    expect(createService().getWebSearchProvider()).toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('returns undefined when the oauth service yields no token provider', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    resolveTokenProvider.mockReturnValue(undefined);
    expect(createService().getWebSearchProvider()).toBeUndefined();
  });

  it('builds a search provider from the managed provider oauth ref', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    expect(createService().getWebSearchProvider()).not.toBeUndefined();
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('searches against /search with the OAuth access token, host identity headers, and custom headers', async () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1/',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
        customHeaders: { 'X-Custom': 'yes' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        search_results: [{ title: 'Title', url: 'https://example.com', snippet: 'Snippet' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    const results = await provider!.search('hello');

    expect(results).toEqual([
      { title: 'Title', url: 'https://example.com', snippet: 'Snippet' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/search');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-token');
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
    expect(headers['X-Msh-Device-Id']).toBe('device-test');
    expect(headers['X-Custom']).toBe('yes');
    expect(JSON.parse(init.body as string)).toEqual({ text_query: 'hello' });
  });

  it('builds a search provider from the services.moonshot_search api_key config', async () => {
    servicesConfig = {
      moonshotSearch: {
        baseUrl: 'https://search.example.com/search',
        apiKey: 'search-key',
        customHeaders: { 'X-Custom': 'yes' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        search_results: [{ title: 'Title', url: 'https://example.com', snippet: 'Snippet' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
    const results = await provider!.search('hello');

    expect(results).toEqual([
      { title: 'Title', url: 'https://example.com', snippet: 'Snippet' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://search.example.com/search');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer search-key');
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
    expect(headers['X-Msh-Device-Id']).toBe('device-test');
    expect(headers['X-Custom']).toBe('yes');
  });

  it('prefers the services.moonshot_search config over the managed oauth provider', async () => {
    servicesConfig = {
      moonshotSearch: { baseUrl: 'https://config.example.com/search', apiKey: 'config-key' },
    };
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://managed.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ search_results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    await provider!.search('hello');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://config.example.com/search');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer config-key');
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('builds a search provider from the services.moonshot_search oauth ref', async () => {
    servicesConfig = {
      moonshotSearch: {
        baseUrl: 'https://search.example.com/search',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ search_results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
    await provider!.search('hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer access-token');
  });

  it('returns undefined when services.moonshot_search has no baseUrl and no managed oauth', () => {
    servicesConfig = { moonshotSearch: { apiKey: 'search-key' } };
    expect(createService().getWebSearchProvider()).toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('answers presence without touching a not-yet-frozen identity', () => {
    const notFrozen: IAgentIdentity = {
      _serviceBrand: undefined,
      resolved: () => new Promise(() => undefined),
      current: () => {
        throw new Error('identity read before freeze');
      },
    };
    servicesConfig = {
      moonshotSearch: { baseUrl: 'https://search.example.com/search', apiKey: 'k' },
    };
    const svc = new WebSearchProviderService(
      { get: ((name: string) => providers[name]) as IProviderService['get'] } as IProviderService,
      {
        resolveTokenProvider:
          resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
      } as IOAuthService,
      { args: { requestHeaders: {} } } as unknown as IBootstrapService,
      {
        get: ((domain: string) =>
          domain === SERVICES_SECTION ? servicesConfig : undefined) as IConfigService['get'],
      } as IConfigService,
      notFrozen,
    );

    expect(svc.hasWebSearchProvider()).toBe(true);
    expect(() => svc.getWebSearchProvider()).toThrow(/before freeze/);

    servicesConfig = undefined;
    providers = {};
    expect(svc.hasWebSearchProvider()).toBe(false);

    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    expect(svc.hasWebSearchProvider()).toBe(true);
  });
});

describe('services config section', () => {
  it.each(['socks5://proxy.example.com:1080', 'https://user:password@proxy.example.com', 'http://proxy.example.com:0'])('rejects unsafe proxy preference %s at the server config boundary', value => {
    const registry = new ConfigRegistry();
    expect(() => registry.validate(PROXY_SECTION, { url: value })).toThrow();
  });

  it.each(['http://proxy.example.com:3128', 'https://proxy.example.com:8443', ''])('accepts the shared proxy preference %s', url => {
    expect(new ConfigRegistry().validate(PROXY_SECTION, { url })).toEqual({ url });
  });
  it('registers the services section and validates its schema', () => {
    const registry = new ConfigRegistry();

    expect(registry.getSection(SERVICES_SECTION)).toBeDefined();
    expect(
      registry.validate(SERVICES_SECTION, {
        moonshotSearch: { baseUrl: 'https://api.example.com/search', apiKey: 'search-key' },
        moonshotFetch: { baseUrl: 'https://api.example.com/fetch' },
        customService: { baseUrl: 'https://service.example.com', retries: 3 },
      }),
    ).toEqual({
      moonshotSearch: { baseUrl: 'https://api.example.com/search', apiKey: 'search-key' },
      moonshotFetch: { baseUrl: 'https://api.example.com/fetch' },
      customService: { baseUrl: 'https://service.example.com', retries: 3 },
    });
    expect(() =>
      registry.validate(SERVICES_SECTION, { moonshotSearch: { baseUrl: 42 } }),
    ).toThrow();
  });

  it('maps services from TOML snake_case to camelCase', () => {
    expect(
      servicesFromToml({
        moonshot_search: {
          base_url: 'https://api.example.com/search',
          api_key: 'search-key',
          custom_headers: { 'X-Search': '1' },
          oauth: { storage: 'file', key: 'oauth/kimi-code', oauth_host: 'https://auth.example.com' },
        },
        moonshot_fetch: { base_url: 'https://api.example.com/fetch', api_key: 'fetch-key' },
      }),
    ).toEqual({
      moonshotSearch: {
        baseUrl: 'https://api.example.com/search',
        apiKey: 'search-key',
        customHeaders: { 'X-Search': '1' },
        oauth: { storage: 'file', key: 'oauth/kimi-code', oauthHost: 'https://auth.example.com' },
      },
      moonshotFetch: { baseUrl: 'https://api.example.com/fetch', apiKey: 'fetch-key' },
    });
  });

  it('maps services back to TOML snake_case, preserving unknown entries', () => {
    expect(
      servicesToToml(
        {
          moonshotSearch: {
            baseUrl: 'https://api.example.com/search',
            apiKey: 'search-key',
            customHeaders: { 'X-Search': '1' },
            oauth: {
              storage: 'file',
              key: 'oauth/kimi-code',
              oauthHost: 'https://auth.example.com',
            },
          },
        },
        { custom_service: { base_url: 'https://service.example.com' } },
      ),
    ).toEqual({
      moonshot_search: {
        base_url: 'https://api.example.com/search',
        api_key: 'search-key',
        custom_headers: { 'X-Search': '1' },
        oauth: { storage: 'file', key: 'oauth/kimi-code', oauth_host: 'https://auth.example.com' },
      },
      custom_service: { base_url: 'https://service.example.com' },
    });
  });

  it('preserves unknown services when managed services are removed', () => {
    const rawServices = {
      moonshot_search: {
        base_url: 'https://api.example.com/search',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      moonshot_fetch: {
        base_url: 'https://api.example.com/fetch',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      custom_service: {
        base_url: 'https://service.example.com',
        retries: 3,
      },
    };
    const services = ServicesConfigSchema.parse(servicesFromToml(rawServices));
    const config = { providers: {}, services };

    clearManagedKimiCodeConfig(config);

    expect(servicesToToml(config.services, rawServices)).toEqual({
      custom_service: {
        base_url: 'https://service.example.com',
        retries: 3,
      },
    });
  });
});

describe('AuthSummaryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelRecord>;
  let defaultModel: string | undefined;
  let defaultProvider: string | undefined;
  let oauthStatus: ReturnType<typeof vi.fn>;
  let getCachedAccessToken: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    defaultProvider = undefined;
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    models = {
      kimi: {
        provider: OAUTH_PROVIDER,
        model: 'kimi-k2',
        protocol: 'openai',
        maxContextSize: 128000,
      },
      openai: {
        provider: NON_OAUTH_PROVIDER,
        model: 'gpt-4.1',
        protocol: 'openai',
        maxContextSize: 128000,
      },
    };
    defaultModel = 'kimi';
    oauthStatus = vi.fn();
    getCachedAccessToken = vi.fn().mockResolvedValue(undefined);
    reload = vi.fn().mockResolvedValue(undefined);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
          list: (() => providers) as IProviderService['list'],
          getDefaultProvider: (() => defaultProvider) as IProviderService['getDefaultProvider'],
        });
        reg.definePartialInstance(IModelService, {
          get: ((id: string) => models[id]) as IModelService['get'],
          list: (() => models) as IModelService['list'],
          getDefaultModel: (() => defaultModel) as IModelService['getDefaultModel'],
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => {
            if (domain === MODELS_SECTION) return models;
            if (domain === 'defaultModel') return defaultModel;
            return undefined;
          }) as IConfigService['get'],
          reload: reload as unknown as IConfigService['reload'],
          onDidChangeConfiguration: (() => ({ dispose: () => { } })) as IConfigService['onDidChangeConfiguration'],
          onDidSectionChange: (() => ({ dispose: () => { } })) as IConfigService['onDidSectionChange'],
        });
        reg.definePartialInstance(IOAuthService, {
          status: oauthStatus as unknown as IOAuthService['status'],
          getCachedAccessToken: getCachedAccessToken as unknown as IOAuthService['getCachedAccessToken'],
        });
        reg.definePartialInstance(ILogService, {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        });
        reg.definePartialInstance(ITelemetryService, { track2: vi.fn() });
        reg.define(IAuthSummaryService, AuthSummaryService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  function createSummary(): IAuthSummaryService {
    return ix.get(IAuthSummaryService);
  }

  it('summarize reports status only for providers configured with oauth', async () => {
    oauthStatus.mockResolvedValue({ loggedIn: true, provider: OAUTH_PROVIDER });
    const result = await createSummary().summarize();
    expect(result).toEqual([{ loggedIn: true, provider: OAUTH_PROVIDER }]);
    expect(oauthStatus).toHaveBeenCalledWith(OAUTH_PROVIDER);
    expect(oauthStatus).not.toHaveBeenCalledWith(NON_OAUTH_PROVIDER);
  });

  it('summarize skips providers whose status throws', async () => {
    const OTHER_OAUTH = 'kimi-code-anthropic';
    providers[OTHER_OAUTH] = {
      type: 'kimi',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    };
    oauthStatus.mockImplementation((name: string) => {
      if (name === OTHER_OAUTH) throw new Error('No OAuth manager configured');
      return { loggedIn: true, provider: name };
    });
    const result = await createSummary().summarize();
    expect(result).toEqual([{ loggedIn: true, provider: OAUTH_PROVIDER }]);
    expect(oauthStatus).toHaveBeenCalledWith(OAUTH_PROVIDER);
    expect(oauthStatus).toHaveBeenCalledWith(OTHER_OAUTH);
  });

  it('ensureReady throws provisioning_required when provider-backed config has no providers', async () => {
    providers = {};
    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.provisioning_required',
      details: undefined,
    });
    expect(oauthStatus).not.toHaveBeenCalled();
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady throws model_not_resolved when the default model alias is missing', async () => {
    defaultModel = 'missing';

    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.model_not_resolved',
      details: { model_id: 'missing' },
    });
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady throws model_not_resolved when the model provider is missing', async () => {
    delete providers[OAUTH_PROVIDER];

    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.model_not_resolved',
      details: { model_id: 'kimi', provider_id: OAUTH_PROVIDER },
    });
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady throws token_missing when an oauth provider has no cached token', async () => {
    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.token_missing',
      details: { provider_id: OAUTH_PROVIDER },
    });
    expect(getCachedAccessToken).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('ensureReady propagates cached token read failures', async () => {
    getCachedAccessToken.mockRejectedValue(new Error('token store unreadable'));

    await expect(createSummary().ensureReady()).rejects.toThrow('token store unreadable');
    expect(getCachedAccessToken).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('ensureReady emits auth_ensure_ready_failed with reason unexpected for non-auth-classified failures', async () => {
    getCachedAccessToken.mockRejectedValue(new Error('token store unreadable'));
    const track2 = ix.get(ITelemetryService).track2 as unknown as Mock;

    await expect(createSummary().ensureReady()).rejects.toThrow('token store unreadable');
    expect(track2).toHaveBeenCalledWith('auth_ensure_ready_failed', {
      reason: 'unexpected',
      has_model_override: false,
    });
  });

  it('ensureReady accepts provider api keys', async () => {
    await expect(createSummary().ensureReady('openai')).resolves.toBeUndefined();
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady resolves a providerless model through the configured defaultProvider', async () => {
    models = {
      flat: { model: 'gpt-4.1', protocol: 'openai', maxContextSize: 128000 },
    };
    defaultModel = 'flat';
    defaultProvider = NON_OAUTH_PROVIDER;

    await expect(createSummary().ensureReady()).resolves.toBeUndefined();
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady accepts cached oauth tokens', async () => {
    getCachedAccessToken.mockResolvedValue('access-token');
    await expect(createSummary().ensureReady('kimi')).resolves.toBeUndefined();
    expect(getCachedAccessToken).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });
});

describe('AuthLegacyService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelRecord>;
  let defaultModel: string | undefined;
  let oauthStatus: ReturnType<typeof vi.fn>;
  let configReady: Promise<void>;
  let configReload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    models = {};
    defaultModel = undefined;
    oauthStatus = vi.fn();
    configReady = Promise.resolve();
    configReload = vi.fn().mockResolvedValue(undefined);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, {
          ready: configReady,
          getAll: (() => ({
            providers,
            models,
            defaultModel,
          })) as IConfigService['getAll'],
          reload: configReload as unknown as IConfigService['reload'],
        });
        reg.definePartialInstance(IOAuthService, {
          status: oauthStatus as unknown as IOAuthService['status'],
        });
        reg.define(IAuthLegacyService, AuthLegacyService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  function createService(): IAuthLegacyService {
    return ix.get(IAuthLegacyService);
  }

  it('returns an empty snapshot when no providers are configured', async () => {
    await expect(createService().get()).resolves.toEqual({
      models_ready: false,
      providers_count: 0,
      managed_provider: null,
    });
    expect(oauthStatus).not.toHaveBeenCalled();
  });

  it('counts every configured provider, not only oauth ones', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    oauthStatus.mockResolvedValue({ loggedIn: false });
    const summary = await createService().get();
    expect(summary.providers_count).toBe(2);
  });

  it('reports models_ready when the default model resolves to a configured provider', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    models = { k2: { provider: NON_OAUTH_PROVIDER, model: 'kimi-k2', maxContextSize: 128000 } };
    defaultModel = 'k2';
    const summary = await createService().get();
    expect(summary.models_ready).toBe(true);
    expect(summary.managed_provider).toBeNull();
  });

  it('is not models_ready when a provider exists but no default model is set', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    models = { k2: { provider: NON_OAUTH_PROVIDER, model: 'kimi-k2' } };
    const summary = await createService().get();
    expect(summary.providers_count).toBe(1);
    expect(summary.models_ready).toBe(false);
    expect(summary.managed_provider).toBeNull();
  });

  it('is not models_ready when the default model dangles', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    models = { k2: { provider: NON_OAUTH_PROVIDER, model: 'kimi-k2' } };
    defaultModel = 'gone';
    const summary = await createService().get();
    expect(summary.models_ready).toBe(false);
  });

  it('is not models_ready when the default model points at a missing provider', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    models = { k2: { provider: 'ghost', model: 'kimi-k2' } };
    defaultModel = 'k2';
    const summary = await createService().get();
    expect(summary.models_ready).toBe(false);
  });

  it('reports models_ready for a providerless flat default model', async () => {
    models = {
      flat: {
        baseUrl: 'https://api.example.test/v1',
        model: 'gpt',
        protocol: 'openai',
        maxContextSize: 128000,
        apiKey: 'sk-x',
      },
    };
    defaultModel = 'flat';
    const summary = await createService().get();
    expect(summary.models_ready).toBe(true);
  });

  it('surfaces managed_provider.unauthenticated when configured without a cached token', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
    };
    oauthStatus.mockResolvedValue({ loggedIn: false });
    const summary = await createService().get();
    expect(summary.managed_provider).toEqual({
      name: OAUTH_PROVIDER,
      status: 'unauthenticated',
    });
    expect(summary.models_ready).toBe(false);
  });

  it('surfaces managed_provider.authenticated when a cached token exists', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
    };
    models = { k2: { provider: OAUTH_PROVIDER, model: 'kimi-k2', maxContextSize: 128000 } };
    defaultModel = 'k2';
    oauthStatus.mockResolvedValue({ loggedIn: true, provider: OAUTH_PROVIDER });
    const summary = await createService().get();
    expect(summary.managed_provider).toEqual({
      name: OAUTH_PROVIDER,
      status: 'authenticated',
    });
    expect(summary.models_ready).toBe(true);
  });

  it('treats a throwing oauth status as unauthenticated', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
    };
    oauthStatus.mockRejectedValue(new Error('token storage unavailable'));
    await expect(createService().get()).resolves.toMatchObject({
      managed_provider: { name: OAUTH_PROVIDER, status: 'unauthenticated' },
    });
  });

  it('waits for config readiness before reading the snapshot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const svc = new AuthLegacyService(
      {
        ready: gate,
        getAll: () => ({ providers, models, defaultModel }),
      } as unknown as IConfigService,
      { status: oauthStatus } as unknown as IOAuthService,
    );
    const pending = svc.get();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    models = { k2: { provider: NON_OAUTH_PROVIDER, model: 'kimi-k2', maxContextSize: 128000 } };
    defaultModel = 'k2';
    release();
    await expect(pending).resolves.toMatchObject({ models_ready: true });
  });

  it('re-reads the snapshot on every call without forcing a reload', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    const svc = createService();
    await expect(svc.get()).resolves.toMatchObject({ models_ready: false });
    models = { k2: { provider: NON_OAUTH_PROVIDER, model: 'kimi-k2', maxContextSize: 128000 } };
    defaultModel = 'k2';
    await expect(svc.get()).resolves.toMatchObject({ models_ready: true });
    expect(configReload).not.toHaveBeenCalled();
  });
});

describe('Local CLI credential discovery', () => {
  it('detects Devin metadata without returning or modifying its token', async () => {
    const { LocalCredentialRegistry } = await import('#/app/auth/localCredentials');
    const home = await mkdtemp(join(tmpdir(), 'devin-credential-test-'));
    try {
      const directory = join(home, '.local', 'share', 'devin');
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'credentials.toml');
      const token = `header.${Buffer.from(JSON.stringify({ session_id: 'example-session' })).toString('base64url')}.signature`;
      await writeFile(path, `windsurf_api_key = "${token}"`);
      const registry = new LocalCredentialRegistry({ home, env: {} });
      const before = await readFile(path, 'utf8');
      const metadata = await registry.detect();
      expect(metadata).toEqual([expect.objectContaining({ id: 'devin-cli', provider: 'devin', name: 'Devin CLI' })]);
      expect(JSON.stringify(metadata)).not.toContain(token);
      expect(await registry.resolve('devin-cli')).toEqual({ apiKey: token });
      expect(await readFile(path, 'utf8')).toBe(before);
      await rm(path);
      expect(await registry.detect()).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('coalesces Copilot exchange and caches only until expiry or source-account rotation', async () => {
    const { LocalCredentialRegistry } = await import('#/app/auth/localCredentials');
    const home = await mkdtemp(join(tmpdir(), 'copilot-credential-test-'));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    piMocks.provider = 'github-copilot';
    const refresh = vi.fn(async (credential: OAuthCredential) => ({ ...credential, access: `EXAMPLE_SESSION_${credential.refresh}`, expires: Date.now() + 3600_000 }));
    piMocks.oauth = { name: 'Example Copilot', login: vi.fn(), refresh, toAuth: async credential => ({ apiKey: credential.access }) };
    try {
      const directory = join(home, '.config', 'github-copilot');
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'apps.json');
      const writeSource = async (token: string) => writeFile(path, JSON.stringify({ 'github.com': { oauth_token: token } }));
      await writeSource('EXAMPLE_FIRST');
      const registry = new LocalCredentialRegistry({ home, env: {} });
      const results = await Promise.all(Array.from({ length: 4 }, () => registry.resolve('github-copilot-cli')));
      expect(results.every(result => result?.apiKey === 'EXAMPLE_SESSION_EXAMPLE_FIRST')).toBe(true);
      expect(refresh).toHaveBeenCalledOnce();
      await registry.resolve('github-copilot-cli');
      expect(refresh).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 3600_000);
      await registry.resolve('github-copilot-cli');
      expect(refresh).toHaveBeenCalledTimes(2);
      await writeSource('EXAMPLE_SECOND');
      expect(await registry.resolve('github-copilot-cli')).toMatchObject({ apiKey: 'EXAMPLE_SESSION_EXAMPLE_SECOND' });
      expect(refresh).toHaveBeenCalledTimes(3);
      refresh.mockRejectedValueOnce(new Error('Revoked token'));
      expect(await registry.resolve('github-copilot-cli', 'github-copilot', { fresh: true })).toBeUndefined();
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(await readFile(path, 'utf8')).not.toContain('EXAMPLE_SESSION');
    } finally { clock.mockRestore(); piMocks.oauth = undefined; piMocks.provider = 'anthropic'; await rm(home, { recursive: true, force: true }); }
  });

  it('detects only parseable credentials, exposes metadata and rereads by reference', async () => {
    const { LocalCredentialRegistry } = await import('#/app/auth/localCredentials');
    const home = await mkdtemp(join(tmpdir(), 'local-credential-test-'));
    try {
      const registry = new LocalCredentialRegistry({ home, env: {} });
      expect(await registry.detect()).toEqual([]);
      await mkdir(join(home, '.kimi', 'credentials'), { recursive: true });
      const path = join(home, '.kimi', 'credentials', 'kimi-code.json');
      await writeFile(path, '{bad json');
      expect(await registry.detect()).toEqual([]);
      await writeFile(path, JSON.stringify({ access_token: 'EXAMPLE_ACCESS_TOKEN', expires_at: Date.now() / 1000 + 3600 }));
      const entries = await registry.detect();
      expect(entries).toEqual([expect.objectContaining({ id: 'kimi-cli', provider: 'kimi-coding', name: 'Kimi CLI' })]);
      expect(JSON.stringify(entries)).not.toContain('EXAMPLE_ACCESS_TOKEN');
      const before = await readFile(path, 'utf8');
      expect(await registry.resolve('kimi-cli')).toEqual({ apiKey: 'EXAMPLE_ACCESS_TOKEN', baseUrl: 'https://api.kimi.com/coding' });
      expect(await readFile(path, 'utf8')).toBe(before);
      await writeFile(path, JSON.stringify({ access_token: 'EXAMPLE_NEW_TOKEN', expires_at: Date.now() / 1000 + 3600 }));
      expect(await registry.resolve('kimi-cli')).toEqual({ apiKey: 'EXAMPLE_NEW_TOKEN', baseUrl: 'https://api.kimi.com/coding' });
      await rm(path);
      expect(await registry.resolve('kimi-cli')).toBeUndefined();
      expect(await registry.detect()).toEqual([]);
      expect(await registry.resolve('unknown')).toBeUndefined();
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('supports a pluggable detector without exposing extra fields', async () => {
    const { LocalCredentialRegistry, registerLocalCredentialDetector } = await import('#/app/auth/localCredentials');
    const unregister = registerLocalCredentialDetector({
      id: 'example-cli', provider: 'example', name: 'Example CLI',
      detect: async () => ({ account: 'developer@example.test', unexpected: 'EXAMPLE_SECRET' }),
      resolve: async () => ({ apiKey: 'EXAMPLE_SECRET' }),
    });
    try {
      const registry = new LocalCredentialRegistry({ home: '/nonexistent', env: {} });
      expect(await registry.detect()).toEqual([{ id: 'example-cli', provider: 'example', name: 'Example CLI', account: 'developer@example.test', expiresAt: undefined }]);
      expect(await registry.resolve('example-cli')).toEqual({ apiKey: 'EXAMPLE_SECRET' });
    } finally { unregister(); }
    expect(await new LocalCredentialRegistry({ home: '/nonexistent', env: {} }).detect()).toEqual([]);
  });
});

describe('DeepSeek services config', () => {
  it('round trips optional service configuration independently from existing services', () => {
    const raw = { deepseek_search: { api_key_env: 'EXAMPLE_DEEPSEEK_KEY', count: 5, timeout_ms: 1000, custom_headers: { 'X-Route': 'example' } }, deepseek_fetch: { api_key: 'YOUR_API_KEY', base_url: 'https://relay.example.test/fetch' } };
    const config = ServicesConfigSchema.parse(servicesFromToml(raw));
    expect(config.deepseekSearch?.apiKeyEnv).toBe('EXAMPLE_DEEPSEEK_KEY');
    expect(servicesToToml(config, {})).toEqual(raw);
    expect(() => ServicesConfigSchema.parse({ deepseekSearch: { count: 51 } })).toThrow();
    expect(() => ServicesConfigSchema.parse({ deepseekFetch: { timeoutMs: 0 } })).toThrow();
  });
});
