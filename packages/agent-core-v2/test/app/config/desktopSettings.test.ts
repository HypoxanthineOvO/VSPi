import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ConfigTarget, IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import {
  DesktopSettingsConflictError,
  DesktopSettingsService,
  IDesktopSettingsService,
  type DesktopProvider,
} from '#/app/config/desktopSettings';
import { Error2, ErrorCodes } from '#/errors';
import { registerProviderDefinition } from '#/llm-adapter/provider/provider-definition';
import type { ProvidersSection } from '#/llm-adapter/provider/provider';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

registerProviderDefinition({
  id: 'desktop-demo',
  baseProtocol: 'openai',
  endpoint: {
    apiKeyEnv: 'DESKTOP_DEMO_API_KEY',
    baseUrlEnv: 'DESKTOP_DEMO_BASE_URL',
    defaultBaseUrl: 'https://api.example.test',
  },
});

interface Harness {
  readonly ix: TestInstantiationService;
  readonly disposables: DisposableStore;
  readonly storage: IFileSystemStorageService;
}

function makeHarness(options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  storage?: IFileSystemStorageService;
} = {}): Harness {
  const disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  const storage = options.storage ?? new InMemoryStorageService();
  ix.stub(ILogService, stubLog());
  ix.stub(
    IBootstrapService,
    stubBootstrap(options.homeDir ?? '/tmp/kimi-desktop-settings', options.env ?? {}),
  );
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  ix.set(IDesktopSettingsService, new SyncDescriptor(DesktopSettingsService));
  return { ix, disposables, storage };
}

async function seedProvider(
  config: IConfigService,
  id: string,
  record: Record<string, unknown>,
): Promise<void> {
  await config.set('providers', { [id]: record }, ConfigTarget.User);
}

function providerOf(
  snapshot: { providers: readonly DesktopProvider[] },
  id: string,
): DesktopProvider {
  const provider = snapshot.providers.find((p) => p.id === id);
  if (provider === undefined) throw new Error(`provider ${id} present`);
  return provider;
}

describe('DesktopSettingsService', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });
  afterEach(() => harness.disposables.dispose());

  it('reads a redacted snapshot without exposing secrets', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', {
      type: 'openai',
      apiKey: 'sk-secret-value-123',
      apiKeyEnv: 'OTHER_ENV',
      oauth: { storage: 'file', key: 'oauth-secret-key' },
      baseUrl: 'https://user:pass@example.test/v1?token=abc#frag',
      customHeaders: { 'x-secret': 'header-value' },
      env: { INNER_SECRET: 'env-value' },
      defaultModel: 'demo/m1',
    });
    const settings = harness.ix.get(IDesktopSettingsService);
    const snapshot = await settings.read();

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('sk-secret-value-123');
    expect(serialized).not.toContain('oauth-secret-key');
    expect(serialized).not.toContain('header-value');
    expect(serialized).not.toContain('env-value');
    expect(serialized).not.toContain('pass@');

    const provider = providerOf(snapshot, 'demo');
    expect(provider.credential.kind).toBe('conflict');
    expect(provider.credential.configured).toBe(true);
    expect(provider.baseUrlRedacted).toBe(true);
    expect(provider.baseUrl).not.toContain('pass');
    expect(provider.baseUrl).not.toContain('token=abc');
    expect(provider.customHeaderNames).toEqual(['x-secret']);
    expect(provider.environmentNames).toEqual(['INNER_SECRET']);
    expect(provider.type).toBe('openai');
    expect(provider.defaultModel).toBe('demo/m1');
    expect(snapshot.scope).toBe('runtime');
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.homeDir).toBe('/tmp/kimi-desktop-settings');
  });

  it('keeps an untouched credential while other fields change', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', {
      type: 'openai',
      apiKey: 'sk-keep-me',
      customHeaders: { 'x-a': 'b' },
    });
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    const saved = await settings.saveProvider({
      revision,
      id: 'demo',
      patch: { defaultModel: 'demo/m2' },
      credential: { action: 'keep' },
    });
    expect(saved.effective).toBe('next-request');
    expect(providerOf(saved.settings, 'demo').credential.kind).toBe('api-key');
    expect(providerOf(saved.settings, 'demo').defaultModel).toBe('demo/m2');

    const stored = config.inspect<ProvidersSection>('providers').userValue;
    expect(stored?.['demo']).toMatchObject({
      type: 'openai',
      apiKey: 'sk-keep-me',
      defaultModel: 'demo/m2',
      customHeaders: { 'x-a': 'b' },
    });
  });

  it('rejects mask-only and empty credential replacements', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', { type: 'openai', apiKey: 'sk-real' });
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    for (const value of ['********', '••••', '   ', '••****']) {
      await expect(
        settings.saveProvider({
          revision,
          id: 'demo',
          patch: {},
          credential: { action: 'replace', value },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    }
    expect(config.inspect<ProvidersSection>('providers').userValue?.['demo']).toMatchObject({
      apiKey: 'sk-real',
    });
  });

  it('clears credential refs and declared env apiKey keys while preserving unrelated env', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', {
      type: 'desktop-demo',
      apiKey: 'sk-x',
      apiKeyEnv: 'EXPLICIT_ENV',
      oauth: { storage: 'file', key: 'oauth-ref' },
      env: { DESKTOP_DEMO_API_KEY: 'env-secret', UNRELATED: 'keep' },
      customHeaders: { 'x-h': 'v' },
    });
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    const saved = await settings.saveProvider({
      revision,
      id: 'demo',
      patch: {},
      credential: { action: 'clear' },
    });
    expect(providerOf(saved.settings, 'demo').credential.kind).toBe('none');
    expect(providerOf(saved.settings, 'demo').environmentNames).toEqual(['UNRELATED']);

    const stored = config.inspect<ProvidersSection>('providers').userValue?.['demo'];
    expect(stored).toMatchObject({
      type: 'desktop-demo',
      env: { UNRELATED: 'keep' },
      customHeaders: { 'x-h': 'v' },
    });
    expect(stored?.apiKey).toBeUndefined();
    expect(stored?.apiKeyEnv).toBeUndefined();
    expect(stored?.oauth).toBeUndefined();
    expect(stored?.env?.['DESKTOP_DEMO_API_KEY']).toBeUndefined();
  });

  it('binds an environment credential and reports resolution without the value', async () => {
    const envName = 'DESKTOP_SETTINGS_TEST_ENV';
    process.env[envName] = 'secret-from-env';
    try {
      const config = harness.ix.get(IConfigService);
      await config.ready;
      await seedProvider(config, 'demo', { type: 'openai' });
      const settings = harness.ix.get(IDesktopSettingsService);
      const { revision } = await settings.read();

      const saved = await settings.saveProvider({
        revision,
        id: 'demo',
        patch: {},
        credential: { action: 'environment', name: envName },
      });
      const provider = providerOf(saved.settings, 'demo');
      expect(provider.credential.kind).toBe('environment');
      expect(provider.credential.environment).toBe(envName);
      expect(provider.credential.resolved).toBe(true);
      expect(JSON.stringify(saved.settings)).not.toContain('secret-from-env');

      const stored = config.inspect<ProvidersSection>('providers').userValue?.['demo'];
      expect(stored?.apiKeyEnv).toBe(envName);
      expect(stored?.apiKey).toBeUndefined();
    } finally {
      delete process.env[envName];
    }
  });

  it('reports env-bag credentials from the provider definition', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', {
      type: 'desktop-demo',
      env: { DESKTOP_DEMO_API_KEY: 'from-env-bag' },
    });
    const settings = harness.ix.get(IDesktopSettingsService);
    const snapshot = await settings.read();
    const provider = providerOf(snapshot, 'demo');
    expect(provider.credential.kind).toBe('environment');
    expect(provider.credential.environment).toBe('DESKTOP_DEMO_API_KEY');
    expect(provider.credential.resolved).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('from-env-bag');
  });

  it('rejects a stale revision after an external write without overwriting', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', { type: 'openai', apiKey: 'sk-a' });
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    await config.set('providers', { demo: { type: 'openai', apiKey: 'sk-b' } }, ConfigTarget.User);

    await expect(
      settings.saveProvider({
        revision,
        id: 'demo',
        patch: { defaultModel: 'late' },
        credential: { action: 'keep' },
      }),
    ).rejects.toBeInstanceOf(DesktopSettingsConflictError);
    expect(config.inspect<ProvidersSection>('providers').userValue?.['demo']).toMatchObject({
      apiKey: 'sk-b',
    });
  });

  it('serializes concurrent saves on the same revision so exactly one wins', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', { type: 'openai' });
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    const results = await Promise.allSettled([
      settings.saveProvider({
        revision,
        id: 'demo',
        patch: { defaultModel: 'first' },
        credential: { action: 'keep' },
      }),
      settings.saveProvider({
        revision,
        id: 'demo',
        patch: { defaultModel: 'second' },
        credential: { action: 'keep' },
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DesktopSettingsConflictError,
    );
  });

  it('rejects invalid baseUrl inputs and preserves the stored value', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', { type: 'openai', baseUrl: 'https://ok.example.test' });
    const settings = harness.ix.get(IDesktopSettingsService);

    for (const baseUrl of [
      'file:///etc/passwd',
      'ftp://example.test',
      'http://user:pw@example.test/',
      'https://example.test/v1?x=1',
      'https://example.test/v1#frag',
      'not a url',
    ]) {
      const { revision } = await settings.read();
      await expect(
        settings.saveProvider({
          revision,
          id: 'demo',
          patch: { baseUrl },
          credential: { action: 'keep' },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      expect(config.inspect<ProvidersSection>('providers').userValue?.['demo']).toMatchObject({
        baseUrl: 'https://ok.example.test',
      });
    }

    const { revision } = await settings.read();
    await settings.saveProvider({
      revision,
      id: 'demo',
      patch: { baseUrl: null },
      credential: { action: 'keep' },
    });
    expect(
      config.inspect<ProvidersSection>('providers').userValue?.['demo']?.baseUrl,
    ).toBeUndefined();
  });

  it('rejects forbidden provider ids', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();
    for (const id of ['__proto__', 'prototype', 'constructor', '__kimi_env__', 'x'.repeat(129)]) {
      await expect(
        settings.saveProvider({
          revision,
          id,
          patch: { type: 'openai' },
          credential: { action: 'keep' },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    }
  });

  it('creates a provider storing only the allowlisted patch and credential', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    const saved = await settings.saveProvider({
      revision,
      id: 'new-provider',
      patch: { type: 'openai', baseUrl: 'https://api.example.test/v1', defaultModel: 'm1' },
      credential: { action: 'replace', value: 'sk-new' },
    });
    expect(providerOf(saved.settings, 'new-provider').credential.kind).toBe('api-key');
    expect(config.inspect<ProvidersSection>('providers').userValue?.['new-provider']).toEqual({
      type: 'openai',
      baseUrl: 'https://api.example.test/v1',
      defaultModel: 'm1',
      apiKey: 'sk-new',
    });
  });

  it('removes a provider record', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', { type: 'openai', apiKey: 'sk-gone' });
    await seedProvider(config, 'other', { type: 'openai' });
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    const saved = await settings.removeProvider({ revision, id: 'demo' });
    expect(saved.settings.providers.find((p) => p.id === 'demo')).toBeUndefined();
    expect(providerOf(saved.settings, 'other').id).toBe('other');
    expect(config.inspect<ProvidersSection>('providers').userValue?.['demo']).toBeUndefined();
  });

  it('fires settings.changed with only the revision', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    const settings = harness.ix.get(IDesktopSettingsService);
    const events: Array<{ revision: string }> = [];
    harness.disposables.add(
      settings.onDidChange((event) => {
        events.push(event);
      }),
    );
    const { revision } = await settings.read();
    await settings.saveProvider({
      revision,
      id: 'demo',
      patch: { type: 'openai' },
      credential: { action: 'keep' },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.revision).not.toBe(revision);
    expect(JSON.stringify(events)).not.toContain('apiKey');
  });

  it('maps diagnostics to safe fixed messages', async () => {
    const storage = harness.storage as InMemoryStorageService;
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[providers]\n  broken = 5\n[defaultModel]\n  bad = [1,2\n'),
    );
    const config = harness.ix.get(IConfigService);
    await config.ready;
    const settings = harness.ix.get(IDesktopSettingsService);
    const snapshot = await settings.read();
    for (const diagnostic of snapshot.diagnostics) {
      expect(['Invalid runtime configuration', 'Runtime configuration warning']).toContain(
        diagnostic.message,
      );
    }
    expect(JSON.stringify(snapshot.diagnostics)).not.toContain('broken = 5');
  });

  it('sanitizes persistence and reload failures without leaking cause payloads', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', { type: 'openai', apiKey: 'sk-x' });
    const log = harness.ix.get(ILogService);
    const warn = vi.spyOn(log, 'warn');
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    const replaceSpy = vi
      .spyOn(config, 'replaceSections')
      .mockRejectedValueOnce(new Error('YOUR_API_KEY'));
    const persistErr = await settings
      .saveProvider({
        revision,
        id: 'demo',
        patch: {},
        credential: { action: 'keep' },
      })
      .catch((error: unknown) => error);
    replaceSpy.mockRestore();
    expect(persistErr).toBeInstanceOf(Error2);
    expect((persistErr as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((persistErr as Error2).message).toBe('Could not save provider settings');
    expect(JSON.stringify(persistErr)).not.toContain('YOUR_API_KEY');
    for (const args of warn.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('YOUR_API_KEY');
    }
    const warnCount = warn.mock.calls.length;
    expect(warnCount).toBeGreaterThan(0);

    warn.mockClear();
    const reloadSpy = vi
      .spyOn(config, 'reload')
      .mockRejectedValueOnce(new Error('YOUR_API_KEY'));
    const { revision: fresh } = await settings.read();
    const reloadErr = await settings
      .saveProvider({
        revision: fresh,
        id: 'demo',
        patch: {},
        credential: { action: 'keep' },
      })
      .catch((error: unknown) => error);
    reloadSpy.mockRestore();
    expect(reloadErr).toBeInstanceOf(Error2);
    expect((reloadErr as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((reloadErr as Error2).message).toBe('Could not save provider settings');
    expect(JSON.stringify(reloadErr)).not.toContain('YOUR_API_KEY');
    for (const args of warn.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('YOUR_API_KEY');
    }
  });

  it('clears an env-bag credential when the type comes from a non-user source', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', {
      env: { DESKTOP_DEMO_API_KEY: 'env-secret', UNRELATED: 'keep' },
    });
    await config.set(
      'providers',
      { demo: { type: 'desktop-demo' } },
      ConfigTarget.Memory,
    );
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();

    const saved = await settings.saveProvider({
      revision,
      id: 'demo',
      patch: {},
      credential: { action: 'clear' },
    });

    const stored = config.inspect<ProvidersSection>('providers').userValue?.['demo'];
    expect(stored).toMatchObject({ env: { UNRELATED: 'keep' } });
    expect(stored?.type).toBeUndefined();
    expect(stored?.env?.['DESKTOP_DEMO_API_KEY']).toBeUndefined();
    expect(JSON.stringify(saved.settings)).not.toContain('env-secret');
  });
});

describe('DesktopSettingsService (real fs)', () => {
  let homeDir: string;
  let harness: Harness;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-desktop-settings-'));
    harness = makeHarness({
      homeDir,
      storage: new FileStorageService(homeDir, 0o700, 0o600),
    });
  });

  afterEach(async () => {
    harness.disposables.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('writes config.toml with 0600 permissions and preserves unknown fields', async () => {
    const config = harness.ix.get(IConfigService);
    await config.ready;
    await seedProvider(config, 'demo', {
      type: 'openai',
      apiKey: 'sk-fs',
    });
    const configPath = join(homeDir, 'config.toml');
    const seeded = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      seeded.replace('api_key = "sk-fs"', 'api_key = "sk-fs"\nunknown_field = "keep-me"'),
      'utf8',
    );
    await config.reload();
    const settings = harness.ix.get(IDesktopSettingsService);
    const { revision } = await settings.read();
    await settings.saveProvider({
      revision,
      id: 'demo',
      patch: { defaultModel: 'demo/m9' },
      credential: { action: 'keep' },
    });

    const fileStat = await stat(join(homeDir, 'config.toml'));
    expect(fileStat.mode & 0o777).toBe(0o600);
    const toml = await readFile(join(homeDir, 'config.toml'), 'utf8');
    expect(toml).toContain('unknown_field');
    expect(toml).toContain('keep-me');
    expect(toml).toContain('default_model');
  });
});
