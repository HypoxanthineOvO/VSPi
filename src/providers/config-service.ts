import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertProjectEntrySafe,
  inspectProjectPath,
  prepareProjectPath,
  verifyProjectParent,
} from "../config/project-path-guard.js";
import type { EffortLevel } from "../domain/types.js";

export type ProviderSource = "builtin" | "global" | "project";

export interface ProviderModelRecord {
  id: string;
  name: string;
  contextWindow?: number;
  input?: string[];
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<EffortLevel, string | null>>;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  maxTokens?: number;
  headers?: Record<string, string>;
}

export interface ProviderRecord {
  id: string;
  name: string;
  source: ProviderSource;
  baseUrl?: string;
  api?: string;
  protocol?: string;
  headers?: Record<string, string>;
  models: ProviderModelRecord[];
}

export interface ProviderCatalog {
  providers: ProviderRecord[];
  hash: string;
  diagnostics: string[];
}

export interface ProviderConfigServiceOptions {
  cwd: string;
  agentDir: string;
  trustedProject: boolean;
  builtins: ProviderRecord[];
}

interface LayerRead {
  value: unknown;
  rawState: unknown;
  damaged: boolean;
  diagnostic?: string;
}

export interface ProviderOverlay {
  providers: Record<string, ProviderLayer>;
}

export interface ProviderLayer {
  name?: string;
  baseUrl?: string;
  api?: string;
  protocol?: string;
  headers?: Record<string, string>;
  models?: ProviderModelRecord[];
}

export interface GlobalProviderInput {
  name: string;
  baseUrl: string;
  protocol: SupportedProviderApi;
  models: ProviderModelRecord[];
}

export type SupportedProviderApi =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative-ai";

const PROVIDER_FIELDS = new Set(["name", "label", "baseUrl", "api", "protocol", "headers", "models"]);
const MODEL_FIELDS = new Set([
  "id",
  "name",
  "contextWindow",
  "input",
  "inputUsdPerMillion",
  "outputUsdPerMillion",
  "api",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "cost",
  "maxTokens",
  "headers",
]);
const SENSITIVE_FIELD = /(?:api[-_]?key|token|secret|password|credential)/i;
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i;

export function createProviderConfigService(options: ProviderConfigServiceOptions) {
  const globalPath = join(resolve(options.agentDir), "models.json");
  const projectPath = join(resolve(options.cwd), ".vspi", "models.json");

  async function readLayer(path: string, source: ProviderSource): Promise<LayerRead> {
    try {
      if (source === "project") await inspectProjectPath(options.cwd, "models.json");
      const raw = await readFile(path, "utf8");
      try {
        const value: unknown = JSON.parse(raw);
        return { value, rawState: value, damaged: false };
      } catch (error) {
        return {
          value: undefined,
          rawState: { damaged: true, rawHash: sha256(raw) },
          damaged: true,
          diagnostic: `${source} models.json JSON 损坏：${error instanceof Error ? error.message : "解析失败"}`,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { value: undefined, rawState: null, damaged: false };
      }
      if (source === "project") {
        return {
          value: undefined,
          rawState: { rejected: true, reason: "project-scope" },
          damaged: true,
          diagnostic: `project models.json scope 边界拒绝：${errorMessage(error)}`,
        };
      }
      throw error;
    }
  }

  async function loadCatalog(): Promise<ProviderCatalog> {
    const diagnostics: string[] = [];
    const global = await readLayer(globalPath, "global");
    const project = options.trustedProject
      ? await readLayer(projectPath, "project")
      : { value: undefined, rawState: { ignored: true }, damaged: false };
    if (global.diagnostic) diagnostics.push(global.diagnostic);
    if (project.diagnostic) diagnostics.push(project.diagnostic);

    const merged = new Map<string, ProviderRecord>();
    for (const provider of options.builtins) mergeProvider(merged, provider.id, provider, "builtin");
    if (!global.damaged && global.value !== undefined) {
      try {
        const overlay = parseOverlay(global.value, false);
        for (const [id, provider] of Object.entries(overlay.providers)) mergeProvider(merged, id, provider, "global");
      } catch (error) {
        diagnostics.push(`global models.json schema 无效：${errorMessage(error)}`);
      }
    }
    if (options.trustedProject && !project.damaged && project.value !== undefined) {
      try {
        const overlay = parseOverlay(project.value, true);
        for (const [id, provider] of Object.entries(overlay.providers)) mergeProvider(merged, id, provider, "project");
      } catch (error) {
        diagnostics.push(`project models.json schema 无效：${errorMessage(error)}`);
      }
    }

    const providers = [...merged.values()];
    const hash = hashCanonical({
      builtins: options.builtins,
      global: global.rawState,
      project: project.rawState,
      trustedProject: options.trustedProject,
    });
    return { providers, hash, diagnostics };
  }

  function validateProjectOverlay(value: unknown): void {
    if (!options.trustedProject) throw new Error("不受信任的项目不允许保存 Provider overlay");
    parseOverlay(value, true);
  }

  async function saveProjectOverlay(
    value: unknown,
    saveOptions: { expectedHash: string },
  ): Promise<{ hash: string; path: string }> {
    return withProjectLock(() => saveProjectOverlayUnlocked(value, saveOptions));
  }

  async function saveProjectOverlayUnlocked(
    value: unknown,
    saveOptions: { expectedHash: string },
  ): Promise<{ hash: string; path: string }> {
    validateProjectOverlay(value);
    const existingProject = await readLayer(projectPath, "project");
    if (existingProject.damaged) throw new Error("project models.json 已损坏；拒绝覆盖，请先人工修复 JSON");
    const current = await loadCatalog();
    if (current.hash !== saveOptions.expectedHash) {
      throw new Error(`Provider config conflict: expected hash ${saveOptions.expectedHash}, current ${current.hash}`);
    }

    const temporary = `${projectPath}.${process.pid}-${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(sortValue(value), null, 2)}\n`;
    const scope = await inspectProjectPath(options.cwd, "models.json");
    await assertProjectEntrySafe(temporary, "Provider temporary file");
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    try {
      await verifyProjectParent(scope);
      await assertProjectEntrySafe(projectPath, "Provider project target");
      await assertProjectEntrySafe(temporary, "Provider temporary file");
      await rename(temporary, projectPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new Error(`Provider config atomic rename failed: ${errorMessage(error)}`, { cause: error });
    }
    return { hash: (await loadCatalog()).hash, path: projectPath };
  }

  async function saveProjectProvider(
    id: string,
    value: { name: string; baseUrl: string; protocol: string },
    saveOptions: { expectedHash: string },
  ): Promise<{ hash: string; path: string }> {
    return withProjectLock(async () => {
      const existing = await readLayer(projectPath, "project");
      if (existing.damaged) throw new Error("project models.json 已损坏；拒绝覆盖，请先人工修复 JSON");
      const overlay = existing.value === undefined ? { providers: {} } : parseOverlay(existing.value, true);
      const { api: _staleApi, ...currentProvider } = overlay.providers[id] ?? {};
      const canonicalModels = currentProvider.models?.map(({ api: _staleModelApi, ...model }) => model);
      return saveProjectOverlayUnlocked(
        {
          providers: {
            ...overlay.providers,
            [id]: {
              ...currentProvider,
              name: value.name,
              baseUrl: value.baseUrl,
              protocol: value.protocol,
              ...(canonicalModels ? { models: canonicalModels } : {}),
            },
          },
        },
        saveOptions,
      );
    });
  }

  async function saveGlobalProvider(id: string, value: GlobalProviderInput): Promise<{ hash: string; path: string }> {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new Error("Provider ID 只能包含小写字母、数字、点、横线和下划线");
    const name = requiredString(value.name, `${id}.name`).trim();
    const baseUrl = validateBaseUrl(value.baseUrl, `${id}.baseUrl`);
    const api = normalizeProviderApi(value.protocol, `${id}.protocol`);
    const models = parseModels(value.models, false, id);
    if (models.length === 0) throw new Error("自定义 Provider 至少需要一个模型");

    return withGlobalLock(async () => {
      const existing = await readLayer(globalPath, "global");
      if (existing.damaged) throw new Error("global models.json 已损坏；拒绝覆盖，请先人工修复 JSON");
      const root = existing.value === undefined ? {} : existing.value;
      if (!isRecord(root)) throw new Error("global models.json 根节点必须是 object");
      const existingProviders = root.providers;
      if (existingProviders !== undefined && !isRecord(existingProviders)) {
        throw new Error("global models.json 的 providers 必须是 object");
      }
      const next = {
        ...root,
        providers: {
          ...(existingProviders ?? {}),
          [id]: {
            ...(isRecord(existingProviders?.[id]) ? existingProviders[id] : {}),
            name,
            baseUrl,
            api,
            models: models.map((model) => serializeGlobalModel(model, api)),
          },
        },
      };
      await atomicWriteGlobal(next);
      return { hash: (await loadCatalog()).hash, path: globalPath };
    });
  }

  async function atomicWriteGlobal(value: unknown): Promise<void> {
    await mkdir(dirname(globalPath), { recursive: true, mode: 0o700 });
    const temporary = `${globalPath}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(sortValue(value), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    try {
      await rename(temporary, globalPath);
      await chmod(globalPath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new Error(`Provider config atomic rename failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  async function withGlobalLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(globalPath), { recursive: true, mode: 0o700 });
    const lockPath = `${globalPath}.lock`;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Provider config conflict: global writer lock exists");
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async function withProjectLock<T>(operation: () => Promise<T>): Promise<T> {
    const scope = await prepareProjectPath(options.cwd, "models.json");
    await chmod(scope.projectDir, 0o700);
    const lockPath = `${projectPath}.lock`;
    await assertProjectEntrySafe(lockPath, "Provider writer lock");
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Provider config conflict: writer lock exists");
      throw error;
    }
    try {
      await verifyProjectParent(scope);
      await assertProjectEntrySafe(projectPath, "Provider project target");
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async function loadProjectOverlay(): Promise<ProviderOverlay | undefined> {
    if (!options.trustedProject) return undefined;
    const project = await readLayer(projectPath, "project");
    if (project.damaged) throw new Error("project models.json 已损坏；拒绝加载 Provider overlay");
    return project.value === undefined ? undefined : parseOverlay(project.value, true);
  }

  return {
    loadCatalog,
    loadProjectOverlay,
    saveGlobalProvider,
    saveProjectOverlay,
    saveProjectProvider,
    validateProjectOverlay,
  };
}

function parseOverlay(value: unknown, project: boolean): ProviderOverlay {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("models.json 必须包含 providers object");
  const rootKeys = Object.keys(value);
  if (project && rootKeys.some((key) => key !== "providers")) throw new Error("project schema 不允许未知根字段");
  const providers: Record<string, ProviderLayer> = {};
  for (const [id, input] of Object.entries(value.providers)) {
    if (!id || !isRecord(input)) throw new Error(`Provider ${id || "<empty>"} schema 无效`);
    if (project) assertNoProjectSecrets(input, `providers.${id}`);
    if (project && Object.keys(input).some((key) => !PROVIDER_FIELDS.has(key))) {
      throw new Error(`Provider ${id} 包含不允许的字段`);
    }
    const provider: ProviderLayer = {};
    const name = input.name ?? input.label;
    if (name !== undefined) provider.name = requiredString(name, `${id}.name`);
    if (input.baseUrl !== undefined) provider.baseUrl = validateBaseUrl(input.baseUrl, `${id}.baseUrl`);
    if (input.api !== undefined) {
      const api = requiredString(input.api, `${id}.api`);
      if (project) normalizeProviderApi(api, `${id}.api`);
      provider.api = api;
    }
    if (input.protocol !== undefined) {
      const protocol = requiredString(input.protocol, `${id}.protocol`);
      if (project) normalizeProviderApi(protocol, `${id}.protocol`);
      provider.protocol = protocol;
    }
    if (input.headers !== undefined) provider.headers = parseHeaders(input.headers, project);
    if (input.models !== undefined) provider.models = parseModels(input.models, project, id);
    providers[id] = provider;
  }
  return { providers };
}

function parseModels(value: unknown, project: boolean, providerId: string): ProviderModelRecord[] {
  if (!Array.isArray(value)) throw new Error(`${providerId}.models 必须是 array`);
  return value.map((input, index) => {
    if (!isRecord(input)) throw new Error(`${providerId}.models[${index}] schema 无效`);
    if (project && Object.keys(input).some((key) => !MODEL_FIELDS.has(key))) {
      throw new Error(`${providerId}.models[${index}] 包含不允许的字段`);
    }
    const model: ProviderModelRecord = {
      id: requiredString(input.id, `${providerId}.models[${index}].id`),
      name: requiredString(input.name ?? input.id, `${providerId}.models[${index}].name`),
    };
    if (input.contextWindow !== undefined) model.contextWindow = positiveNumber(input.contextWindow, "contextWindow");
    if (input.input !== undefined) {
      if (
        !Array.isArray(input.input) ||
        input.input.length === 0 ||
        input.input.some((item) => item !== "text" && item !== "image") ||
        !input.input.includes("text")
      ) {
        throw new Error(`${providerId}.models[${index}].input 必须是包含 text 的非空 text/image array`);
      }
      model.input = [...input.input] as string[];
    }
    if (input.inputUsdPerMillion !== undefined) {
      model.inputUsdPerMillion = nonNegativeNumber(input.inputUsdPerMillion, "inputUsdPerMillion");
    }
    if (input.outputUsdPerMillion !== undefined) {
      model.outputUsdPerMillion = nonNegativeNumber(input.outputUsdPerMillion, "outputUsdPerMillion");
    }
    if (input.api !== undefined) {
      const api = requiredString(input.api, "api");
      if (project) normalizeProviderApi(api, `${providerId}.models[${index}].api`);
      model.api = api;
    }
    if (input.baseUrl !== undefined) model.baseUrl = validateBaseUrl(input.baseUrl, "model.baseUrl");
    if (input.reasoning !== undefined) {
      if (typeof input.reasoning !== "boolean") throw new Error("model.reasoning 必须是 boolean");
      model.reasoning = input.reasoning;
    }
    if (input.thinkingLevelMap !== undefined) {
      model.thinkingLevelMap = parseThinkingLevelMap(input.thinkingLevelMap, providerId, index);
    }
    if (input.cost !== undefined) model.cost = parseCost(input.cost);
    if (input.maxTokens !== undefined) {
      model.maxTokens = positiveNumber(input.maxTokens, "maxTokens");
      if (model.contextWindow !== undefined && model.maxTokens > model.contextWindow) {
        throw new Error(`${providerId}.models[${index}].maxTokens 不能大于 contextWindow`);
      }
    }
    if (input.headers !== undefined) model.headers = parseHeaders(input.headers, project);
    return model;
  });
}

function serializeGlobalModel(model: ProviderModelRecord, api: SupportedProviderApi): Record<string, unknown> {
  const cost =
    model.cost ??
    (model.inputUsdPerMillion !== undefined || model.outputUsdPerMillion !== undefined
      ? {
          input: model.inputUsdPerMillion ?? 0,
          output: model.outputUsdPerMillion ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        }
      : undefined);
  return {
    id: model.id,
    name: model.name,
    api,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.input ? { input: model.input } : {}),
    ...(cost ? { cost } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.headers ? { headers: model.headers } : {}),
  };
}

function parseThinkingLevelMap(
  value: unknown,
  providerId: string,
  modelIndex: number,
): Partial<Record<EffortLevel, string | null>> {
  if (!isRecord(value)) throw new Error(`${providerId}.models[${modelIndex}].thinkingLevelMap 必须是 object`);
  const levels = new Set<EffortLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const output: Partial<Record<EffortLevel, string | null>> = {};
  for (const [level, mapped] of Object.entries(value)) {
    if (!levels.has(level as EffortLevel) || (mapped !== null && typeof mapped !== "string")) {
      throw new Error(`${providerId}.models[${modelIndex}].thinkingLevelMap schema 无效`);
    }
    output[level as EffortLevel] = mapped;
  }
  return output;
}

function parseCost(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  if (!isRecord(value)) throw new Error("model.cost 必须是 object");
  return {
    input: nonNegativeNumber(value.input, "cost.input"),
    output: nonNegativeNumber(value.output, "cost.output"),
    cacheRead: nonNegativeNumber(value.cacheRead ?? 0, "cost.cacheRead"),
    cacheWrite: nonNegativeNumber(value.cacheWrite ?? 0, "cost.cacheWrite"),
  };
}

function parseHeaders(value: unknown, project: boolean): Record<string, string> {
  if (!isRecord(value)) throw new Error("headers 必须是 object");
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (project && SENSITIVE_HEADER.test(name)) throw new Error(`project header ${name} 不允许包含 credential`);
    headers[name] = requiredString(raw, `headers.${name}`);
  }
  return headers;
}

function assertNoProjectSecrets(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.trimStart().startsWith("!")) throw new Error(`${path} 不允许 command 值`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoProjectSecrets(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) throw new Error(`${path}.${key} 不允许 secret/credential 字段`);
    assertNoProjectSecrets(child, `${path}.${key}`);
  }
}

function mergeProvider(
  merged: Map<string, ProviderRecord>,
  id: string,
  input: ProviderLayer | ProviderRecord,
  source: ProviderSource,
): void {
  const current = merged.get(id);
  const modelMap = new Map<string, ProviderModelRecord>();
  for (const model of current?.models ?? []) modelMap.set(model.id, { ...model });
  for (const model of input.models ?? []) {
    const previous = modelMap.get(model.id);
    modelMap.set(model.id, { ...previous, ...model });
  }
  merged.set(id, {
    id,
    name: input.name ?? current?.name ?? id,
    source,
    ...(input.baseUrl !== undefined
      ? { baseUrl: input.baseUrl }
      : current?.baseUrl
        ? { baseUrl: current.baseUrl }
        : {}),
    ...(input.api !== undefined ? { api: input.api } : current?.api ? { api: current.api } : {}),
    ...(input.protocol !== undefined
      ? { protocol: input.protocol }
      : current?.protocol
        ? { protocol: current.protocol }
        : {}),
    ...(current?.headers || input.headers ? { headers: { ...current?.headers, ...input.headers } } : {}),
    models: [...modelMap.values()],
  });
}

function validateBaseUrl(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${path} 必须是有效 URL`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error(`${path} 只允许无凭据 HTTP(S) URL`);
  return raw;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} 必须是非空 string`);
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${path} 必须是正数`);
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} 必须是非负数`);
  return value;
}

export function normalizeProviderApi(value: string, path = "protocol"): SupportedProviderApi {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/g, "-");
  if (normalized === "openai-responses" || normalized === "responses" || normalized === "openai-response") {
    return "openai-responses";
  }
  if (
    normalized === "openai-completions" ||
    normalized === "openai-completion" ||
    normalized === "openai-compatible" ||
    normalized === "completions" ||
    normalized === "completion"
  ) {
    return "openai-completions";
  }
  if (normalized === "anthropic-messages" || normalized === "anthropic-message" || normalized === "anthropic") {
    return "anthropic-messages";
  }
  if (
    normalized === "google-generative-ai" ||
    normalized === "google" ||
    normalized === "gemini" ||
    normalized === "google-gemini"
  ) {
    return "google-generative-ai";
  }
  throw new Error(`${path} 使用了不支持的协议：${value}`);
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(sortValue(value)));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
