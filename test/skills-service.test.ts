import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir, type ResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiSkillManager } from "../src/skills/service.js";

describe("Pi Skill manager", () => {
  it("merges active Pi Skills with importable Codex/Claude inventories and registers external paths in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-skills-catalog-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, ".pi", "agent");
    const piDir = join(agentDir, "skills", "pi-review");
    const codexDir = join(root, ".codex", "skills", "codex-review");
    const claudeDir = join(root, ".claude", "skills", "claude-review");
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(piDir, { recursive: true }),
      mkdir(codexDir, { recursive: true }),
      mkdir(claudeDir, { recursive: true }),
    ]);
    await Promise.all([
      skillFile(piDir, "pi-review", "Active Pi review"),
      skillFile(codexDir, "codex-review", "Importable Codex review"),
      skillFile(claudeDir, "claude-review", "Importable Claude review"),
    ]);
    const active = loadSkillsFromDir({ dir: piDir, source: "user" }).skills;
    const reload = vi.fn(async () => {});
    const resourceLoader = loader(active, reload);
    const settings = SettingsManager.inMemory();
    const packageManager = packageStub({
      resolve: vi.fn(async () => ({
        extensions: [],
        prompts: [],
        themes: [],
        skills: [
          {
            path: join(piDir, "SKILL.md"),
            enabled: true,
            metadata: { source: "auto", scope: "user", origin: "top-level" as const },
          },
        ],
      })),
    });
    const manager = new PiSkillManager({
      cwd,
      agentDir,
      home: root,
      settingsManager: settings,
      resourceLoader,
      packageManager,
    });

    const snapshot = await manager.list();
    expect(snapshot.items.map((item) => [item.name, item.enabled, item.source])).toEqual([
      ["pi-review", true, "pi"],
      ["claude-review", false, "claude"],
      ["codex-review", false, "codex"],
    ]);
    const codex = snapshot.items.find((item) => item.name === "codex-review");
    expect(codex).toBeDefined();
    await manager.setEnabled(codex?.id ?? "", true, "user");
    expect(settings.getGlobalSettings().skills).toEqual([join(codexDir, "SKILL.md")]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("persists managed packages with every non-Skill resource disabled and supports install-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-skills-install-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, ".pi", "agent");
    const installed = join(agentDir, "git", "github.com", "example", "skills");
    const skillDir = join(installed, "skills", "ci-review");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(skillDir, { recursive: true })]);
    await skillFile(skillDir, "ci-review", "Review CI failures");
    const settings = SettingsManager.inMemory();
    const reload = vi.fn(async () => {});
    const packageManager = packageStub({
      install: vi.fn(async () => {}),
      getInstalledPath: vi.fn(() => installed),
    });
    const manager = new PiSkillManager({
      cwd,
      agentDir,
      home: root,
      settingsManager: settings,
      resourceLoader: loader([], reload),
      packageManager,
    });
    const source = "https://github.com/example/skills.git";

    const result = await manager.install(source, "user", false);

    expect(result).toMatchObject({ source, enabled: false, skills: ["ci-review"] });
    expect(settings.getPackages()).toEqual([
      {
        source,
        autoload: false,
        extensions: [],
        prompts: [],
        themes: [],
        skills: [],
      },
    ]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("enables only discovered SKILL.md paths when installation is approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-skills-enable-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, ".pi", "agent");
    const installed = join(agentDir, "git", "gitlab.example", "team", "skills");
    const first = join(installed, "skills", "first");
    const second = join(installed, "skills", "second");
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(first, { recursive: true }),
      mkdir(second, { recursive: true }),
    ]);
    await Promise.all([skillFile(first, "first", "First Skill"), skillFile(second, "second", "Second Skill")]);
    const settings = SettingsManager.inMemory();
    const manager = new PiSkillManager({
      cwd,
      agentDir,
      home: root,
      settingsManager: settings,
      resourceLoader: loader(
        [],
        vi.fn(async () => {}),
      ),
      packageManager: packageStub({ getInstalledPath: vi.fn(() => installed) }),
    });

    await manager.install("https://gitlab.example/team/skills.git", "user", true);

    expect(settings.getPackages()).toEqual([
      expect.objectContaining({
        autoload: false,
        extensions: [],
        prompts: [],
        themes: [],
        skills: ["skills/first/SKILL.md", "skills/second/SKILL.md"],
      }),
    ]);
  });

  it("rolls back a newly installed package when settings persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-skills-rollback-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, ".pi", "agent");
    const installed = join(agentDir, "git", "github.com", "example", "rollback-skill");
    const skillDir = join(installed, "skills", "rollback-skill");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(skillDir, { recursive: true })]);
    await skillFile(skillDir, "rollback-skill", "Rollback fixture");
    const settings = SettingsManager.inMemory();
    vi.spyOn(settings, "flush").mockRejectedValueOnce(new Error("settings unavailable"));
    const remove = vi.fn(async () => {});
    const getInstalledPath = vi.fn().mockReturnValueOnce(undefined).mockReturnValue(installed);
    const manager = new PiSkillManager({
      cwd,
      agentDir,
      home: root,
      settingsManager: settings,
      resourceLoader: loader(
        [],
        vi.fn(async () => {}),
      ),
      packageManager: packageStub({ getInstalledPath, remove }),
    });

    await expect(manager.install("https://github.com/example/rollback-skill.git", "user", true)).rejects.toThrow(
      "settings unavailable",
    );

    expect(settings.getPackages()).toEqual([]);
    expect(remove).toHaveBeenCalledWith("https://github.com/example/rollback-skill.git", { local: false });
  });

  it("never removes a pre-existing package when it contains no Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-skills-existing-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, ".pi", "agent");
    const installed = join(agentDir, "git", "github.com", "example", "extensions-only");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(installed, { recursive: true })]);
    const source = "https://github.com/example/extensions-only.git";
    const settings = SettingsManager.inMemory({ packages: [source] });
    const remove = vi.fn(async () => {});
    const manager = new PiSkillManager({
      cwd,
      agentDir,
      home: root,
      settingsManager: settings,
      resourceLoader: loader(
        [],
        vi.fn(async () => {}),
      ),
      packageManager: packageStub({ getInstalledPath: vi.fn(() => installed), remove }),
    });

    await expect(manager.install(source, "user", true)).rejects.toThrow("没有可用的 SKILL.md");

    expect(settings.getPackages()).toEqual([source]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("redacts credentials from managed package display and operation errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-skills-redaction-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, ".pi", "agent");
    const installed = join(agentDir, "git", "example.com", "private", "skills");
    const skillDir = join(installed, "skills", "private-review");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(skillDir, { recursive: true })]);
    await skillFile(skillDir, "private-review", "Private review Skill");
    const source = "https://user:secret@example.com/private/skills.git?token=hidden";
    const packageManager = packageStub({
      listConfiguredPackages: vi.fn(() => [
        { source, scope: "user" as const, filtered: true, installedPath: installed },
      ]),
      update: vi.fn(async () => {
        throw new Error(`update failed for ${source}`);
      }),
    });
    const manager = new PiSkillManager({
      cwd,
      agentDir,
      home: root,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: loader(
        [],
        vi.fn(async () => {}),
      ),
      packageManager,
    });

    const item = (await manager.list()).items[0];
    expect(item?.packageDisplaySource).toBe("https://[redacted]@example.com/private/skills.git");
    await expect(manager.update(item?.id ?? "")).rejects.toThrow(
      "update failed for https://[redacted]@example.com/private/skills.git",
    );
  });
});

async function skillFile(directory: string, name: string, description: string): Promise<void> {
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

function loader(skills: ReturnType<typeof loadSkillsFromDir>["skills"], reload: () => Promise<void>): ResourceLoader {
  return {
    getSkills: () => ({ skills, diagnostics: [] }),
    reload,
  } as unknown as ResourceLoader;
}

function packageStub(overrides: Record<string, unknown> = {}) {
  return {
    resolve: vi.fn(async () => ({ extensions: [], skills: [], prompts: [], themes: [] })),
    listConfiguredPackages: vi.fn(() => []),
    install: vi.fn(async () => {}),
    getInstalledPath: vi.fn(() => undefined),
    remove: vi.fn(async () => {}),
    removeAndPersist: vi.fn(async () => true),
    update: vi.fn(async () => {}),
    ...overrides,
  };
}
