import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertProjectEntrySafe,
  inspectProjectPath,
  prepareProjectPath,
  verifyProjectParent,
} from "../config/project-path-guard.js";
import { createFactoryPromptRegistry, type FactoryPromptRegistry } from "./factory-registry.js";
import type {
  ModelIdentity,
  ProfileSourceType,
  PromptProfile,
  PromptProfileConfig,
  PromptProfileRule,
  PromptProfileSnapshot,
  ResolvedPromptProfile,
} from "./types.js";

type ProfileScope = "global" | "project" | "session";

export interface PromptProfileService {
  load(): Promise<PromptProfileSnapshot>;
  resolve(input: ModelIdentity & { session?: PromptProfileConfig }): ResolvedPromptProfile;
  fork(factoryId: string, input: { id: string; name: string; scope: ProfileScope }): Promise<PromptProfile>;
  save(
    scope: ProfileScope,
    config: PromptProfileConfig,
    options?: { expectedHash?: string },
  ): Promise<PromptProfileSnapshot>;
  import(serialized: string, options: { scope: ProfileScope }): Promise<PromptProfile>;
  export(profileId: string): string;
  importFile(path: string, options: { scope: ProfileScope }): Promise<PromptProfile>;
  writeExport(profileId: string): Promise<string>;
  refreshFactory(registry: FactoryPromptRegistry): void;
}

const EMPTY_CONFIG: PromptProfileConfig = {
  schemaVersion: 1,
  source: "vspi.prompt-profile",
  profiles: [],
  rules: [],
};

export function createPromptProfileService(options: {
  cwd: string;
  home: string;
  trustedProject: boolean;
  factoryRegistry?: FactoryPromptRegistry | undefined;
}): PromptProfileService {
  let registry = options.factoryRegistry ?? createFactoryPromptRegistry();
  const paths = {
    global: join(resolve(options.home), ".config", "vspi", "prompt-profiles.json"),
    project: join(resolve(options.cwd), ".vspi", "prompt-profiles.json"),
  };
  let global = structuredClone(EMPTY_CONFIG);
  let project: PromptProfileConfig | undefined;
  let session: PromptProfileConfig | undefined;
  let hashes = { global: hashConfig(global) } as PromptProfileSnapshot["hashes"];
  let diagnostics: Array<{ path: string; message: string }> = [];

  async function load(): Promise<PromptProfileSnapshot> {
    const nextDiagnostics: Array<{ path: string; message: string }> = [];
    const factoryIds = new Set(registry.list().map((profile) => profile.id));
    global = await loadLayer(paths.global, global, "global", nextDiagnostics, factoryIds);
    if (options.trustedProject) {
      await inspectProjectPath(options.cwd, "prompt-profiles.json");
      project = await loadLayer(
        paths.project,
        project ?? structuredClone(EMPTY_CONFIG),
        "project",
        nextDiagnostics,
        factoryIds,
      );
    } else {
      project = undefined;
    }
    diagnostics = nextDiagnostics;
    hashes = {
      global: hashConfig(global),
      ...(project ? { project: hashConfig(project) } : {}),
      ...(session ? { session: hashConfig(session) } : {}),
    };
    return snapshot();
  }

  function snapshot(): PromptProfileSnapshot {
    return {
      profiles: allProfiles(registry, global, project, session),
      rules: [...global.rules, ...(project?.rules ?? []), ...(session?.rules ?? [])].map((rule) =>
        structuredClone(rule),
      ),
      global: structuredClone(global),
      ...(project ? { project: structuredClone(project) } : {}),
      ...(session ? { session: structuredClone(session) } : {}),
      hashes: { ...hashes },
      hash: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
      diagnostics: [...diagnostics],
    };
  }

  async function save(
    scope: ProfileScope,
    config: PromptProfileConfig,
    saveOptions: { expectedHash?: string } = {},
  ): Promise<PromptProfileSnapshot> {
    assertScopeAllowed(scope, options.trustedProject);
    const current = layerFor(scope, global, project, session);
    const normalized = normalizeConfig(config, scope, current.profiles);
    const factoryIds = new Set(registry.list().map((profile) => profile.id));
    if (normalized.profiles.some((profile) => factoryIds.has(profile.id))) {
      throw new Error("Prompt Profile layer cannot shadow an immutable Factory id");
    }
    const currentHash = hashes[scope];
    if (saveOptions.expectedHash !== undefined && saveOptions.expectedHash !== currentHash) {
      throw new Error(`Prompt Profile ${scope} expectedHash conflict`);
    }
    if (scope === "session") {
      session = normalized;
      hashes.session = hashConfig(normalized);
    } else {
      await withFileLock(paths[scope], async () => {
        const disk = await readLayerFromDisk(
          paths[scope],
          scope,
          new Set(registry.list().map((profile) => profile.id)),
        );
        const diskHash = hashConfig(disk);
        if (saveOptions.expectedHash !== undefined && saveOptions.expectedHash !== diskHash) {
          throw new Error(`Prompt Profile ${scope} expectedHash conflict`);
        }
        await saveLayer(paths[scope], normalized, scope === "project" ? options.cwd : undefined);
      });
      if (scope === "global") global = normalized;
      else project = normalized;
      hashes[scope] = hashConfig(normalized);
    }
    return snapshot();
  }

  function resolveProfile(input: ModelIdentity & { session?: PromptProfileConfig }): ResolvedPromptProfile {
    const transient = input.session ? normalizeConfig(input.session, "session") : session;
    const layers: Array<{ scope: "session" | "project" | "global"; config: PromptProfileConfig | undefined }> = [
      { scope: "session", config: transient },
      { scope: "project", config: project },
      { scope: "global", config: global },
    ];
    const profiles = allProfiles(registry, global, project, transient);
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const family = modelFamily(input);
    const shadowedRuleIds = new Set<string>();
    for (const layer of layers) {
      if (!layer.config) continue;
      if (layer.config.disabled) return { scope: "off" };
      if (layer.config.pin) {
        const pinned = byId.get(layer.config.pin);
        if (pinned) return resolved(pinned, layer.scope);
      }
      const rules = layer.config.rules.filter((rule) => !shadowedRuleIds.has(rule.id));
      const rule = bestRule(rules, input, family);
      if (rule) {
        const profile = byId.get(rule.profileId);
        if (profile) return { ...resolved(profile, layer.scope), ruleId: rule.id, matchedRuleId: rule.id };
      }
      for (const candidate of layer.config.rules) shadowedRuleIds.add(candidate.id);
    }
    const factory = registry.get(`factory-${family}`);
    return factory ? resolved(factory, "factory") : { scope: "factory" };
  }

  async function fork(
    factoryId: string,
    input: { id: string; name: string; scope: ProfileScope },
  ): Promise<PromptProfile> {
    assertScopeAllowed(input.scope, options.trustedProject);
    const factory = registry.get(factoryId);
    if (!factory) throw new Error(`Prompt Profile factory not found: ${factoryId}`);
    const profile = normalizeProfile(
      {
        ...structuredClone(factory),
        id: input.id,
        name: input.name,
        sourceType: "user-fork",
        immutable: false,
        origin: { ...factory.origin, profileId: factory.id },
      },
      input.scope,
      "profile",
    );
    const layer = layerFor(input.scope, global, project, session);
    if (allProfiles(registry, global, project, session).some((item) => item.id === profile.id)) {
      throw new Error(`Prompt Profile id already exists: ${profile.id}`);
    }
    await save(
      input.scope,
      { ...layer, profiles: [...layer.profiles, profile] },
      { ...(hashes[input.scope] ? { expectedHash: hashes[input.scope] } : {}) },
    );
    return structuredClone(profile);
  }

  async function importProfile(serialized: string, input: { scope: ProfileScope }): Promise<PromptProfile> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new Error("Prompt Profile import $. JSON parse failed", { cause: error });
    }
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.source !== "vspi.prompt-profile" ||
      !isRecord(parsed.profile)
    ) {
      throw new Error("Prompt Profile import $.schemaVersion/source/profile is invalid");
    }
    const imported = normalizeProfile(parsed.profile, input.scope, "$.profile");
    if (imported.sourceType === "factory")
      throw new Error("Prompt Profile import $.profile.sourceType cannot be factory");
    const profile: PromptProfile = { ...imported, sourceType: input.scope, immutable: false };
    const layer = layerFor(input.scope, global, project, session);
    await save(
      input.scope,
      { ...layer, profiles: [...layer.profiles.filter((item) => item.id !== profile.id), profile] },
      {
        ...(hashes[input.scope] ? { expectedHash: hashes[input.scope] } : {}),
      },
    );
    return structuredClone(profile);
  }

  function exportProfile(profileId: string): string {
    const profile = allProfiles(registry, global, project, session).find((item) => item.id === profileId);
    if (!profile) throw new Error(`Prompt Profile not found: ${profileId}`);
    return `${JSON.stringify({ schemaVersion: 1, source: "vspi.prompt-profile", profile }, null, 2)}\n`;
  }

  async function importFile(path: string, input: { scope: ProfileScope }): Promise<PromptProfile> {
    return importProfile(await readFile(resolve(path), "utf8"), input);
  }

  async function writeExport(profileId: string): Promise<string> {
    const directory = join(resolve(options.home), ".config", "vspi", "exports");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${identifier(profileId, "profileId")}.json`);
    await writeAtomically(target, exportProfile(profileId));
    return target;
  }

  function refreshFactory(next: FactoryPromptRegistry): void {
    registry = next;
  }

  return {
    load,
    resolve: resolveProfile,
    fork,
    save,
    import: importProfile,
    export: exportProfile,
    importFile,
    writeExport,
    refreshFactory,
  };
}

async function loadLayer(
  path: string,
  lastValid: PromptProfileConfig,
  scope: ProfileScope,
  diagnostics: Array<{ path: string; message: string }>,
  factoryIds: ReadonlySet<string>,
): Promise<PromptProfileConfig> {
  try {
    const config = normalizeConfig(JSON.parse(await readFile(path, "utf8")), scope);
    assertNoFactoryShadow(config, factoryIds);
    return config;
  } catch (error) {
    if (isCode(error, "ENOENT")) return structuredClone(lastValid);
    diagnostics.push({
      path,
      message: `${scope} prompt profile config retained last-valid: ${error instanceof Error ? error.message : "invalid"}`,
    });
    return structuredClone(lastValid);
  }
}

async function readLayerFromDisk(
  path: string,
  scope: ProfileScope,
  factoryIds: ReadonlySet<string>,
): Promise<PromptProfileConfig> {
  try {
    const config = normalizeConfig(JSON.parse(await readFile(path, "utf8")), scope);
    assertNoFactoryShadow(config, factoryIds);
    return config;
  } catch (error) {
    if (isCode(error, "ENOENT")) return structuredClone(EMPTY_CONFIG);
    throw error;
  }
}

async function withFileLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  const token = randomUUID();
  const ownLock = `${JSON.stringify({ pid: process.pid, token })}\n`;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(ownLock, "utf8");
      await handle.close();
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const ownerText = await readFile(lock, "utf8").catch(() => undefined);
      const owner = ownerText
        ? (() => {
            try {
              return JSON.parse(ownerText) as { pid?: unknown; token?: unknown };
            } catch {
              return undefined;
            }
          })()
        : undefined;
      if (typeof owner?.pid === "number" && !processIsAlive(owner.pid)) {
        if (ownerText) await removeLockIfOwned(lock, ownerText);
        continue;
      }
      if (Date.now() - started > 5_000) throw new Error("Prompt Profile writer lock timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await removeLockIfOwned(lock, ownLock);
  }
}

async function removeLockIfOwned(path: string, expected: string): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === expected) await rm(path, { force: true });
}

function assertNoFactoryShadow(config: PromptProfileConfig, factoryIds: ReadonlySet<string>): void {
  if (config.profiles.some((profile) => factoryIds.has(profile.id))) {
    throw new Error("Prompt Profile layer cannot shadow an immutable Factory id");
  }
}

async function saveLayer(path: string, config: PromptProfileConfig, projectCwd?: string): Promise<void> {
  const projectScope = projectCwd ? await prepareProjectPath(projectCwd, "prompt-profiles.json") : undefined;
  if (!projectScope) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  else {
    await verifyProjectParent(projectScope);
    await assertProjectEntrySafe(path, "project prompt profile target");
  }
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  if (projectScope) await assertProjectEntrySafe(temporary, "project prompt profile temporary");
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    if (projectScope) {
      await verifyProjectParent(projectScope);
      await assertProjectEntrySafe(path, "project prompt profile target");
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function normalizeConfig(
  value: unknown,
  scope: ProfileScope,
  existingProfiles: PromptProfile[] = [],
): PromptProfileConfig {
  if (!isRecord(value)) throw new Error("$. config must be an object");
  if (value.schemaVersion !== 1) throw new Error("$.schemaVersion must be 1");
  if (value.source !== "vspi.prompt-profile") throw new Error("$.source must be vspi.prompt-profile");
  if (value.profiles !== undefined && !Array.isArray(value.profiles)) throw new Error("$.profiles must be an array");
  if (!Array.isArray(value.rules)) throw new Error("$.rules must be an array");
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.map((profile, index) => normalizeProfile(profile, scope, `$.profiles[${index}]`))
    : structuredClone(existingProfiles);
  const rules = value.rules.map((rule, index) => normalizeRule(rule, `$.rules[${index}]`));
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new Error("$.profiles ids must be unique");
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("$.rules ids must be unique");
  const pin = value.pin === undefined ? undefined : identifier(value.pin, "$.pin");
  if (value.disabled !== undefined && typeof value.disabled !== "boolean")
    throw new Error("$.disabled must be boolean");
  return {
    schemaVersion: 1,
    source: "vspi.prompt-profile",
    profiles,
    rules,
    ...(pin ? { pin } : {}),
    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
  };
}

function normalizeProfile(value: unknown, _scope: ProfileScope, path: string): PromptProfile {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const sourceType = value.sourceType;
  const allowedSources = new Set<ProfileSourceType>(["factory", "user-fork", "global", "project", "session"]);
  if (typeof sourceType !== "string" || !allowedSources.has(sourceType as ProfileSourceType)) {
    throw new Error(`${path}.sourceType is invalid`);
  }
  if (sourceType === "factory") throw new Error(`${path}.sourceType factory is immutable`);
  const evaluationStatus = value.evaluationStatus;
  if (!new Set(["unreviewed", "reviewed", "verified"]).has(String(evaluationStatus))) {
    throw new Error(`${path}.evaluationStatus is invalid`);
  }
  if (!isRecord(value.segments) || typeof value.segments.profile !== "string" || !value.segments.profile) {
    throw new Error(`${path}.segments.profile is invalid`);
  }
  const origin = isRecord(value.origin)
    ? (structuredClone(value.origin) as NonNullable<PromptProfile["origin"]>)
    : undefined;
  return {
    id: identifier(value.id, `${path}.id`),
    name: displayText(value.name, `${path}.name`, 200),
    family: identifier(value.family, `${path}.family`),
    sourceType: sourceType as ProfileSourceType,
    evaluationStatus: evaluationStatus as PromptProfile["evaluationStatus"],
    segments: { profile: displayText(value.segments.profile, `${path}.segments.profile`, 20_000) },
    immutable: value.immutable === true,
    ...(origin ? { origin } : {}),
  };
}

function normalizeRule(value: unknown, path: string): PromptProfileRule {
  if (!isRecord(value) || !isRecord(value.match)) throw new Error(`${path}.match is invalid`);
  if (typeof value.enabled !== "boolean") throw new Error(`${path}.enabled must be boolean`);
  const match = {
    ...(value.match.provider === undefined
      ? {}
      : { provider: identifier(value.match.provider, `${path}.match.provider`) }),
    ...(value.match.model === undefined ? {} : { model: identifier(value.match.model, `${path}.match.model`) }),
    ...(value.match.family === undefined ? {} : { family: identifier(value.match.family, `${path}.match.family`) }),
  };
  if (Object.keys(match).length === 0) throw new Error(`${path}.match needs provider, model, or family`);
  return {
    id: identifier(value.id, `${path}.id`),
    profileId: identifier(value.profileId, `${path}.profileId`),
    enabled: value.enabled,
    match,
  };
}

function bestRule(rules: PromptProfileRule[], identity: ModelIdentity, family: string): PromptProfileRule | undefined {
  return rules
    .filter((rule) => rule.enabled && matches(rule, identity, family))
    .sort((left, right) => ruleRank(right) - ruleRank(left))[0];
}

function matches(rule: PromptProfileRule, identity: ModelIdentity, family: string): boolean {
  return (
    (rule.match.model === undefined || rule.match.model === identity.model) &&
    (rule.match.provider === undefined || rule.match.provider === identity.provider) &&
    (rule.match.family === undefined || rule.match.family === family)
  );
}

function ruleRank(rule: PromptProfileRule): number {
  return (rule.match.model ? 4 : 0) + (rule.match.provider ? 2 : 0) + (rule.match.family ? 1 : 0);
}

function modelFamily(identity: ModelIdentity): string {
  const value = `${identity.provider}/${identity.model}`.toLowerCase();
  for (const family of [
    "anthropic",
    "openai",
    "google",
    "deepseek",
    "moonshot",
    "z-ai",
    "xiaomi",
    "minimax",
    "tencent",
    "alibaba",
  ]) {
    if (value.includes(family)) return family;
  }
  if (/claude/.test(value)) return "anthropic";
  if (/gpt|o[1-9]/.test(value)) return "openai";
  if (/gemini/.test(value)) return "google";
  if (/kimi/.test(value)) return "moonshot";
  if (/qwen/.test(value)) return "alibaba";
  if (/hunyuan/.test(value)) return "tencent";
  if (/glm|zhipu/.test(value)) return "z-ai";
  return identity.provider.toLowerCase();
}

function resolved(profile: PromptProfile, scope: ResolvedPromptProfile["scope"]): ResolvedPromptProfile {
  return { profile: structuredClone(profile), profileId: profile.id, overlay: profile.segments.profile, scope };
}

function allProfiles(
  registry: FactoryPromptRegistry,
  global: PromptProfileConfig,
  project?: PromptProfileConfig,
  session?: PromptProfileConfig,
): PromptProfile[] {
  return [...registry.list(), ...global.profiles, ...(project?.profiles ?? []), ...(session?.profiles ?? [])].map(
    (profile) => structuredClone(profile),
  );
}

function layerFor(
  scope: ProfileScope,
  global: PromptProfileConfig,
  project?: PromptProfileConfig,
  session?: PromptProfileConfig,
): PromptProfileConfig {
  return structuredClone(
    scope === "global" ? global : scope === "project" ? (project ?? EMPTY_CONFIG) : (session ?? EMPTY_CONFIG),
  );
}

function assertScopeAllowed(scope: ProfileScope, trustedProject: boolean): void {
  if (scope === "project" && !trustedProject) throw new Error("Project Prompt Profile requires trusted project");
}

function hashConfig(config: PromptProfileConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,96}$/.test(value)) throw new Error(`${path} is invalid`);
  return value;
}

function displayText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || !value || Array.from(value).length > max) throw new Error(`${path} is invalid`);
  return value.normalize("NFC");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}
