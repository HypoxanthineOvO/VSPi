export type SkillScope = "user" | "project";
export type SkillCatalogTab = "enabled" | "available" | "issues";
export type SkillSourceKind = "pi" | "package" | "project" | "codex" | "claude";

export interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: SkillSourceKind;
  sourceLabel: string;
  scope: SkillScope | "external";
  enabled: boolean;
  installed: boolean;
  disableModelInvocation: boolean;
  packageSource?: string;
  packageDisplaySource?: string;
  packagePattern?: string;
  actions: Array<"enable" | "disable" | "update" | "remove">;
}

export interface SkillCatalogIssue {
  id: string;
  message: string;
  path?: string;
}

export interface SkillCatalogSnapshot {
  items: SkillCatalogItem[];
  issues: SkillCatalogIssue[];
  projectTrusted: boolean;
}

export interface SkillInstallResult {
  source: string;
  scope: SkillScope;
  enabled: boolean;
  skills: string[];
}

export interface SkillManager {
  list(): Promise<SkillCatalogSnapshot>;
  install(source: string, scope: SkillScope, enable: boolean): Promise<SkillInstallResult>;
  setEnabled(id: string, enabled: boolean, scope?: SkillScope): Promise<void>;
  update(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
