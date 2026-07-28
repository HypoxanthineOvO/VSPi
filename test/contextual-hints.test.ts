import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE, MODEL_GROUPS, MODELS, PROVIDERS } from "../src/domain/fixtures.js";
import type { Question } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderInteractionHint } from "../src/ui/interactions.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

const COMMAND_HINT = "↑↓ 选择  Tab 补全  Enter 执行  Esc 关闭";

const QUESTION: Question = {
  id: "density",
  title: "Density",
  prompt: "Choose a density",
  kind: "singleChoice",
  options: [{ id: "compact", label: "Compact" }],
};

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, setProgress: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function backendWithInspectableMessage(): ChatBackend {
  return {
    kind: "fixture",
    modelLabel: "Transcript Fixture",
    modelId: "inspect-fixture",
    supportsVision: false,
    start: vi.fn(async (events: ChatBackendEvents) => {
      events.onMessage({
        id: "inspect-thinking",
        role: "assistant",
        kind: "thinking",
        effort: "high",
        text: "可展开的思考内容",
        collapsed: true,
      });
    }),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function firstSgr(value: string): string {
  const start = value.indexOf("\u001b[");
  const end = value.indexOf("m", start);
  return start >= 0 && end > start ? value.slice(start, end + 1) : "";
}

async function renderPanel(
  command: string | undefined,
  backend: ChatBackend = new FixtureBackend(),
): Promise<{
  app: VspiApp;
  ansi: string[];
  plain: string[];
  mutedSgr: string;
}> {
  const theme = plainTheme({ colorLevel: 3, truecolor: true });
  const app = new VspiApp(fakeTui(), theme, backend, {
    cwd: "/workspace/contextual-hints",
    settings: DEFAULT_SETTINGS,
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  if (command) {
    app.composer.setText(command);
    if (command !== "/") app.handleInput("\r");
    await flush();
    if (command === "/settings") {
      await vi.waitFor(() => expect((app as unknown as { panels: PanelController }).panels.kind).toBe("settings"));
    }
  }
  const ansi = app.render(80);
  return {
    app,
    ansi,
    plain: ansi.map(stripAnsi),
    mutedSgr: firstSgr(theme.muted("x")),
  };
}

function contextualRow(plain: string[]): { frameBottom: number; hint: string; composerTop: string } {
  const composerTopIndex = plain.findLastIndex((line) => line.startsWith("╭"));
  const frameBottom = composerTopIndex - 2;
  return {
    frameBottom,
    hint: plain[composerTopIndex - 1]?.trim() ?? "",
    composerTop: plain[composerTopIndex] ?? "",
  };
}

describe("contextual panel hints", () => {
  it.each([
    ["commands", "/", COMMAND_HINT],
    ["models", "/model", "Enter"],
    ["providers", "/providers", "Enter"],
    ["settings", "/settings", "Tab"],
    ["usage", "/usage", "Esc"],
    ["theme", "/theme", "Enter"],
  ] as const)("places a muted %s hint between the frame and composer", async (_kind, command, expected) => {
    const result = await renderPanel(command);
    try {
      const row = contextualRow(result.plain);
      expect(row.frameBottom).toBeGreaterThan(-1);
      if (expected === COMMAND_HINT) expect(row.hint).toBe(COMMAND_HINT);
      else expect(row.hint).toContain(expected);
      expect(row.composerTop).toMatch(/^╭/);
      expect(result.mutedSgr).not.toBe("");
      expect(result.ansi[row.frameBottom + 1]).toContain(result.mutedSgr);
      expect(result.ansi.every((line) => visibleWidth(line) === 80)).toBe(true);
      expect(result.ansi.length).toBeLessThanOrEqual(24);
    } finally {
      await result.app.dispose();
    }
  });

  it("lets Sessions own a content-adaptive surface and keeps its hint in the bottom border", async () => {
    const result = await renderPanel("/sessions");
    try {
      const rendered = result.plain.join("\n");
      expect(result.plain[0]).toMatch(/^╭ Sessions/);
      expect(rendered).toContain("0 个会话");
      expect(rendered).toContain("暂无会话");
      expect(result.plain.find((line) => line.startsWith("╰"))).toContain("Esc 返回");
      expect(rendered).not.toContain("输入消息");
      expect(result.ansi).toHaveLength(5);
      expect(result.ansi.every((line) => visibleWidth(line) === 80)).toBe(true);
    } finally {
      await result.app.dispose();
    }
  });

  it("does not render a resident Plan frame or hint without an active plan", async () => {
    const result = await renderPanel(undefined);
    try {
      const rendered = result.plain.join("\n");
      expect(rendered).not.toMatch(/╭ Plan\b/);
      expect(rendered).not.toContain("Shift+Tab 下一个区域");
      expect(result.ansi.every((line) => visibleWidth(line) === 80)).toBe(true);
    } finally {
      await result.app.dispose();
    }
  });

  it("keeps a dynamically opened Question hint aligned with its executable actions", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openQuestions([QUESTION]);

    const hint = stripAnsi(panel.renderHint(80, plainTheme()));
    const rendered = panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");

    expect(hint).toContain("Shift+S");
    expect(hint).toContain("Enter");
    expect(rendered).toContain("Question 1 / 1");
  });

  it("keeps the command scroll footer and literal hint visible together", async () => {
    const result = await renderPanel("/");
    try {
      const row = contextualRow(result.plain);
      expect(result.plain[row.frameBottom]).toMatch(/\d+-\d+ \/ \d+/);
      expect(row.hint).toBe(COMMAND_HINT);
      expect(row.composerTop).toMatch(/^╭/);
      expect(result.ansi.length).toBeLessThanOrEqual(24);
    } finally {
      await result.app.dispose();
    }
  });

  it("shows a temporary notice row without restoring an empty Plan hint", async () => {
    const result = await renderPanel(undefined);
    const before = result.app.render(80).map(stripAnsi);
    vi.useFakeTimers();
    try {
      (result.app as unknown as { showNotice(text: string, tone: "success"): void }).showNotice(
        "已保存到 /workspace/.vspi/settings.json",
        "success",
      );
      const notified = result.app.render(80).map(stripAnsi);
      expect(notified).toHaveLength(before.length + 1);
      expect(notified.join("\n")).toContain("已保存到 /workspace/.vspi/settings.json");

      vi.advanceTimersByTime(3500);
      const restored = result.app.render(80).map(stripAnsi);
      expect(restored).toHaveLength(before.length);
      expect(restored.join("\n")).not.toContain("已保存到 /workspace/.vspi/settings.json");
      expect(restored.join("\n")).not.toContain("Shift+Tab 下一个区域");
    } finally {
      vi.useRealTimers();
      await result.app.dispose();
    }
  });

  it("keeps Progress visible until an explicit result replaces it", async () => {
    const result = await renderPanel(undefined);
    const testable = result.app as unknown as {
      showProgress(text: string): void;
      showNotice(text: string, tone: "success"): void;
    };
    vi.useFakeTimers();
    try {
      testable.showProgress("正在扫描历史…");
      expect(result.app.render(80).map(stripAnsi).join("\n")).toContain("◌ 正在扫描历史…");
      vi.advanceTimersByTime(10_000);
      expect(result.app.render(80).map(stripAnsi).join("\n")).toContain("正在扫描历史…");

      testable.showNotice("扫描完成", "success");
      expect(result.app.render(80).map(stripAnsi).join("\n")).toContain("✓ 扫描完成");
      vi.advanceTimersByTime(3_500);
      expect(result.app.render(80).map(stripAnsi).join("\n")).not.toContain("扫描完成");
    } finally {
      vi.useRealTimers();
      await result.app.dispose();
    }
  });

  it("switches the rendered contextual hint to the Inspect transcript registry after empty-composer Tab", async () => {
    const result = await renderPanel(undefined, backendWithInspectableMessage());
    try {
      expect(result.app.composer.getText()).toBe("");

      result.app.handleInput("\t");

      const inspected = result.app.render(80).map(stripAnsi);
      const row = contextualRow(inspected);
      const expected = renderInteractionHint("inspect", "transcript", {
        hasItems: true,
        expandable: true,
        inspectDepth: "node",
      }).replace("Shift+Tab 进入 Plan", "Shift+Tab 返回输入");

      expect(inspected.join("\n")).toContain("Inspect");
      expect(row.hint).toBe(expected);
      expect(row.hint).toContain("Esc 返回输入");
      expect(row.hint).toContain("↑↓/PgUp/PgDn 浏览");
      expect(row.hint).toContain("Enter/→ 进入/展开");
      expect(row.hint).toContain("Shift+Tab 返回输入");

      result.app.handleInput("\u001b[C");
      expect(result.app.render(80).map(stripAnsi).join("\n")).toContain("已展开");
      result.app.handleInput("\u001b");
      expect(result.app.render(80).map(stripAnsi).join("\n")).not.toContain("Inspect");
    } finally {
      await result.app.dispose();
    }
  });

  it("replaces the Provider action-menu hint with valid edit and Ctrl+S actions", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    const provider = PROVIDERS.find((candidate) => candidate.custom);
    if (!provider) throw new Error("custom provider fixture is required");
    panel.setProviders([provider]);
    panel.open("providers");
    expect(stripAnsi(panel.renderHint(80, plainTheme()))).toContain("Enter 打开操作");
    expect(panel.handleInput("\r")).toMatchObject({ type: "providerActions" });
    expect(stripAnsi(panel.renderHint(80, plainTheme()))).toContain("Enter 选择操作");
    panel.handleInput("\r");

    const editing = panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    const editingHint = stripAnsi(panel.renderHint(80, plainTheme()));
    expect(editing).toContain("› 名称");
    expect(editingHint).toContain("Ctrl+S 保存");
    expect(editingHint).toContain("↓");
    expect(editingHint).toContain("Esc 取消");
    const beforeEnter = editing;
    panel.handleInput("\r");
    expect(panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n")).toBe(beforeEnter);
    expect(panel.handleInput("\u0013")).toMatchObject({ type: "providerSave" });
  });

  it.each([
    [40, true],
    [58, true],
    [59, true],
    [60, false],
    [80, false],
  ] as const)("keeps the Model hint aligned with the real outer-width layout at %s columns", (width, narrow) => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    const theme = plainTheme();
    panel.setModels(MODELS, MODEL_GROUPS, "kimi-k3");
    panel.open("models");

    const hint = stripAnsi(panel.renderHint(width, theme)).trim();
    const beforeRight = panel.render(width, 12, theme, DEFAULT_USAGE).map(stripAnsi).join("\n");
    panel.handleInput("\u001b[C");
    const afterRight = panel.render(width, 12, theme, DEFAULT_USAGE).map(stripAnsi).join("\n");

    expect(hint).toContain("Tab 切换视图");
    if (narrow) {
      expect.soft(hint).toContain("←→ 详情");
      expect(afterRight).not.toBe(beforeRight);
      expect(afterRight).toContain("Provider");
    } else {
      expect(hint).not.toContain("←→");
      expect(afterRight).toBe(beforeRight);
      expect(beforeRight).toContain("Provider");
    }
  });
});
