import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeEffortLevel } from "../domain/effort.js";
import type { EffortLevel } from "../domain/types.js";
import {
  assertProjectEntrySafe,
  inspectProjectPath,
  prepareProjectPath,
  verifyProjectParent,
} from "./project-path-guard.js";

export interface RuntimeDefaults {
  model?: { provider: string; id: string };
  effort: EffortLevel;
}

export interface RuntimeDefaultsServiceOptions {
  cwd: string;
  home?: string;
  trustedProject: boolean;
}

const STORED_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "低", "中", "高"]);

export function createRuntimeDefaultsService(options: RuntimeDefaultsServiceOptions) {
  const home = options.home ?? homedir();
  const paths = {
    global: join(home, ".config", "vspi", "runtime-defaults.json"),
    project: join(resolve(options.cwd), ".vspi", "runtime-defaults.json"),
  } as const;

  async function load(): Promise<{ value: RuntimeDefaults; diagnostics: string[] }> {
    const diagnostics: string[] = [];
    const global = await readDefaults(paths.global, diagnostics);
    const project = options.trustedProject
      ? await readProjectDefaults(options.cwd, paths.project, diagnostics)
      : undefined;
    const model = project?.model ?? global?.model;
    return {
      value: {
        ...global,
        ...project,
        ...(model ? { model } : {}),
        effort: normalizeEffortLevel(project?.effort ?? global?.effort),
      },
      diagnostics,
    };
  }

  async function save(scope: "global" | "project", value: RuntimeDefaults): Promise<string> {
    validateDefaults(value);
    if (scope === "project" && !options.trustedProject) {
      throw new Error("项目 trust 尚未授予，拒绝保存 project runtime defaults");
    }
    const target = paths[scope];
    const projectScope =
      scope === "project" ? await prepareProjectPath(options.cwd, "runtime-defaults.json") : undefined;
    if (projectScope) {
      await chmod(projectScope.projectDir, 0o700);
      await verifyProjectParent(projectScope);
      await assertProjectEntrySafe(target, "runtime defaults project target");
    } else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await chmod(dirname(target), 0o700);
    }
    const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
    if (projectScope) await assertProjectEntrySafe(temporary, "runtime defaults temporary file");
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    try {
      if (projectScope) {
        await verifyProjectParent(projectScope);
        await assertProjectEntrySafe(target, "runtime defaults project target");
        await assertProjectEntrySafe(temporary, "runtime defaults temporary file");
      }
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return target;
  }

  return { load, save, paths };
}

async function readProjectDefaults(
  cwd: string,
  path: string,
  diagnostics: string[],
): Promise<RuntimeDefaults | undefined> {
  try {
    await inspectProjectPath(cwd, "runtime-defaults.json");
  } catch (error) {
    diagnostics.push(
      `project runtime-defaults.json scope 边界拒绝：${error instanceof Error ? error.message : "未知错误"}`,
    );
    return undefined;
  }
  return readDefaults(path, diagnostics);
}

async function readDefaults(path: string, diagnostics: string[]): Promise<RuntimeDefaults | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    validateDefaults(value);
    const defaults = value as RuntimeDefaults;
    return { ...defaults, effort: normalizeEffortLevel(defaults.effort) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    diagnostics.push(`${path} 无效：${error instanceof Error ? error.message : "未知错误"}`);
    return undefined;
  }
}

function validateDefaults(value: unknown): asserts value is RuntimeDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime defaults 必须是 object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "model" && key !== "effort"))
    throw new Error("runtime defaults 包含未知字段");
  if (typeof input.effort !== "string" || !STORED_EFFORTS.has(input.effort)) {
    throw new Error("default effort 必须是 off/minimal/low/medium/high/xhigh/max");
  }
  if (input.model !== undefined) {
    if (!input.model || typeof input.model !== "object" || Array.isArray(input.model)) {
      throw new Error("default model 必须是 {provider,id}");
    }
    const model = input.model as Record<string, unknown>;
    if (
      Object.keys(model).some((key) => key !== "provider" && key !== "id") ||
      typeof model.provider !== "string" ||
      !model.provider ||
      typeof model.id !== "string" ||
      !model.id
    ) {
      throw new Error("default model 必须包含非空 provider/id");
    }
  }
}
