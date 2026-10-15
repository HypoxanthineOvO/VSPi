import { createHmac, randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  declaredProviderCredential,
  nonEmptyString,
} from '@moonshot-ai/kimi-code-oauth/provider-credential';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { isPlainObject } from '#/app/config/configPure';
import { cloneRecord } from '#/app/config/toml';
import {
  DEFAULT_MODEL_SECTION,
  ENV_MODEL_PROVIDER_KEY,
  PROVIDERS_SECTION,
  ProviderConfigSchema,
} from '#/app/kosongConfig/configSection';
import { EXTRA_SKILL_DIRS_SECTION } from '#/features/skill/catalog/configSection';
import {
  explainProviderEndpoint,
  getProviderDefinitions,
} from '#/llm-adapter/provider/provider-definition';
import type { ProviderConfig, ProvidersSection } from '#/llm-adapter/provider/provider';
import { Error2, ErrorCodes } from '#/errors';

const PROVIDER_ID_MAX_LENGTH = 128;
const PROVIDER_TYPE_MAX_LENGTH = 128;
const CREDENTIAL_VALUE_MAX_LENGTH = 16 * 1024;
const BASE_URL_MAX_LENGTH = 2048;
const DEFAULT_MODEL_MAX_LENGTH = 1024;
const MASK_ONLY_PATTERN = /^[*•●·∗＊]+$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REVISION_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_PROVIDER_IDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  ENV_MODEL_PROVIDER_KEY,
]);

export const desktopSettingsRevisionSchema = z.string().regex(REVISION_PATTERN);

export const desktopProviderIdSchema = z
  .string()
  .min(1)
  .max(PROVIDER_ID_MAX_LENGTH)
  .refine((id) => !FORBIDDEN_PROVIDER_IDS.has(id));

const environmentNameSchema = z.string().regex(ENV_NAME_PATTERN);

const credentialValueSchema = z
  .string()
  .max(CREDENTIAL_VALUE_MAX_LENGTH)
  .refine(
    (value) => value.trim().length > 0 && !MASK_ONLY_PATTERN.test(value.trim()),
  );

const baseUrlInputSchema = z
  .string()
  .max(BASE_URL_MAX_LENGTH)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return (
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  });

export const credentialEditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('replace'), value: credentialValueSchema }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({ action: z.literal('environment'), name: environmentNameSchema })
    .strict(),
]);

export type CredentialEdit = z.infer<typeof credentialEditSchema>;

export const providerSettingsPatchSchema = z
  .object({
    type: z.string().min(1).max(PROVIDER_TYPE_MAX_LENGTH).optional(),
    baseUrl: z.union([baseUrlInputSchema, z.null()]).optional(),
    defaultModel: z.union([z.string().min(1).max(DEFAULT_MODEL_MAX_LENGTH), z.null()]).optional(),
    modelSource: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  })
  .strict();

export const providerSettingsEditSchema = z
  .object({
    revision: desktopSettingsRevisionSchema,
    id: desktopProviderIdSchema,
    patch: providerSettingsPatchSchema,
    credential: credentialEditSchema,
  })
  .strict();

export type ProviderSettingsEdit = z.infer<typeof providerSettingsEditSchema>;

export const providerRemoveSchema = z
  .object({
    revision: desktopSettingsRevisionSchema,
    id: desktopProviderIdSchema,
  })
  .strict();

export const desktopProviderSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  baseUrl: z.string().optional(),
  baseUrlRedacted: z.boolean(),
  defaultModel: z.string().optional(),
  modelSource: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  credential: z.object({
    kind: z.enum(['none', 'api-key', 'environment', 'oauth', 'conflict']),
    configured: z.boolean(),
    environment: z.string().optional(),
    resolved: z.boolean().optional(),
  }),
  customHeaderNames: z.array(z.string()),
  environmentNames: z.array(z.string()),
});

export type DesktopProvider = z.infer<typeof desktopProviderSchema>;

export const desktopSettingsDiagnosticSchema = z.object({
  domain: z.string().optional(),
  severity: z.enum(['warning', 'error']),
  message: z.string(),
});

export const desktopSettingsSnapshotSchema = z.object({
  revision: z.string(),
  homeDir: z.string(),
  scope: z.literal('runtime'),
  providers: z.array(desktopProviderSchema),
  defaultModel: z.string().optional(),
  defaultPermissionMode: z.enum(['auto', 'manual', 'yolo']).optional(),
  extraSkillDirs: z.array(z.string()),
  diagnostics: z.array(desktopSettingsDiagnosticSchema),
});

export type DesktopSettingsSnapshot = z.infer<typeof desktopSettingsSnapshotSchema>;

export const desktopSettingsSaveSchema = z.object({
  settings: desktopSettingsSnapshotSchema,
  effective: z.literal('next-request'),
});

export type DesktopSettingsSave = z.infer<typeof desktopSettingsSaveSchema>;

export class DesktopSettingsConflictError extends Error {
  constructor(message = 'Configuration changed; reload settings before saving') {
    super(message);
    this.name = 'DesktopSettingsConflictError';
  }
}

export interface IDesktopSettingsService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<{ revision: string }>;
  read(): Promise<DesktopSettingsSnapshot>;
  saveProvider(input: ProviderSettingsEdit): Promise<DesktopSettingsSave>;
  removeProvider(input: { revision: string; id: string }): Promise<DesktopSettingsSave>;
}

export const IDesktopSettingsService: ServiceIdentifier<IDesktopSettingsService> =
  createDecorator<IDesktopSettingsService>('desktopSettingsService');

export class DesktopSettingsService extends Disposable implements IDesktopSettingsService {
  declare readonly _serviceBrand: undefined;

  private readonly revisionKey = randomBytes(32);
  private readonly onDidChangeEmitter = this._register(new Emitter<{ revision: string }>());
  readonly onDidChange: Event<{ revision: string }> = this.onDidChangeEmitter.event;
  private lastRevision: string | undefined;
  private saveChain: Promise<unknown> = Promise.resolve();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      this.config.onDidChangeConfiguration(() => {
        const revision = this.revision();
        if (revision === this.lastRevision) return;
        this.lastRevision = revision;
        this.onDidChangeEmitter.fire({ revision });
      }),
    );
  }

  async read(): Promise<DesktopSettingsSnapshot> {
    try {
      await this.config.ready;
      return this.snapshot();
    } catch (error) {
      throw this.sanitizeError(error, 'Could not read settings');
    }
  }

  saveProvider(input: ProviderSettingsEdit): Promise<DesktopSettingsSave> {
    const parsed = providerSettingsEditSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(
        new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid provider settings'),
      );
    }
    return this.enqueue(async () => {
      try {
        return await this.applySaveProvider(parsed.data);
      } catch (error) {
        throw this.sanitizeError(error, 'Could not save provider settings');
      }
    });
  }

  removeProvider(input: { revision: string; id: string }): Promise<DesktopSettingsSave> {
    const parsed = providerRemoveSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(
        new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid provider settings'),
      );
    }
    return this.enqueue(async () => {
      try {
        return await this.applyRemoveProvider(parsed.data);
      } catch (error) {
        throw this.sanitizeError(error, 'Could not save provider settings');
      }
    });
  }

  private sanitizeError(error: unknown, message: string): Error {
    if (error instanceof DesktopSettingsConflictError) return error;
    if (error instanceof Error2 && error.code === ErrorCodes.REQUEST_INVALID) return error;
    this.log.warn('desktop settings operation failed');
    return new Error2(ErrorCodes.CONFIG_INVALID, message);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.saveChain.then(operation);
    this.saveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private revision(): string {
    const userProviders = this.config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue;
    return createHmac('sha256', this.revisionKey)
      .update(stableSerialize(this.config.getAll()))
      .update(stableSerialize(userProviders ?? null))
      .digest('hex');
  }

  private snapshot(): DesktopSettingsSnapshot {
    const revision = this.revision();
    this.lastRevision = revision;
    const providers = this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {};
    const defaultModel = this.config.get<unknown>(DEFAULT_MODEL_SECTION);
    const permissionMode = this.config.get<unknown>(DEFAULT_PERMISSION_MODE_SECTION);
    const skillDirs = this.config.get<unknown>(EXTRA_SKILL_DIRS_SECTION);
    return {
      revision,
      homeDir: this.bootstrap.homeDir,
      scope: 'runtime',
      providers: Object.entries(providers).map(([id, provider]) =>
        this.toDesktopProvider(id, provider),
      ),
      defaultModel: typeof defaultModel === 'string' ? defaultModel : undefined,
      defaultPermissionMode:
        permissionMode === 'auto' || permissionMode === 'manual' || permissionMode === 'yolo'
          ? permissionMode
          : undefined,
      extraSkillDirs: Array.isArray(skillDirs)
        ? skillDirs.filter((dir): dir is string => typeof dir === 'string')
        : [],
      diagnostics: this.config.diagnostics().map((diagnostic) => ({
        domain: diagnostic.domain,
        severity: diagnostic.severity,
        message:
          diagnostic.severity === 'error'
            ? 'Invalid runtime configuration'
            : 'Runtime configuration warning',
      })),
    };
  }

  private toDesktopProvider(id: string, provider: ProviderConfig): DesktopProvider {
    const { baseUrl, redacted } = redactBaseUrl(provider.baseUrl);
    return {
      id,
      type: provider.type,
      baseUrl,
      baseUrlRedacted: redacted,
      defaultModel: provider.defaultModel,
      modelSource:
        provider.modelSource ??
        (provider.type === undefined ? undefined : declaredModelSource(provider.type)),
      credential: describeCredential(id, provider),
      customHeaderNames: Object.keys(provider.customHeaders ?? {}),
      environmentNames: Object.keys(provider.env ?? {}),
    };
  }

  private async applySaveProvider(edit: ProviderSettingsEdit): Promise<DesktopSettingsSave> {
    await this.config.ready;
    await this.config.reload();
    if (edit.revision !== this.revision()) {
      throw new DesktopSettingsConflictError();
    }
    const expected = this.config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue;
    const next: Record<string, unknown> = cloneRecord(expected ?? {});
    const existing = next[edit.id];
    const record: Record<string, unknown> = isPlainObject(existing) ? existing : {};
    const previousType =
      typeof record['type'] === 'string'
        ? record['type']
        : this.config.get<ProvidersSection>(PROVIDERS_SECTION)?.[edit.id]?.type;

    const patch = edit.patch;
    if (patch.type !== undefined) record['type'] = patch.type;
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl === null) delete record['baseUrl'];
      else record['baseUrl'] = patch.baseUrl;
    }
    if (patch.defaultModel !== undefined) {
      if (patch.defaultModel === null) delete record['defaultModel'];
      else record['defaultModel'] = patch.defaultModel;
    }
    if (patch.modelSource !== undefined) record['modelSource'] = patch.modelSource;

    if (edit.credential.action !== 'keep') {
      const envKeys = declaredApiKeyEnvNames(previousType);
      const nextType = patch.type ?? previousType;
      if (nextType !== previousType) {
        for (const name of declaredApiKeyEnvNames(nextType)) envKeys.add(name);
      }
      delete record['apiKey'];
      delete record['apiKeyEnv'];
      delete record['oauth'];
      if (isPlainObject(record['env'])) {
        const env = record['env'];
        for (const name of envKeys) delete env[name];
      }
      if (edit.credential.action === 'replace') {
        record['apiKey'] = edit.credential.value.trim();
      } else if (edit.credential.action === 'environment') {
        record['apiKeyEnv'] = edit.credential.name;
      }
    }

    const validated = ProviderConfigSchema.safeParse(record);
    if (!validated.success) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid provider settings');
    }
    next[edit.id] = record;
    await this.persistProviders(next, expected);
    return { settings: await this.read(), effective: 'next-request' };
  }

  private async applyRemoveProvider(input: {
    revision: string;
    id: string;
  }): Promise<DesktopSettingsSave> {
    await this.config.ready;
    await this.config.reload();
    if (input.revision !== this.revision()) {
      throw new DesktopSettingsConflictError();
    }
    const expected = this.config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue;
    const next: Record<string, unknown> = cloneRecord(expected ?? {});
    delete next[input.id];
    await this.persistProviders(next, expected);
    return { settings: await this.read(), effective: 'next-request' };
  }

  private async persistProviders(
    next: Record<string, unknown>,
    expected: ProvidersSection | undefined,
  ): Promise<void> {
    try {
      await this.config.replaceSections({ [PROVIDERS_SECTION]: next }, undefined, {
        expectedValues: { [PROVIDERS_SECTION]: expected ?? null },
      });
    } catch (error) {
      if (error instanceof Error2 && error.code === ErrorCodes.CONFIG_INVALID) {
        throw new DesktopSettingsConflictError();
      }
      throw error;
    }
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).toSorted();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function declaredModelSource(typeId: string): DesktopProvider['modelSource'] {
  for (const definition of getProviderDefinitions(typeId)) {
    if (definition.modelSource !== undefined) return definition.modelSource;
  }
  return undefined;
}

function declaredApiKeyEnvNames(typeId: string | undefined): Set<string> {
  const names = new Set<string>();
  if (typeId === undefined) return names;
  for (const definition of getProviderDefinitions(typeId)) {
    const endpoints = [definition.endpoint, ...(definition.endpoints ?? [])];
    for (const endpoint of endpoints) {
      if (endpoint?.apiKeyEnv !== undefined) names.add(endpoint.apiKeyEnv);
    }
  }
  return names;
}

function describeCredential(
  id: string,
  provider: ProviderConfig,
): DesktopProvider['credential'] {
  const declared = declaredProviderCredential(provider, id);
  if (declared.kind === 'conflict') {
    return { kind: 'conflict', configured: true };
  }
  if (declared.kind === 'inline') {
    return { kind: 'api-key', configured: true };
  }
  if (declared.kind === 'env') {
    return {
      kind: 'environment',
      configured: true,
      environment: declared.apiKeyEnv,
      resolved: nonEmptyString(process.env[declared.apiKeyEnv]) !== undefined,
    };
  }
  if (provider.oauth !== undefined) {
    return { kind: 'oauth', configured: true };
  }
  if (provider.type !== undefined) {
    const explained = explainProviderEndpoint(provider.type, provider.env ?? {});
    if (explained.apiKey !== undefined) {
      return {
        kind: 'environment',
        configured: true,
        environment: explained.apiKeyEnvName,
        resolved: true,
      };
    }
  }
  return { kind: 'none', configured: false };
}

function redactBaseUrl(raw: string | undefined): { baseUrl?: string; redacted: boolean } {
  if (raw === undefined) return { redacted: false };
  try {
    const url = new URL(raw);
    if (
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    ) {
      return { baseUrl: raw, redacted: false };
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { baseUrl: url.toString(), redacted: true };
  } catch {
    return { redacted: true };
  }
}

registerScopedService(
  LifecycleScope.App,
  IDesktopSettingsService,
  DesktopSettingsService,
  ScopeActivation.OnDemand,
  'desktopSettings',
);
