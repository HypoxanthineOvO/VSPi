import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inspectProjectPath, prepareProjectPath, verifyProjectParent } from "../config/project-path-guard.js";
import { POLICY_LEVELS, type PolicyLevel } from "./execution-policy.js";

export interface PolicyConfigSnapshot {
  globalPolicy: PolicyLevel;
  projectPolicy?: PolicyLevel;
  effectivePolicy: PolicyLevel;
  networkAllowlist: string[];
  hash: string;
  diagnostics: string[];
}

interface PolicyConfigValue {
  policy: PolicyLevel;
  networkAllowlist?: string[];
}

export function createPolicyConfigService(options: {
  cwd: string;
  home: string;
  trustedProject: boolean;
  recovery?: boolean;
}) {
  const globalPath = join(resolve(options.home), ".config", "vspi", "policy.json");
  const projectPath = join(resolve(options.cwd), ".vspi", "policy.json");
  const projectEnabled = options.trustedProject && !options.recovery;

  async function load(): Promise<PolicyConfigSnapshot> {
    const diagnostics: string[] = [];
    const global = await readConfig(globalPath, "global", diagnostics);
    const project = projectEnabled ? await readProjectConfig(projectPath, diagnostics) : undefined;
    const globalPolicy = global.value?.policy ?? "Auto";
    const projectPolicy = project?.value?.policy;
    const effectivePolicy = options.recovery
      ? "Standard"
      : projectPolicy && policyIndex(projectPolicy) < policyIndex(globalPolicy)
        ? projectPolicy
        : globalPolicy;
    const globalAllowlist = global.value?.networkAllowlist ?? [];
    const projectAllowlist = project?.value?.networkAllowlist;
    const networkAllowlist = options.recovery
      ? []
      : projectAllowlist
        ? globalAllowlist.filter((entry) => projectAllowlist.includes(entry))
        : globalAllowlist;
    return {
      globalPolicy,
      ...(projectPolicy ? { projectPolicy } : {}),
      effectivePolicy,
      networkAllowlist,
      hash: hashCanonical({
        global: global.rawState,
        project: projectEnabled ? (project?.rawState ?? null) : { ignored: true },
        projectEnabled,
        recovery: options.recovery ?? false,
      }),
      diagnostics,
    };
  }

  async function save(
    scope: "global" | "project",
    input: { policy: PolicyLevel; networkAllowlist?: string[]; [key: string]: unknown },
    saveOptions: { expectedHash: string },
  ): Promise<{ hash: string; path: string }> {
    const value = validateValue(input);
    if (scope === "project" && !projectEnabled) {
      throw new Error("Recovery 或未授予 trust 时拒绝保存 project Policy");
    }
    if (scope === "project") {
      const current = await load();
      if (policyIndex(value.policy) > policyIndex(current.globalPolicy)) {
        throw new Error(`project Policy ${value.policy} 不能提升 global 上限 ${current.globalPolicy}`);
      }
    }
    const target = scope === "project" ? projectPath : globalPath;
    return withLock(target, scope, async () => {
      const current = await load();
      if (current.hash !== saveOptions.expectedHash) {
        throw new Error(`Policy config conflict: expected hash ${saveOptions.expectedHash}, current ${current.hash}`);
      }
      await writeAtomic(target, value, scope);
      return { hash: (await load()).hash, path: target };
    });
  }

  async function withLock<T>(target: string, scope: "global" | "project", operation: () => Promise<T>): Promise<T> {
    if (scope === "project") {
      const project = await prepareProjectPath(options.cwd, "policy.json");
      await chmod(project.projectDir, 0o700);
    } else {
      await prepareGlobalParent(target);
    }
    const lockPath = `${target}.lock`;
    await assertSafeEntry(lockPath, `${scope} Policy lock`);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Policy config conflict: writer lock exists");
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async function writeAtomic(target: string, value: PolicyConfigValue, scope: "global" | "project"): Promise<void> {
    const project = scope === "project" ? await inspectProjectPath(options.cwd, "policy.json") : undefined;
    if (project) await verifyProjectParent(project);
    await assertSafeEntry(target, `${scope} Policy target`);
    const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
    await assertSafeEntry(temporary, `${scope} Policy temporary`);
    await writeFile(temporary, `${JSON.stringify(sortValue(value), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    try {
      if (project) await verifyProjectParent(project);
      await assertSafeEntry(target, `${scope} Policy target`);
      await assertSafeEntry(temporary, `${scope} Policy temporary`);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  return { load, save };
}

async function readProjectConfig(path: string, diagnostics: string[]) {
  try {
    await inspectProjectPath(dirname(dirname(path)), "policy.json");
  } catch (error) {
    diagnostics.push(`project policy.json scope 边界拒绝：${errorMessage(error)}`);
    return { value: undefined, rawState: { rejected: "project-scope" } };
  }
  return readConfig(path, "project", diagnostics);
}

async function readConfig(path: string, label: string, diagnostics: string[]) {
  try {
    const raw = await readFile(path, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      return { value: validateValue(parsed), rawState: parsed };
    } catch (error) {
      diagnostics.push(`${label} policy.json 无效：${errorMessage(error)}`);
      return { value: undefined, rawState: { damaged: true, hash: sha256(raw) } };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: undefined, rawState: null };
    diagnostics.push(`${label} policy.json 读取失败：${errorMessage(error)}`);
    return { value: undefined, rawState: { rejected: true } };
  }
}

function validateValue(input: unknown): PolicyConfigValue {
  assertNoSecrets(input, "policy");
  if (!isRecord(input)) throw new Error("Policy config 必须是 object");
  const unknown = Object.keys(input).filter((key) => key !== "policy" && key !== "networkAllowlist");
  if (unknown.length > 0) throw new Error(`Policy config 包含不允许字段：${unknown.join(", ")}`);
  if (!POLICY_LEVELS.includes(input.policy as PolicyLevel)) throw new Error("policy 必须是 Safe/Standard/Auto/YOLO");
  let networkAllowlist: string[] | undefined;
  if (input.networkAllowlist !== undefined) {
    if (!Array.isArray(input.networkAllowlist)) throw new Error("networkAllowlist 必须是 array");
    networkAllowlist = [...new Set(input.networkAllowlist.map(validateNetworkTarget))];
  }
  return {
    policy: input.policy as PolicyLevel,
    ...(networkAllowlist ? { networkAllowlist } : {}),
  };
}

function validateNetworkTarget(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("networkAllowlist target 必须是 URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("networkAllowlist target 必须是有效 URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("networkAllowlist 只允许无凭据 HTTP(S) URL");
  }
  if (url.search || url.hash) {
    throw new Error("networkAllowlist 不允许 URL query 或 fragment");
  }
  return value.replace(/\/$/, "");
}

function assertNoSecrets(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.trimStart().startsWith("!")) throw new Error(`${path} 不允许 command 值`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoSecrets(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:api[-_]?key|token|secret|password|credential)/i.test(key)) {
      throw new Error(`${path}.${key} 不允许 secret/credential`);
    }
    if (/^(?:headers?|authorization|cookie|x-api-key)$/i.test(key)) {
      throw new Error(`${path}.${key} 不允许 sensitive header`);
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

async function prepareGlobalParent(target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700);
  await assertSafeEntry(target, "global Policy target");
}

async function assertSafeEntry(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`${label} 拒绝符号链接 (symlink)`);
    if (!entry.isFile()) throw new Error(`${label} 必须是普通文件`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function policyIndex(policy: PolicyLevel): number {
  return POLICY_LEVELS.indexOf(policy);
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
