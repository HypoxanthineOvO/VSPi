import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { SkillCatalogSnapshot } from "../src/skills/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

describe("Skills panel", () => {
  it("renders the approved list/detail hierarchy at 40, 80 and 120 columns", () => {
    for (const width of [40, 80, 120]) {
      const panel = new PanelController(DEFAULT_SETTINGS);
      panel.setSkillCatalog(snapshot());
      panel.open("skills");
      const lines = panel.render(width, 14, plainTheme(), DEFAULT_USAGE);
      const text = lines.map(stripAnsi).join("\n");
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(text).toContain("Skills");
      expect(text).toContain("已启用  1");
      expect(text).toContain("ci-review");
      expect(panel.renderHint(width, plainTheme())).toContain("+ 添加");
    }
  });

  it("switches to importable Skills and returns a toggle event", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setSkillCatalog(snapshot());
    panel.open("skills");
    panel.handleInput("\t");
    const rendered = panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(rendered).toContain("web-search");
    expect(rendered).toContain("Codex");
    expect(rendered).not.toContain("Codex ⋅ Codex");
    expect(panel.handleInput(" ")).toMatchObject({
      type: "skillToggle",
      skill: { id: "external" },
      enabled: true,
    });
  });

  it("supports URL input, Agent search, scope selection and layered Escape", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setSkillCatalog({ ...snapshot(), projectTrusted: true });
    panel.open("skills");
    panel.handleInput("+");
    for (const width of [40, 80, 100, 120]) {
      const lines = panel.render(width, 14, plainTheme(), DEFAULT_USAGE);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    }
    panel.handleInput("https://github.com/example/skills.git");
    panel.handleInput("\u001b[C");
    expect(panel.handleInput("\r")).toEqual({
      type: "skillInstall",
      source: "https://github.com/example/skills.git",
      scope: "project",
    });
    expect(panel.handleInput("\u001b")).toBeUndefined();
    expect(panel.kind).toBe("skills");
    expect(panel.handleInput("\u001b")).toEqual({ type: "close" });
    expect(panel.kind).toBe("plan");
  });

  it("opens a real detail view on narrow terminals and returns to the list with Escape", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setSkillCatalog(snapshot());
    panel.open("skills");
    panel.handleInput("\t");
    panel.render(40, 14, plainTheme(), DEFAULT_USAGE);

    expect(panel.handleInput("\r")).toBeUndefined();
    const detail = panel.render(40, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(detail).toContain("web-search");
    expect(detail).toContain("/skill:web-search");
    expect(panel.renderHint(40, plainTheme())).toContain("Esc 返回");

    expect(panel.handleInput("\u001b")).toBeUndefined();
    expect(panel.render(40, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n")).toContain("Codex");
  });
});

function snapshot(): SkillCatalogSnapshot {
  return {
    projectTrusted: false,
    issues: [{ id: "issue", message: "Skill name collision", path: "/skills/duplicate" }],
    items: [
      {
        id: "active",
        name: "ci-review",
        description: "Review CI failures",
        filePath: "/skills/ci-review/SKILL.md",
        source: "package",
        sourceLabel: "Package",
        scope: "user",
        enabled: true,
        installed: true,
        disableModelInvocation: false,
        packageSource: "https://github.com/example/skills.git",
        packagePattern: "skills/ci-review/SKILL.md",
        actions: ["disable", "update", "remove"],
      },
      {
        id: "external",
        name: "web-search",
        description: "Search the web",
        filePath: "/home/user/.codex/skills/web-search/SKILL.md",
        source: "codex",
        sourceLabel: "Codex",
        scope: "external",
        enabled: false,
        installed: false,
        disableModelInvocation: false,
        actions: ["enable"],
      },
    ],
  };
}
