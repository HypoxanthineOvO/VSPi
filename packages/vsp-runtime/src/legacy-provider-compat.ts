import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  preserveThinkingEffort,
  repairThinkingEffort,
  type ThinkingEffortRepairAction,
} from './thinking-effort-repair.js';

interface LegacyProvider {
  readonly baseUrl?: unknown;
  readonly api?: unknown;
  readonly protocol?: unknown;
  readonly headers?: unknown;
  readonly apiKey?: unknown;
  readonly models?: unknown;
}

interface LegacyModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly api?: unknown;
  readonly baseUrl?: unknown;
  readonly contextWindow?: unknown;
  readonly maxTokens?: unknown;
  readonly input?: unknown;
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
}

interface LegacyCredential {
  readonly type?: unknown;
  readonly key?: unknown;
}

interface LegacyRuntimeDefaults {
  readonly model?: unknown;
  readonly effort?: unknown;
}

type Protocol = 'anthropic' | 'openai' | 'openai_responses' | 'google-genai';

export interface LegacyProviderMigrationOptions {
  readonly osHomeDir?: string;
  readonly agentDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LegacyProviderMigrationResult {
  readonly config: Record<string, unknown>;
  readonly sourceFingerprint: string;
  readonly providers: number;
  readonly models: number;
  readonly defaultModel: boolean;
  readonly thinking: boolean;
  readonly repairedDefaultModel: boolean;
  readonly effortRepair?: ThinkingEffortRepairAction;
  readonly diagnostics: readonly string[];
}

export async function migrateLegacyVspiProviders(
  target: Readonly<Record<string, unknown>>,
  options: LegacyProviderMigrationOptions = {},
): Promise<LegacyProviderMigrationResult> {
  const osHomeDir = options.osHomeDir ?? homedir();
  const agentDir = options.agentDir ?? join(osHomeDir, '.pi', 'agent');
  const diagnostics: string[] = [];
  const sources = await Promise.all([
    readJson(join(agentDir, 'models.json'), diagnostics),
    readJson(join(agentDir, 'models-store.json'), diagnostics),
    readJson(join(agentDir, 'auth.json'), diagnostics),
    readJson(join(osHomeDir, '.config', 'vspi', 'runtime-defaults.json'), diagnostics),
  ]);
  const [modelsFile, modelStore, credentials, defaults] = sources.map((source) => source.value);
  const sourceFingerprint = createHash('sha256')
    .update(sources.map((source) => source.fingerprint).join(':'))
    .digest('hex');
  const config = cloneRecord(target);
  const providers = cloneRecord(config['providers']);
  const models = cloneRecord(config['models']);
  const legacyProviders = collectLegacyProviders(modelsFile, modelStore);
  const legacyCredentials = credentialMap(credentials);
  let providerCount = 0;
  let modelCount = 0;

  for (const [providerId, legacy] of legacyProviders) {
    if (hiddenLegacyProvider(providerId)) continue;
    const existingProvider = record(providers[providerId]);
    const legacyProvider = toProviderConfig(legacy, legacyCredentials.get(providerId), options.env, diagnostics, providerId);
    const provider = existingProvider === undefined
      ? legacyProvider
      : mergeProviderConfig(existingProvider, legacyProvider);
    if (provider === undefined) continue;
    if (existingProvider === undefined || provider !== existingProvider) {
      providers[providerId] = provider;
      providerCount += 1;
    }
    for (const legacyModel of legacy.models) {
      const modelId = stringValue(legacyModel.id);
      if (modelId === undefined) {
        diagnostics.push(`provider ${providerId}: skipped model without id`);
        continue;
      }
      const alias = `${providerId}/${modelId}`;
      const existingModel = record(models[alias]);
      if (existingModel !== undefined && Object.keys(existingModel).length > 0) continue;
      const model = toModelConfig(providerId, legacyModel, legacy, diagnostics, alias);
      if (model === undefined) continue;
      models[alias] = model;
      modelCount += 1;
    }
  }

  if (Object.keys(providers).length > 0) config['providers'] = providers;
  else delete config['providers'];
  if (Object.keys(models).length > 0) config['models'] = models;
  else delete config['models'];

  const existingDefault = stringValue(config['default_model']);
  const existingDefaultValid = existingDefault !== undefined && models[existingDefault] !== undefined;
  const legacyDefaults = record(defaults) as LegacyRuntimeDefaults | undefined;
  const legacyDefault = legacyDefaultAlias(legacyDefaults, models);
  let repairedDefaultModel = false;
  let defaultModel = false;
  if (!existingDefaultValid) {
    if (existingDefault !== undefined) repairedDefaultModel = true;
    if (legacyDefault !== undefined) {
      config['default_model'] = legacyDefault;
      defaultModel = existingDefault !== legacyDefault;
    } else {
      delete config['default_model'];
    }
  }

  let thinking = false;
  let effortRepair: ThinkingEffortRepairAction | undefined;
  const legacyEffort = stringValue(legacyDefaults?.effort);
  if (legacyEffort !== undefined) {
    const effort = normalizeEffort(legacyEffort);
    const configuredThinking = record(config['thinking']);
    if (configuredThinking !== undefined) {
      effortRepair = preserveThinkingEffort(stringValue(configuredThinking['effort']) ?? effort);
    } else {
      const repaired = repairThinkingEffort(effort, config['default_model'], models, providers);
      config['thinking'] = { effort: repaired.effort };
      effortRepair = repaired.action;
      thinking = true;
      if (repaired.diagnostic !== undefined) diagnostics.push(repaired.diagnostic);
    }
  }

  return {
    config,
    sourceFingerprint,
    providers: providerCount,
    models: modelCount,
    defaultModel,
    thinking,
    repairedDefaultModel,
    effortRepair,
    diagnostics,
  };
}

function collectLegacyProviders(modelsFile: unknown, modelStore: unknown): Map<string, LegacyProvider & { models: LegacyModel[] }> {
  const result = new Map<string, LegacyProvider & { models: LegacyModel[] }>();
  const stored = record(modelStore);
  const metadataById = new Map<string, LegacyModel>();
  for (const [providerId, entry] of Object.entries(stored ?? {})) {
    const value = record(entry);
    const models = modelArray(value?.['models']);
    if (models.length === 0) continue;
    for (const model of models) {
      const id = stringValue(model.id);
      if (id !== undefined && metadataById.get(id) === undefined) metadataById.set(id, model);
    }
    result.set(providerId, providerFromModels(models));
  }
  const configured = record(record(modelsFile)?.['providers']);
  for (const [providerId, entry] of Object.entries(configured ?? {})) {
    const value = record(entry) as LegacyProvider | undefined;
    if (value === undefined) continue;
    const inherited = result.get(providerId);
    const configuredModels = modelArray(value.models);
    result.set(providerId, {
      ...inherited,
      ...value,
      models: configuredModels.length > 0
        ? configuredModels.map((model) => hydrateLegacyModel(model, metadataById.get(stringValue(model.id) ?? '')))
        : inherited?.models ?? [],
    });
  }
  return result;
}

function hiddenLegacyProvider(providerId: string): boolean {
  return /^custom-gemini-via-[a-z0-9-]+-[a-f0-9]{8}$/u.test(
    providerId.toLowerCase(),
  );
}

function hydrateLegacyModel(model: LegacyModel, metadata: LegacyModel | undefined): LegacyModel {
  if (metadata === undefined) return model;
  return { ...metadata, ...model, api: model.api, baseUrl: model.baseUrl };
}

function providerFromModels(models: LegacyModel[]): LegacyProvider & { models: LegacyModel[] } {
  const first = models[0];
  return { baseUrl: first?.baseUrl, api: first?.api, models };
}

function credentialMap(value: unknown): Map<string, LegacyCredential> {
  return new Map(Object.entries(record(value) ?? {}).flatMap(([id, credential]) => {
    const parsed = record(credential) as LegacyCredential | undefined;
    return parsed === undefined ? [] : [[id, parsed] as const];
  }));
}

function toProviderConfig(
  provider: LegacyProvider,
  credential: LegacyCredential | undefined,
  env: NodeJS.ProcessEnv | undefined,
  diagnostics: string[],
  providerId: string,
): Record<string, unknown> | undefined {
  const firstModel = modelArray(provider.models)[0];
  const protocol = protocolFor(provider.protocol ?? provider.api ?? firstModel?.api);
  if (protocol === undefined) {
    diagnostics.push(`provider ${providerId}: skipped unknown protocol`);
    return undefined;
  }
  const apiKey = credential?.type === 'api_key'
    ? stringValue(credential.key)
    : resolveLegacyApiKey(provider.apiKey, env);
  return compact({
    type: protocol,
    base_url: stringValue(provider.baseUrl) ?? stringValue(firstModel?.baseUrl),
    custom_headers: stringRecord(provider.headers),
    api_key: apiKey,
  });
}

function mergeProviderConfig(
  existing: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (legacy === undefined) return existing;
  const merged = { ...existing };
  let changed = false;
  if (protocolFor(existing['type']) === undefined && protocolFor(legacy['type']) !== undefined) {
    merged['type'] = legacy['type'];
    changed = true;
  }
  if (nonBlankString(existing['base_url']) === undefined && nonBlankString(legacy['base_url']) !== undefined) {
    merged['base_url'] = legacy['base_url'];
    changed = true;
  }
  return changed ? merged : existing;
}

function toModelConfig(
  providerId: string,
  model: LegacyModel,
  provider: LegacyProvider,
  diagnostics: string[],
  alias: string,
): Record<string, unknown> | undefined {
  const modelId = stringValue(model.id) as string;
  const protocol = protocolFor(model.api ?? provider.protocol ?? provider.api);
  if (protocol === undefined) {
    diagnostics.push(`model ${alias}: skipped unknown protocol`);
    return undefined;
  }
  const input = Array.isArray(model.input) ? model.input : [];
  const capabilities = [
    ...(input.includes('image') ? ['image_in'] : []),
    ...(model.reasoning === true ? ['thinking'] : []),
  ];
  return compact({
    provider: providerId,
    model: modelId,
    protocol,
    base_url: stringValue(model.baseUrl),
    display_name: stringValue(model.name) ?? modelId,
    max_context_size: positiveInteger(model.contextWindow) ?? 128_000,
    max_output_size: positiveInteger(model.maxTokens),
    capabilities: capabilities.length === 0 ? undefined : capabilities,
    support_efforts: effortValues(model.thinkingLevelMap, model.reasoning === true),
  });
}

function protocolFor(value: unknown): Protocol | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replaceAll(' ', '-') : '';
  switch (normalized) {
    case 'openai-completions':
    case 'openai': return 'openai';
    case 'openai-responses':
    case 'openai-response':
    case 'openai_responses':
    case 'responses': return 'openai_responses';
    case 'anthropic-messages':
    case 'anthropic': return 'anthropic';
    case 'google-generative-ai':
    case 'google-genai':
    case 'google':
    case 'gemini':
    case 'google-gemini': return 'google-genai';
    default: return undefined;
  }
}

function legacyDefaultAlias(defaults: LegacyRuntimeDefaults | undefined, models: Record<string, unknown>): string | undefined {
  const model = record(defaults?.model);
  const provider = stringValue(model?.['provider']);
  const id = stringValue(model?.['id']);
  if (provider === undefined || id === undefined) return undefined;
  const alias = `${provider}/${id}`;
  return models[alias] === undefined ? undefined : alias;
}

function effortValues(value: unknown, reasoning: boolean): string[] | undefined {
  const mapping = record(value);
  const values = mapping === undefined
    ? []
    : Object.entries(mapping).filter(([, mapped]) => mapped !== null).map(([effort]) => normalizeEffort(effort));
  const unique = [...new Set(values)];
  if (reasoning && unique.length === 0) return undefined;
  return unique.length === 0 ? undefined : unique;
}

function normalizeEffort(value: string): string {
  if (value === '高') return 'high';
  if (value === '中') return 'medium';
  if (value === '低') return 'low';
  return value;
}

function resolveLegacyApiKey(value: unknown, env: NodeJS.ProcessEnv | undefined): string | undefined {
  const apiKey = stringValue(value);
  if (apiKey === undefined || apiKey.startsWith('!')) return undefined;
  const reference = apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u)?.[1];
  return reference === undefined ? apiKey : stringValue(env?.[reference]);
}

async function readJson(path: string, diagnostics: string[]): Promise<{ value: unknown; fingerprint: string }> {
  try {
    const text = await readFile(path, 'utf8');
    const fingerprint = createHash('sha256').update(text).digest('hex');
    try {
      return { value: JSON.parse(text) as unknown, fingerprint };
    } catch (error) {
      diagnostics.push(`${path}: invalid JSON (${error instanceof Error ? error.name : 'Error'})`);
      return { value: undefined, fingerprint };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(`${path}: unreadable`);
    return { value: undefined, fingerprint: 'missing' };
  }
}

function modelArray(value: unknown): LegacyModel[] {
  return Array.isArray(value) ? value.filter((entry): entry is LegacyModel => record(entry) !== undefined) : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  const input = record(value);
  return input === undefined ? {} : structuredClone(input);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const entries = Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
