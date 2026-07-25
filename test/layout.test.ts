import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { Question } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController, type PanelKind } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

function fakeTui(rows: number): TUI {
  return {
    terminal: { rows, setProgress: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

describe("responsive layout", () => {
  it("keeps every panel within 40, 80 and 120 columns", () => {
    const kinds: PanelKind[] = [
      "plan",
      "commands",
      "models",
      "providers",
      "sessions",
      "settings",
      "usage",
      "theme",
      "question",
      "tools",
    ];
    for (const width of [40, 80, 120]) {
      for (const kind of kinds) {
        const panel = new PanelController(DEFAULT_SETTINGS);
        if (kind === "commands") panel.setCommandQuery("/");
        else if (kind === "question") {
          const question: Question = {
            id: "layout",
            title: "Layout",
            prompt: "Choose one",
            kind: "singleChoice",
            options: [{ id: "bounded", label: "Bounded" }],
          };
          panel.openQuestions([question]);
        } else panel.open(kind);
        const lines = panel.render(width, width === 40 ? 9 : 16, plainTheme(), DEFAULT_USAGE);
        expect(
          lines.every((line) => visibleWidth(line) === width),
          `${kind} at ${width}`,
        ).toBe(true);
      }
    }
  });

  it("renders the complete bottom stack inside width budgets at 80x24 and narrow fallback", async () => {
    for (const width of [40, 80]) {
      const tui = fakeTui(24);
      const theme = plainTheme({ unicode: width >= 80 });
      const app = new VspiApp(tui, theme, new FixtureBackend(), {
        cwd: "/workspace/project-with-a-long-name",
        settings: DEFAULT_SETTINGS,
        attachments: fakeAttachments(),
        renderOnce: true,
        onExit: vi.fn(),
      });
      await app.start();
      const initial = app.render(width);
      expect(initial.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(initial.length).toBeLessThanOrEqual(24);
      const statusLines = initial
        .map(stripAnsi)
        .filter((line) => /^Model\s/.test(line) || line.startsWith("/workspace/"));
      const status = statusLines.join("\n");
      expect(statusLines).toHaveLength(2);
      for (const label of ["Model", "Effort", "Context", "Token", "Cost"]) {
        expect(status).toContain(label);
      }
      expect(status).not.toMatch(/\bPath\b/);

      app.composer.setText("/usage");
      app.handleInput("\r");
      await new Promise((resolve) => setImmediate(resolve));
      const usage = app.render(width);
      expect(usage.every((line) => visibleWidth(line) <= width)).toBe(true);
      await app.dispose();
    }
  });
});
