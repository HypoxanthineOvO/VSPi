import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import { getActionDefinition } from "../src/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { TOOL_CAPABILITIES } from "../src/tools/capability-catalog.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

function productionToolAllowlist(source: string): string[] {
  const file = ts.createSourceFile("pi-runtime-backend.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let allowlist: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createAgentSessionFromServices"
    ) {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) &&
            ((ts.isIdentifier(candidate.name) && candidate.name.text === "tools") ||
              (ts.isStringLiteral(candidate.name) && candidate.name.text === "tools")),
        );
        if (property && ts.isArrayLiteralExpression(property.initializer)) {
          allowlist = property.initializer.elements
            .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
            .map((element) => element.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!allowlist) throw new Error("Production Pi tool allowlist was not found");
  return allowlist;
}

function fakeTui(): TUI {
  return {
    terminal: { columns: 80, rows: 24, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

describe("C2 M4 extension capability boundaries", () => {
  it("publishes the exact honest capability catalog", () => {
    expect(TOOL_CAPABILITIES).toEqual([
      {
        id: "files",
        label: "Files & Search",
        status: "native",
        route: "Pi read / ls / find / grep / edit / write",
        boundary: "VSPi approval before native execute",
      },
      {
        id: "git",
        label: "Git",
        status: "native",
        route: "Pi Bash",
        boundary: "git-write approval category",
      },
      {
        id: "ssh",
        label: "SSH",
        status: "native",
        route: "Pi Bash",
        boundary: "ssh approval category",
      },
      {
        id: "images",
        label: "Images",
        status: "available",
        route: "Pi read image content + VSPi attachments",
        boundary: "verified file handle and attachment session",
      },
      {
        id: "skills",
        label: "Skills",
        status: "available",
        route: "Pi ResourceLoader + skill_list / skill_manage",
        boundary: "Question confirmation before every mutation",
      },
      {
        id: "browser",
        label: "Browser",
        status: "not-connected",
        route: "No model tool registered",
        boundary: "future isolated Provider",
      },
      {
        id: "mcp",
        label: "MCP",
        status: "not-connected",
        route: "No server registry connected",
        boundary: "future server-scoped adapter",
      },
      {
        id: "pty",
        label: "Persistent PTY",
        status: "deferred",
        route: "One-shot Pi Bash only",
        boundary: "persistent process ownership deferred",
      },
    ]);
  });

  it("keeps browser and MCP out of the model tool registry", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/backend/pi-runtime-backend.ts", import.meta.url)),
      "utf8",
    );
    const tools = productionToolAllowlist(source);

    expect(tools).toEqual([
      "read",
      "ls",
      "find",
      "grep",
      "bash",
      "edit",
      "write",
      "question",
      "skill_list",
      "skill_manage",
    ]);
    expect(tools).not.toEqual(expect.arrayContaining(["browser", "mcp", "pty", "ssh", "git"]));
  });

  it("renders a keyboard-operable Tools panel at 40, 80 and 120 columns", () => {
    for (const width of [40, 80, 120]) {
      const panel = new PanelController(DEFAULT_SETTINGS);
      panel.open("tools");

      expect(panel.acceptsInput("\u001b[B")).toBe(true);
      expect(panel.acceptsInput("\u001b")).toBe(true);
      panel.handleInput("\u001b[B");
      const lines = panel.render(width, 24, plainTheme(), DEFAULT_USAGE);
      const rendered = lines.map(stripAnsi).join("\n");

      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(rendered).toContain("Tools");
      expect(rendered).toContain("Git");
      expect(rendered).toContain("Browser");
      expect(rendered).toContain("Not connected");
      expect(panel.handleInput("\u001b")).toEqual({ type: "close" });
      expect(panel.kind).toBe("plan");
    }
  });

  it("keeps each selected capability title and boundary together while paging", () => {
    for (const width of [40, 80, 120]) {
      const panel = new PanelController(DEFAULT_SETTINGS);
      panel.open("tools");
      for (let index = 0; index < TOOL_CAPABILITIES.length - 1; index += 1) panel.handleInput("\u001b[B");

      const rendered = panel.render(width, 8, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
      expect(rendered).toContain("Persistent PTY");
      expect(rendered).toContain("One-shot Pi Bash only");
    }
  });

  it("executes /tools locally without sending a model prompt", async () => {
    const action = getActionDefinition("tools");
    expect(action).toMatchObject({ availability: "enabled", handler: "tools" });

    const backend = new FixtureBackend();
    const send = vi.spyOn(backend, "send");
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/c2-m4-tools",
      settings: { ...DEFAULT_SETTINGS },
      attachments: fakeAttachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();
    try {
      app.composer.setText("/tools");
      app.handleInput("\r");
      await new Promise((resolve) => setImmediate(resolve));
      const rendered = app.render(80).map(stripAnsi).join("\n");

      expect(rendered).toContain("Tools");
      expect(rendered).toContain("Files & Search");
      expect(rendered).toContain("Git");
      expect(send).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });
});
