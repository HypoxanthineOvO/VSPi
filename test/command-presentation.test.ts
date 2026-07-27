import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, type CommandDefinition } from "../src/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { Composer } from "../src/ui/composer.js";
import { PanelController } from "../src/ui/panels.js";
import { cellsForText, plainTheme, type SgrCell, sgrCells } from "./helpers.js";

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, setProgress: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

interface EditorCursorAccess {
  state: { cursorCol: number };
}

function commandPanel(query: string, width: number, colorLevel: 0 | 2 | 3 = 0): string[] {
  const panel = new PanelController(DEFAULT_SETTINGS);
  panel.setCommandQuery(query);
  return panel.render(
    width,
    COMMANDS.length + 5,
    plainTheme({ colorLevel, truecolor: colorLevel === 3 }),
    DEFAULT_USAGE,
  );
}

const DOWN = "\u001b[B";
const RESPONSIVE_PLUGINS: CommandDefinition[] = [
  {
    id: "layout-question",
    aliases: [],
    label: "/layout-question",
    description: "Open Question component",
    group: "扩展",
    source: "@test/ui",
  },
  {
    id: "layout-tool",
    aliases: [],
    label: "/layout-tool",
    description: "Open Tool component",
    group: "扩展",
    source: "@test/ui",
  },
];

function withResponsivePlugins<T>(callback: () => T): T {
  const originalLength = COMMANDS.length;
  try {
    COMMANDS.push(...RESPONSIVE_PLUGINS);
    return callback();
  } finally {
    COMMANDS.splice(originalLength);
  }
}

function hasMatchModifiers(cell: SgrCell): boolean {
  return [1, 4, 7].every((code) => cell.modifiers.has(code));
}

function expectModifierRange(rendered: string, target: string, expected: boolean[], occurrence = 0): void {
  const cells = cellsForText(rendered, target, occurrence);
  expect(cells.map((cell) => cell.character).join(""), `missing visible target ${target}`).toBe(target);
  expect(cells.map(hasMatchModifiers), `modifier range for ${target}`).toEqual(expected);
}

function emphasizedText(rendered: string): string {
  return sgrCells(rendered)
    .filter(hasMatchModifiers)
    .map((cell) => cell.character)
    .join("");
}

function expectEverySlashPlain(rendered: string): void {
  const slashCells = sgrCells(rendered).filter((cell) => cell.character === "/");
  expect(slashCells.length).toBeGreaterThan(0);
  expect(slashCells.some(hasMatchModifiers), "slash must only trigger command mode").toBe(false);
}

function visibleColumn(line: string, target: string): number {
  const index = line.indexOf(target);
  return index < 0 ? -1 : visibleWidth(line.slice(0, index));
}

describe("command provenance and match emphasis", () => {
  it("shows alias provenance and canonical aliases", () => {
    const alias = commandPanel("/ex", 80).map(stripAnsi).join("\n");
    const canonical = commandPanel("/qui", 80)
      .map(stripAnsi)
      .find((line) => line.includes("/quit"));

    expect(alias).toContain("/exit  (/quit)");
    expect(canonical).toMatch(/\/quit.*\/exit.*\/q/);
  });

  it.each([0, 2, 3] as const)("keeps package source and slash-excluded plugin emphasis at color level %s", (level) => {
    const plugin: CommandDefinition = {
      id: "deploy",
      aliases: ["ship"],
      label: "/deploy",
      description: "Deploy fixture",
      group: "扩展",
      source: "@acme/deploy",
    };
    const originalLength = COMMANDS.length;
    try {
      COMMANDS.push(plugin);
      const ansi = commandPanel("/sh", 80, level);
      const rendered = ansi.map(stripAnsi).join("\n");
      expect(rendered).toContain("/ship  (/deploy)");
      expect(rendered).toContain("@acme/deploy");
      expectModifierRange(ansi.join("\n"), "/ship", [false, true, true, false, false]);
      expect(emphasizedText(ansi.join("\n"))).toBe("sh");
      expectEverySlashPlain(ansi.join("\n"));
    } finally {
      COMMANDS.splice(originalLength);
    }
  });

  it("does not execute either plugin when an exact alias is ambiguous in the command panel", () => {
    const plugins: CommandDefinition[] = [
      {
        id: "first-plugin",
        aliases: ["shared"],
        label: "/first-plugin",
        description: "First plugin fixture",
        group: "扩展",
        source: "@vspi/first-plugin",
      },
      {
        id: "second-plugin",
        aliases: ["shared"],
        label: "/second-plugin",
        description: "Second plugin fixture",
        group: "扩展",
        source: "@vspi/second-plugin",
      },
    ];
    const originalLength = COMMANDS.length;
    try {
      COMMANDS.push(...plugins);
      const panel = new PanelController(DEFAULT_SETTINGS);
      panel.setCommandQuery("/shared");
      const event = panel.handleInput("\r");

      expect(event === undefined || (event.type === "notice" && /歧义|冲突|多个/.test(event.text))).toBe(true);
    } finally {
      COMMANDS.splice(originalLength);
    }
  });

  it.each([0, 2, 3] as const)("excludes slash and unmatched suffix from panel emphasis at color level %s", (level) => {
    const alias = commandPanel("/ex", 80, level).join("\n");
    const canonical = commandPanel("/qui", 80, level).join("\n");
    expectModifierRange(alias, "/exit", [false, true, true, false, false]);
    expectModifierRange(canonical, "/quit", [false, true, true, true, false]);
    expect(emphasizedText(alias)).toBe("ex");
    expect(emphasizedText(canonical)).toBe("qui");
    expectEverySlashPlain(alias);
    expectEverySlashPlain(canonical);
  });

  it.each([0, 2, 3] as const)(
    "opens the complete command directory for slash alone without a match modifier at color level %s",
    (level) => {
      const rendered = commandPanel("/", 80, level).join("\n");
      const plain = stripAnsi(rendered);

      for (const command of COMMANDS) expect(plain).toContain(command.label);
      expect(sgrCells(rendered).some(hasMatchModifiers)).toBe(false);
      expectEverySlashPlain(rendered);
    },
  );

  it.each([
    ["/quit", "/quit", [false, true, true, true, true], "quit"],
    ["/exit", "/exit", [false, true, true, true, true], "exit"],
    ["/EX", "/exit", [false, true, true, false, false], "ex"],
  ] as const)(
    "keeps exact and mixed-case query %s scoped to the visible matched suffix",
    (query, token, range, text) => {
      const rendered = commandPanel(query, 80, 3).join("\n");

      expectModifierRange(rendered, token, [...range]);
      expect(emphasizedText(rendered)).toBe(text);
      expectEverySlashPlain(rendered);
      if (query.toLowerCase() === "/exit") expect(stripAnsi(rendered)).toContain("/exit  (/quit)");
    },
  );

  it.each([0, 2, 3] as const)(
    "keeps only the composer command suffix emphasized with a middle cursor at color level %s",
    (level) => {
      const composer = new Composer(fakeTui(), plainTheme({ colorLevel: level, truecolor: level === 3 }));
      composer.focused = true;
      composer.setText("/exit ordinary");
      (composer.editor as unknown as EditorCursorAccess).state.cursorCol = 2;
      const middleCursor = composer.render(80).join("\n");
      expectModifierRange(middleCursor, "/exit", [false, true, true, true, true]);
      expect(cellsForText(middleCursor, "ordinary").some(hasMatchModifiers)).toBe(false);
      expect(emphasizedText(middleCursor)).toBe("exit");
      expectEverySlashPlain(middleCursor);

      composer.setText("/exit");
      const tokenEnd = composer.render(80).join("\n");
      expectModifierRange(tokenEnd, "/exit", [false, true, true, true, true]);

      composer.setText("/");
      const slashOnly = composer.render(80).join("\n");
      expect(sgrCells(slashOnly).some(hasMatchModifiers)).toBe(false);
      expectEverySlashPlain(slashOnly);

      composer.setText("普通文本");
      expect(cellsForText(composer.render(80).join("\n"), "普通文本").some(hasMatchModifiers)).toBe(false);
    },
  );
});

describe("responsive command columns", () => {
  it.each([80, 120] as const)("aligns identity, description and source columns at %s columns", (width) => {
    withResponsivePlugins(() => {
      const lines = commandPanel("/layout", width);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      const plain = lines.map(stripAnsi);
      const question = plain.find((line) => line.includes("/layout-question")) ?? "";
      const tool = plain.find((line) => line.includes("/layout-tool")) ?? "";
      const questionDescription = visibleColumn(question, "Open Question component");
      const toolDescription = visibleColumn(tool, "Open Tool component");
      const questionSource = visibleColumn(question, "@test/ui");
      const toolSource = visibleColumn(tool, "@test/ui");

      expect(plain.join("\n")).not.toContain("\u3000");
      expect(questionDescription).toBeGreaterThan(-1);
      expect(toolDescription).toBe(questionDescription);
      expect(questionSource).toBeGreaterThan(questionDescription);
      expect(toolSource).toBe(questionSource);
    });
  });

  it("moves the source column outward as the viewport grows", () => {
    withResponsivePlugins(() => {
      const sourceAt = (width: number) =>
        visibleColumn(
          commandPanel("/layout", width)
            .map(stripAnsi)
            .find((line) => line.includes("/layout-question")) ?? "",
          "@test/ui",
        );

      expect(sourceAt(80)).toBeGreaterThan(-1);
      expect(sourceAt(120)).toBeGreaterThan(sourceAt(80));
    });
  });

  it("uses a non-overlapping two-line command row at 40 columns", () => {
    withResponsivePlugins(() => {
      const lines = commandPanel("/layout-q", 40);
      expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
      const plain = lines.map(stripAnsi);
      const identityLine = plain.findIndex((line) => line.includes("/layout-question"));
      const detailLine = plain.findIndex((line) => line.includes("@test/ui"));

      expect(identityLine).toBeGreaterThan(-1);
      expect(detailLine).toBe(identityLine + 1);
      expect(plain[identityLine]).not.toContain("Open Question component");
      expect(plain[detailLine]).toContain("Open Question component");
    });
  });

  it("keeps the selected two-line command row together while scrolling at 40 columns", () => {
    withResponsivePlugins(() => {
      const panel = new PanelController(DEFAULT_SETTINGS);
      panel.setCommandQuery("/");
      for (let index = 1; index < COMMANDS.length; index += 1) panel.handleInput(DOWN);

      const lines = panel.render(40, 9, plainTheme(), DEFAULT_USAGE);
      const plain = lines.map(stripAnsi);
      const identityLine = plain.findIndex((line) => line.includes("/layout-tool"));

      expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
      expect(identityLine).toBeGreaterThan(-1);
      expect(plain[identityLine + 1]).toContain("@test/ui");
      expect(plain[identityLine + 1]).toContain("Open Tool component");
    });
  });
});
