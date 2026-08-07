import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  assertProjectEntrySafe,
  inspectProjectPath,
  prepareProjectPath,
  verifyProjectParent,
} from "../config/project-path-guard.js";
import { EFFORT_LEVELS, type EffortLevel } from "../domain/types.js";
import {
  AGENT_ROLES,
  AGENT_ROUTING_MODES,
  type AgentModelPoolConfig,
  type AgentProjectConfig,
  type AgentRole,
  type AgentRoutingMode,
  type TeammateDefinition,
} from "./types.js";

export const AGENT_CONFIG_FILE = "agents.json";
export const AGENT_TOOL_NAMES = ["read", "ls", "find", "grep", "bash", "edit", "write"] as const;

export function defaultAgentProjectConfig(): AgentProjectConfig {
  return {
    version: 1,
    maxConcurrency: 16,
    allowedModels: ["*"],
    modelPools: {},
    crossProviderDelegation: false,
    teammates: [],
  };
}

export async function loadAgentProjectConfig(cwd: string, trustedProject: boolean): Promise<AgentProjectConfig> {
  if (!trustedProject) return defaultAgentProjectConfig();
  const scope = await inspectProjectPath(cwd, AGENT_CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(scope.target, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return defaultAgentProjectConfig();
    if (error instanceof SyntaxError) throw new Error(".vspi/agents.json is not valid JSON");
    throw error;
  }
  return normalizeConfig(raw);
}

export async function saveAgentProjectConfig(
  cwd: string,
  trustedProject: boolean,
  input: AgentProjectConfig,
): Promise<string> {
  if (!trustedProject) throw new Error("Project trust is required to change teammate configuration");
  const config = normalizeConfig(input);
  const scope = await prepareProjectPath(cwd, AGENT_CONFIG_FILE);
  await chmod(scope.projectDir, 0o700);
  await verifyProjectParent(scope);
  await assertProjectEntrySafe(scope.target, "agent configuration target");
  const temporary = `${scope.target}.${process.pid}-${randomUUID()}.tmp`;
  await assertProjectEntrySafe(temporary, "agent configuration temporary file");
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  try {
    await verifyProjectParent(scope);
    await assertProjectEntrySafe(scope.target, "agent configuration target");
    await assertProjectEntrySafe(temporary, "agent configuration temporary file");
    await rename(temporary, scope.target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return scope.target;
}

function normalizeConfig(raw: unknown): AgentProjectConfig {
  if (!isRecord(raw)) throw new Error("Agent configuration must be an object");
  assertKeys(
    raw,
    ["version", "maxConcurrency", "allowedModels", "modelPools", "crossProviderDelegation", "teammates"],
    "agent configuration",
  );
  if (raw.version !== 1) throw new Error("Agent configuration version must be 1");
  const maxConcurrency = normalizeInteger(raw.maxConcurrency ?? 16, 1, 128, "maxConcurrency");
  const allowedModels = normalizeStringList(raw.allowedModels ?? ["*"], 128, 200, "allowedModels");
  if (allowedModels.some((value) => !isModelSelector(value, true))) {
    throw new Error("allowedModels contains an invalid model selector");
  }
  const modelPools = normalizeModelPools(raw.modelPools ?? {});
  const crossProviderDelegation = raw.crossProviderDelegation ?? false;
  if (typeof crossProviderDelegation !== "boolean") throw new Error("crossProviderDelegation must be a boolean");
  if (!Array.isArray(raw.teammates) || raw.teammates.length > 64) {
    throw new Error("teammates must be an array with at most 64 entries");
  }
  const teammates = raw.teammates.map(normalizeTeammate);
  if (new Set(teammates.map((item) => item.id)).size !== teammates.length) {
    throw new Error("Teammate IDs must be unique");
  }
  return { version: 1, maxConcurrency, allowedModels, modelPools, crossProviderDelegation, teammates };
}

function normalizeModelPools(value: unknown): Record<string, AgentModelPoolConfig> {
  if (!isRecord(value) || Object.keys(value).length > 64) throw new Error("modelPools must be an object");
  const pools: Record<string, AgentModelPoolConfig> = {};
  for (const [provider, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provider) || !isRecord(raw)) throw new Error("modelPools is invalid");
    assertKeys(raw, ["roles"], `modelPools.${provider}`);
    if (!isRecord(raw.roles)) throw new Error(`modelPools.${provider}.roles must be an object`);
    assertKeys(raw.roles, [...AGENT_ROLES], `modelPools.${provider}.roles`);
    const roles: Partial<Record<AgentRole, string>> = {};
    for (const role of AGENT_ROLES) {
      const selector = raw.roles[role];
      if (selector === undefined) continue;
      if (typeof selector !== "string" || !isModelSelector(selector, false)) {
        throw new Error(`modelPools.${provider}.roles.${role} is invalid`);
      }
      roles[role] = selector;
    }
    pools[provider] = { roles };
  }
  return pools;
}

function normalizeTeammate(raw: unknown): TeammateDefinition {
  if (!isRecord(raw)) throw new Error("Each teammate must be an object");
  assertKeys(
    raw,
    [
      "id",
      "role",
      "description",
      "routing",
      "match",
      "systemPrompt",
      "tools",
      "preferredModel",
      "currentModel",
      "effort",
      "fallbackModels",
      "fallback",
    ],
    "teammate",
  );
  const id = identifier(raw.id, "teammate id");
  const role = displayText(raw.role, 120, "teammate role");
  const description = displayText(raw.description, 500, "teammate description");
  const routing = raw.routing ?? "manual";
  if (!AGENT_ROUTING_MODES.includes(routing as AgentRoutingMode)) throw new Error(`Invalid routing for ${id}`);
  const match = normalizeStringList(raw.match ?? [], 64, 160, `${id}.match`);
  const systemPrompt = displayText(raw.systemPrompt ?? "", 40_000, `${id}.systemPrompt`, true);
  const tools = normalizeStringList(raw.tools ?? ["read", "ls", "find", "grep"], 7, 40, `${id}.tools`);
  if (tools.some((tool) => !(AGENT_TOOL_NAMES as readonly string[]).includes(tool))) {
    throw new Error(`${id}.tools contains an unsupported tool`);
  }
  const preferredModel = optionalModel(raw.preferredModel, `${id}.preferredModel`);
  const currentModel = optionalModel(raw.currentModel, `${id}.currentModel`);
  const effort = optionalEffort(raw.effort, `${id}.effort`);
  const fallbackModels = normalizeStringList(raw.fallbackModels ?? [], 16, 200, `${id}.fallbackModels`);
  if (fallbackModels.some((value) => !isModelSelector(value, false))) {
    throw new Error(`${id}.fallbackModels contains an invalid model selector`);
  }
  const fallback = normalizeFallback(raw.fallback, id);
  return {
    id,
    role,
    description,
    routing: routing as AgentRoutingMode,
    match,
    systemPrompt,
    tools: [...new Set(tools)],
    ...(preferredModel ? { preferredModel } : {}),
    ...(currentModel ? { currentModel } : {}),
    ...(effort ? { effort } : {}),
    fallbackModels,
    ...(fallback ? { fallback } : {}),
  };
}

function normalizeFallback(value: unknown, id: string): TeammateDefinition["fallback"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${id}.fallback must be an object`);
  assertKeys(value, ["from", "reason", "at"], `${id}.fallback`);
  const from = optionalModel(value.from, `${id}.fallback.from`);
  if (
    !from ||
    value.reason !== "quota_exhausted" ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at))
  ) {
    throw new Error(`${id}.fallback is invalid`);
  }
  return { from, reason: "quota_exhausted", at: new Date(value.at).toISOString() };
}

function optionalEffort(value: unknown, label: string): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as EffortLevel;
}

function optionalModel(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isModelSelector(value, false)) throw new Error(`${label} is invalid`);
  return value;
}

function isModelSelector(value: string, wildcard: boolean): boolean {
  if (wildcard && value === "*") return true;
  if (wildcard && /^[A-Za-z0-9._-]+\/\*$/.test(value)) return true;
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:+-]+$/.test(value);
}

function normalizeStringList(value: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is invalid`);
  return value.map((item) => displayText(item, maxLength, label));
}

function displayText(value: unknown, maxLength: number, label: string, allowNewline = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC");
  const controlProbe = allowNewline ? normalized.replace(/[\n\t]/g, "") : normalized;
  if (Array.from(normalized).length > maxLength || /[\p{Cc}\p{Cf}]/u.test(controlProbe)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function normalizeInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${label} has unsupported keys: ${extra.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
