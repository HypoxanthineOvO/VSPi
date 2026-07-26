import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  loadSkillsFromDir,
  type PackageSource,
  type ResourceDiagnostic,
  type ResourceLoader,
  type SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type {
  SkillCatalogIssue,
  SkillCatalogItem,
  SkillCatalogSnapshot,
  SkillInstallResult,
  SkillManager,
  SkillScope,
  SkillSourceKind,
} from "./types.js";

interface SkillServiceOptions {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  resourceLoader: ResourceLoader;
  home?: string;
  packageManager?: Pick<
    DefaultPackageManager,
    "resolve" | "listConfiguredPackages" | "install" | "getInstalledPath" | "remove" | "removeAndPersist" | "update"
  >;
}

interface ExternalSkill {
  skill: Skill;
  source: "codex" | "claude";
}

export class PiSkillManager implements SkillManager {
  private readonly packageManager: NonNullable<SkillServiceOptions["packageManager"]>;
  private readonly home: string;

  constructor(private readonly options: SkillServiceOptions) {
    this.home = options.home ?? homedir();
    this.packageManager =
      options.packageManager ??
      new DefaultPackageManager({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager: options.settingsManager,
      });
  }

  async list(): Promise<SkillCatalogSnapshot> {
    const issues: SkillCatalogIssue[] = [];
    const external = this.externalSkills(issues);
    const externalByPath = new Map(external.map((entry) => [canonicalPath(entry.skill.filePath), entry]));
    const enabledPaths = new Set(
      this.options.resourceLoader.getSkills().skills.map((skill) => canonicalPath(skill.filePath)),
    );
    issues.push(...this.options.resourceLoader.getSkills().diagnostics.map(issueFromDiagnostic));

    const items = new Map<string, SkillCatalogItem>();
    const resolved = await this.packageManager.resolve(async () => "skip");
    for (const resource of resolved.skills.filter((entry) => entry.metadata.origin !== "package")) {
      const parsed = loadSkillsFromDir({ dir: dirname(resource.path), source: resource.metadata.source });
      issues.push(...parsed.diagnostics.map(issueFromDiagnostic));
      const skill = parsed.skills.find((entry) => canonicalPath(entry.filePath) === canonicalPath(resource.path));
      if (!skill) continue;
      const path = canonicalPath(skill.filePath);
      const externalEntry = externalByPath.get(path);
      const enabled = enabledPaths.has(path) && resource.enabled;
      items.set(
        path,
        catalogItem(skill, {
          source: externalEntry?.source ?? (resource.metadata.scope === "project" ? "project" : "pi"),
          scope: resource.metadata.scope === "project" ? "project" : "user",
          enabled,
          installed: true,
          actions: enabled ? ["disable"] : ["enable"],
        }),
      );
    }

    for (const configured of this.packageManager.listConfiguredPackages()) {
      if (!configured.installedPath || !existsSync(configured.installedPath)) {
        issues.push({
          id: issueId(`missing:${configured.source}`),
          message: "已记录的 Skill 包尚未安装",
          path: redactSensitiveText(configured.source),
        });
        continue;
      }
      const parsed = loadSkillsFromDir({ dir: configured.installedPath, source: configured.source });
      issues.push(...parsed.diagnostics.map(issueFromDiagnostic));
      for (const skill of parsed.skills) {
        const path = canonicalPath(skill.filePath);
        const enabled = enabledPaths.has(path);
        items.set(
          path,
          catalogItem(skill, {
            source: "package",
            scope: configured.scope,
            enabled,
            installed: true,
            packageSource: configured.source,
            packagePattern: toPackagePattern(configured.installedPath, skill.filePath),
            actions: enabled ? ["disable", "update", "remove"] : ["enable", "update", "remove"],
          }),
        );
      }
    }

    for (const entry of external) {
      const path = canonicalPath(entry.skill.filePath);
      if (items.has(path)) continue;
      items.set(
        path,
        catalogItem(entry.skill, {
          source: entry.source,
          scope: "external",
          enabled: false,
          installed: false,
          actions: ["enable"],
        }),
      );
    }

    const names = new Map<string, SkillCatalogItem[]>();
    for (const item of items.values()) {
      const matches = names.get(item.name) ?? [];
      matches.push(item);
      names.set(item.name, matches);
    }
    for (const [name, matches] of names) {
      const enabled = matches.filter((item) => item.enabled);
      if (enabled.length < 2) continue;
      issues.push({
        id: issueId(`collision:${name}:${enabled.map((item) => item.filePath).join("\0")}`),
        message: `Skill 名称冲突：${name}`,
        path: enabled.map((item) => item.filePath).join(" | "),
      });
    }

    return {
      items: [...items.values()].sort(compareItems),
      issues: dedupeIssues(issues),
      projectTrusted: this.options.settingsManager.isProjectTrusted(),
    };
  }

  async install(source: string, scope: SkillScope, enable: boolean): Promise<SkillInstallResult> {
    const normalized = normalizeSkillInstallSource(source);
    this.assertScope(scope);
    const local = scope === "project";
    const settings =
      scope === "project"
        ? this.options.settingsManager.getProjectSettings()
        : this.options.settingsManager.getGlobalSettings();
    const previousPackages = [...(settings.packages ?? [])];
    const wasInstalled = this.packageManager.getInstalledPath(normalized, scope) !== undefined;
    await this.packageManager.install(normalized, { local });
    try {
      const installedPath = this.packageManager.getInstalledPath(normalized, scope);
      if (!installedPath || !existsSync(installedPath)) throw new Error("Skill 包安装后未找到受管目录");
      const parsed = loadSkillsFromDir({ dir: installedPath, source: normalized });
      if (parsed.skills.length === 0) throw new Error("该来源没有可用的 SKILL.md");
      const patterns = parsed.skills.map((skill) => toPackagePattern(installedPath, skill.filePath));
      await this.persistPackage(
        {
          source: normalized,
          autoload: false,
          extensions: [],
          prompts: [],
          themes: [],
          skills: enable ? patterns : [],
        },
        scope,
      );
      await this.options.resourceLoader.reload();
      return {
        source: normalized,
        scope,
        enabled: enable,
        skills: parsed.skills.map((skill) => skill.name),
      };
    } catch (error) {
      if (scope === "project") this.options.settingsManager.setProjectPackages(previousPackages);
      else this.options.settingsManager.setPackages(previousPackages);
      try {
        await this.options.settingsManager.flush();
      } catch {}
      if (!wasInstalled) {
        try {
          await this.packageManager.remove(normalized, { local });
        } catch {}
      }
      try {
        await this.options.resourceLoader.reload();
      } catch {}
      throw error;
    }
  }

  async setEnabled(id: string, enabled: boolean, scope: SkillScope = "user"): Promise<void> {
    const item = await this.findItem(id);
    if (enabled && !item.actions.includes("enable")) return;
    if (!enabled && !item.actions.includes("disable")) return;
    if (item.packageSource && item.packagePattern) {
      await this.setPackageSkillEnabled(item, enabled);
    } else if (item.source === "codex" || item.source === "claude") {
      await this.setRegisteredPath(item.filePath, enabled, scope);
    } else {
      await this.setAutoSkillEnabled(item.filePath, enabled, item.scope === "project" ? "project" : "user");
    }
    await this.options.resourceLoader.reload();
  }

  async update(id: string): Promise<void> {
    const item = await this.findItem(id);
    if (!item.packageSource || !item.actions.includes("update")) throw new Error("该 Skill 不由可更新的包提供");
    try {
      await this.packageManager.update(item.packageSource);
    } catch (error) {
      throw sanitizedError(error);
    }
    await this.options.resourceLoader.reload();
  }

  async remove(id: string): Promise<void> {
    const item = await this.findItem(id);
    if (item.packageSource) {
      try {
        await this.packageManager.removeAndPersist(item.packageSource, { local: item.scope === "project" });
      } catch (error) {
        throw sanitizedError(error);
      }
      await this.options.settingsManager.flush();
    } else if (item.source === "codex" || item.source === "claude") {
      await this.setRegisteredPath(item.filePath, false, item.scope === "project" ? "project" : "user");
    } else {
      throw new Error("本地自动发现的 Skill 只能停用，不能由 VSPi 删除源文件");
    }
    await this.options.resourceLoader.reload();
  }

  private externalSkills(issues: SkillCatalogIssue[]): ExternalSkill[] {
    const sources: Array<{ dir: string; source: "codex" | "claude" }> = [
      { dir: join(this.home, ".codex", "skills"), source: "codex" },
      { dir: join(this.home, ".claude", "skills"), source: "claude" },
    ];
    const output: ExternalSkill[] = [];
    for (const source of sources) {
      const result = loadSkillsFromDir({ dir: source.dir, source: source.source });
      output.push(...result.skills.map((skill) => ({ skill, source: source.source })));
      issues.push(...result.diagnostics.map(issueFromDiagnostic));
    }
    return output;
  }

  private async findItem(id: string): Promise<SkillCatalogItem> {
    const item = (await this.list()).items.find((entry) => entry.id === id);
    if (!item) throw new Error("Skill 不存在或目录已经变化");
    return item;
  }

  private assertScope(scope: SkillScope): void {
    if (scope === "project" && !this.options.settingsManager.isProjectTrusted()) {
      throw new Error("项目未授予 trust，不能写入 Project Skill");
    }
  }

  private async persistPackage(entry: Exclude<PackageSource, string>, scope: SkillScope): Promise<void> {
    const settings =
      scope === "project"
        ? this.options.settingsManager.getProjectSettings()
        : this.options.settingsManager.getGlobalSettings();
    const packages = [...(settings.packages ?? [])];
    const index = packages.findIndex((candidate) => packageSource(candidate) === entry.source);
    if (index >= 0) packages[index] = entry;
    else packages.push(entry);
    if (scope === "project") this.options.settingsManager.setProjectPackages(packages);
    else this.options.settingsManager.setPackages(packages);
    await this.options.settingsManager.flush();
  }

  private async setPackageSkillEnabled(item: SkillCatalogItem, enabled: boolean): Promise<void> {
    const scope = item.scope === "project" ? "project" : "user";
    const settings =
      scope === "project"
        ? this.options.settingsManager.getProjectSettings()
        : this.options.settingsManager.getGlobalSettings();
    const packages = [...(settings.packages ?? [])];
    const index = packages.findIndex((candidate) => packageSource(candidate) === item.packageSource);
    if (index < 0 || !item.packageSource || !item.packagePattern) throw new Error("Skill 包记录已经变化");
    const current = packages[index];
    const object =
      typeof current === "object"
        ? current
        : { source: current ?? item.packageSource, autoload: false, extensions: [], prompts: [], themes: [] };
    const skills = new Set(object.skills ?? []);
    if (enabled) skills.add(item.packagePattern);
    else skills.delete(item.packagePattern);
    packages[index] = {
      ...object,
      autoload: false,
      extensions: [],
      prompts: [],
      themes: [],
      skills: [...skills],
    };
    if (scope === "project") this.options.settingsManager.setProjectPackages(packages);
    else this.options.settingsManager.setPackages(packages);
    await this.options.settingsManager.flush();
  }

  private async setRegisteredPath(path: string, enabled: boolean, scope: SkillScope): Promise<void> {
    this.assertScope(scope);
    const current =
      scope === "project"
        ? (this.options.settingsManager.getProjectSettings().skills ?? [])
        : (this.options.settingsManager.getGlobalSettings().skills ?? []);
    const paths = current.filter((entry) => entry !== path);
    if (enabled) paths.push(path);
    if (scope === "project") this.options.settingsManager.setProjectSkillPaths(paths);
    else this.options.settingsManager.setSkillPaths(paths);
    await this.options.settingsManager.flush();
  }

  private async setAutoSkillEnabled(path: string, enabled: boolean, scope: SkillScope): Promise<void> {
    this.assertScope(scope);
    const current =
      scope === "project"
        ? (this.options.settingsManager.getProjectSettings().skills ?? [])
        : (this.options.settingsManager.getGlobalSettings().skills ?? []);
    const disabledPattern = `-${path}`;
    const paths = current.filter((entry) => entry !== disabledPattern);
    if (!enabled) paths.push(disabledPattern);
    if (scope === "project") this.options.settingsManager.setProjectSkillPaths(paths);
    else this.options.settingsManager.setSkillPaths(paths);
    await this.options.settingsManager.flush();
  }
}

function catalogItem(
  skill: Skill,
  options: {
    source: SkillSourceKind;
    scope: SkillScope | "external";
    enabled: boolean;
    installed: boolean;
    packageSource?: string;
    packagePattern?: string;
    actions: SkillCatalogItem["actions"];
  },
): SkillCatalogItem {
  const filePath = canonicalPath(skill.filePath);
  return {
    id: createHash("sha256").update(filePath).digest("hex").slice(0, 24),
    name: skill.name,
    description: skill.description,
    filePath,
    source: options.source,
    sourceLabel: sourceLabel(options.source),
    scope: options.scope,
    enabled: options.enabled,
    installed: options.installed,
    disableModelInvocation: skill.disableModelInvocation,
    ...(options.packageSource ? { packageSource: options.packageSource } : {}),
    ...(options.packageSource ? { packageDisplaySource: redactSensitiveText(options.packageSource) } : {}),
    ...(options.packagePattern ? { packagePattern: options.packagePattern } : {}),
    actions: [...options.actions],
  };
}

function sourceLabel(source: SkillSourceKind): string {
  if (source === "pi") return "Pi";
  if (source === "package") return "Package";
  if (source === "project") return "Project";
  return source === "codex" ? "Codex" : "Claude Code";
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function issueFromDiagnostic(diagnostic: ResourceDiagnostic): SkillCatalogIssue {
  return {
    id: issueId(`${diagnostic.type}:${diagnostic.message}:${diagnostic.path ?? ""}`),
    message: redactSensitiveText(diagnostic.message),
    ...(diagnostic.path ? { path: redactSensitiveText(diagnostic.path) } : {}),
  };
}

function issueId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function dedupeIssues(issues: SkillCatalogIssue[]): SkillCatalogIssue[] {
  return [...new Map(issues.map((issue) => [issue.id, issue])).values()];
}

function compareItems(left: SkillCatalogItem, right: SkillCatalogItem): number {
  return (
    Number(right.enabled) - Number(left.enabled) ||
    left.name.localeCompare(right.name) ||
    left.filePath.localeCompare(right.filePath)
  );
}

function toPackagePattern(root: string, path: string): string {
  const pattern = relative(canonicalPath(root), canonicalPath(path)).split("\\").join("/");
  if (!pattern || pattern.startsWith("../")) throw new Error("Skill 路径越出包目录");
  return pattern;
}

function packageSource(value: PackageSource | undefined): string | undefined {
  return typeof value === "string" ? value : value?.source;
}

export function normalizeSkillInstallSource(value: string): string {
  const source = value.trim();
  if (!source || source.length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(source)) throw new Error("Skill 来源格式无效");
  if (source.startsWith("npm:")) {
    if (!/^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9*^~<>=|. -]+)?$/iu.test(source)) {
      throw new Error("npm Skill 来源格式无效");
    }
    return source;
  }
  if (/^https?:\/\//iu.test(source)) {
    const url = new URL(source);
    if (url.username || url.password || url.search) throw new Error("Skill URL 不能包含凭据或查询参数");
    return source;
  }
  if (/^ssh:\/\//iu.test(source)) {
    const url = new URL(source);
    if (url.password || url.search) throw new Error("Skill URL 不能包含凭据或查询参数");
    return source;
  }
  if (/^(?:git@|git:\/\/)/iu.test(source)) return source;
  if (isAbsolute(source) && existsSync(source)) {
    throw new Error("本地 Skill 请从可导入列表登记，不作为受管包安装");
  }
  throw new Error("请输入 Git URL 或 npm:package");
}

function redactSensitiveText(value: string): string {
  return value.replace(/(?:https?|ssh):\/\/[^\s"'<>|]+/giu, (candidate) => {
    try {
      const url = new URL(candidate);
      const hasSensitiveUserInfo =
        url.protocol !== "ssh:" ? Boolean(url.username || url.password) : Boolean(url.password);
      const userInfo = hasSensitiveUserInfo ? "[redacted]@" : url.username ? `${url.username}@` : "";
      return `${url.protocol}//${userInfo}${url.host}${url.pathname}${url.hash}`;
    } catch {
      return "[redacted-url]";
    }
  });
}

function sanitizedError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(redactSensitiveText(String(error)));
  const safe = new Error(redactSensitiveText(error.message));
  safe.name = error.name;
  return safe;
}
