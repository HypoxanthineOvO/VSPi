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

  it("keeps a three-screen transcript budget plus stable bottom chrome for a long busy transcript", async () => {
    const tui = fakeTui(24);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/project",
      settings: DEFAULT_SETTINGS,
      attachments: fakeAttachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();
    const testable = app as unknown as {
      messages: import("../src/domain/types.js").TranscriptMessage[];
      panels: { setPlanSnapshot(plan: unknown): void };
    };
    for (let index = 0; index < 40; index += 1) {
      testable.messages.push(
        { id: `user-${index}`, role: "user", kind: "text", text: `问题 ${index} ${"长文本".repeat(20)}` },
        {
          id: `thinking-${index}`,
          role: "assistant",
          kind: "thinking",
          effort: "medium",
          text: `思考 ${index} ${"推理过程".repeat(30)}`,
          collapsed: true,
        },
        {
          id: `tool-${index}`,
          role: "assistant",
          kind: "tool",
          groupId: `group-${Math.floor(index / 3)}`,
          name: "bash",
          summary: `命令 ${index}`,
          status: "success",
          output: `输出 ${index} ${"结果".repeat(40)}`,
          expanded: false,
        },
        { id: `assistant-${index}`, role: "assistant", kind: "text", text: `回答 ${index} ${"内容".repeat(25)}` },
      );
    }
    testable.panels.setPlanSnapshot({
      id: "plan-1",
      revision: 1,
      semanticHash: "a".repeat(64),
      archived: false,
      title: "长期计划",
      goal: "验证布局",
      challenges: [],
      items: [{ id: "work", title: "工作项", status: "pending" }],
      blockers: [],
    });

    const frame = app.render(80);
    expect(frame.length).toBeLessThanOrEqual(24 * 3 + 16);
    expect(frame.every((line) => visibleWidth(line) <= 80)).toBe(true);
    await app.dispose();
  });

  it("replaces the main Composer with Question and keeps one gutter before Status", async () => {
    for (const width of [40, 80, 120]) {
      const app = new VspiApp(fakeTui(24), plainTheme({ unicode: width >= 80 }), new FixtureBackend(), {
        cwd: "/workspace/question-gutter",
        settings: DEFAULT_SETTINGS,
        attachments: fakeAttachments(),
        renderOnce: true,
        onExit: vi.fn(),
      });
      await app.start();
      app.focused = true;
      app.composer.setText("draft survives Question");
      const testable = app as unknown as { panels: PanelController };
      testable.panels.openQuestions([
        {
          id: "spacing",
          title: "Spacing",
          prompt: "Choose one",
          kind: "singleChoice",
          options: [{ id: "yes", label: "Yes" }],
        },
      ]);

      const frame = app.render(width).map(stripAnsi);
      const questionStart = frame.findIndex((line) => line.includes("Question"));
      const questionBottom = frame.findIndex((line, index) => index > questionStart && /^[╰+]/u.test(line));
      expect(questionStart).toBeGreaterThanOrEqual(0);
      expect(questionBottom).toBeGreaterThan(questionStart);
      expect(frame[questionBottom + 1]?.trim()).toBe("");
      expect(frame.slice(questionStart, questionBottom + 2).join("\n")).not.toContain("draft survives Question");
      expect(frame.slice(questionStart, questionBottom + 2).join("\n")).not.toContain("输入消息");
      expect(app.composer.focused).toBe(false);

      testable.panels.handleInput("\u001b");
      const restored = app.render(width).map(stripAnsi).join("\n");
      expect(restored).toContain("draft survives Question");
      expect(app.composer.focused).toBe(true);
      await app.dispose();
    }
  });

  it("keeps Question, Composer, and Status coordinates fixed while a notice is visible", async () => {
    const app = new VspiApp(fakeTui(40), plainTheme({ unicode: true }), new FixtureBackend(), {
      cwd: "/workspace/question-notice",
      settings: DEFAULT_SETTINGS,
      attachments: fakeAttachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();
    const testable = app as unknown as {
      panels: PanelController;
      showNotice(text: string, tone: "warning"): void;
    };
    testable.panels.openQuestions([
      {
        id: "notice-spacing",
        title: "Notice spacing",
        prompt: "Keep the geometry stable",
        kind: "singleChoice",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    ]);
    const before = app.render(80).map(stripAnsi);
    testable.showNotice("首选模型额度不足，已使用 fallback", "warning");
    const after = app.render(80).map(stripAnsi);
    const coordinates = (frame: string[]) => ({
      question: frame.findIndex((line) => line.includes("Question 1 / 1")),
      questionBottom: frame.findIndex((line, index) => (index > 0 && line.startsWith("╰")) || line.startsWith("+")),
      statusLast: frame.length - 1,
    });

    expect(after).toHaveLength(before.length);
    expect(coordinates(after)).toEqual(coordinates(before));
    expect(after.join("\n")).toContain("! 警告 · 首选模型额度不足，已使用 fallback");
    expect(after.join("\n")).not.toContain("输入消息");
    expect(after.at(-1)).toContain("Offline Fixture");
    expect(after.at(-1)).toContain("/workspace/question-notice");
    await app.dispose();
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
      const labels =
        width >= 80
          ? ["Model", "Effort", "Speed", "Context", "Token", "Cost"]
          : ["Model", "Effort", "Speed", "Token", "Cost"];
      for (const label of labels) {
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
