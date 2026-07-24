import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SETTINGS } from "../domain/defaults.js";
import type { AppSettings } from "../domain/types.js";
import {
  assertProjectEntrySafe,
  inspectProjectPath,
  prepareProjectPath,
  verifyProjectParent,
} from "./project-path-guard.js";

export interface SettingsTrustContext {
  trustedProject: boolean;
}

const THEME_VALUES = new Set<AppSettings["theme"]>(["VSPi Dark", "VSPi Light", "Terminal"]);

function normalizeSettings(input: unknown, fallback: AppSettings): AppSettings {
  if (!input || typeof input !== "object") return { ...fallback };
  const value = input as Partial<AppSettings>;
  return {
    scope: value.scope === "global" || value.scope === "project" ? value.scope : fallback.scope,
    theme: value.theme && THEME_VALUES.has(value.theme) ? value.theme : fallback.theme,
    reducedMotion: typeof value.reducedMotion === "boolean" ? value.reducedMotion : fallback.reducedMotion,
    showThinking: typeof value.showThinking === "boolean" ? value.showThinking : fallback.showThinking,
    wrapCode: typeof value.wrapCode === "boolean" ? value.wrapCode : fallback.wrapCode,
    bridgeEnabled: typeof value.bridgeEnabled === "boolean" ? value.bridgeEnabled : fallback.bridgeEnabled,
  };
}

async function readOptional(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function settingsPaths(cwd: string, home = homedir()) {
  return {
    global: join(home, ".config", "vspi", "settings.json"),
    project: join(resolve(cwd), ".vspi", "settings.json"),
  } as const;
}

export async function loadSettings(
  cwd: string,
  home = homedir(),
  trust: SettingsTrustContext = { trustedProject: false },
): Promise<AppSettings> {
  const paths = settingsPaths(cwd, home);
  const global = normalizeSettings(await readOptional(paths.global), { ...DEFAULT_SETTINGS, scope: "global" });
  if (!trust.trustedProject) return global;
  await inspectProjectPath(cwd, "settings.json");
  return normalizeSettings(await readOptional(paths.project), { ...global, scope: "project" });
}

export async function saveSettings(
  cwd: string,
  settings: AppSettings,
  home = homedir(),
  trust: SettingsTrustContext = { trustedProject: false },
): Promise<string> {
  const paths = settingsPaths(cwd, home);
  if (settings.scope === "project" && !trust.trustedProject) {
    throw new Error("项目 trust 尚未授予，拒绝保存 project settings");
  }
  const target = settings.scope === "global" ? paths.global : paths.project;
  const projectScope = settings.scope === "project" ? await prepareProjectPath(cwd, "settings.json") : undefined;
  if (projectScope) {
    await chmod(projectScope.projectDir, 0o700);
    await verifyProjectParent(projectScope);
    await assertProjectEntrySafe(target, "project settings target");
  } else {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  }
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  if (projectScope) await assertProjectEntrySafe(temporary, "project settings temporary file");
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  try {
    if (projectScope) {
      await verifyProjectParent(projectScope);
      await assertProjectEntrySafe(target, "project settings target");
      await assertProjectEntrySafe(temporary, "project settings temporary file");
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return target;
}
