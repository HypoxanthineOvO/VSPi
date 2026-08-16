import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { loadSettings, saveSettings } from "../src/config/settings.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { AppSettings, Attachment, TranscriptMessage } from "../src/domain/types.js";
import type { ThinkingTranslator } from "../src/translation/thinking-translator.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderMarkdown } from "../src/ui/markdown.js";
import { renderTranscript } from "../src/ui/transcript.js";
import { plainTheme } from "./helpers.js";

interface MediaRenderOptions {
  inspectedId?: string;
  thinkingDisplay?: "hidden" | "collapsed" | "expanded";
  wrapCode?: boolean;
}

type MarkdownContract = (
  text: string,
  width: number,
  theme: ReturnType<typeof plainTheme>,
  options?: Pick<MediaRenderOptions, "wrapCode">,
) => string[];

type TranscriptContract = (
  messages: TranscriptMessage[],
  width: number,
  theme: ReturnType<typeof plainTheme>,
  options?: MediaRenderOptions,
) => string[];

type TestableApp = {
  messages: TranscriptMessage[];
  submit(raw: string): Promise<void>;
  applyThinkingDisplay(mode: AppSettings["thinkingDisplay"]): void;
  withThinkingDisplayDefault(message: TranscriptMessage): TranscriptMessage;
};

const renderMarkdownContract = renderMarkdown as MarkdownContract;
const renderTranscriptContract = renderTranscript as TranscriptContract;

const ATTACHMENT: Attachment = {
  id: "m5-shot",
  alias: "登录页截图",
  mimeType: "image/png",
  width: 1440,
  height: 900,
  size: 128_000,
  path: "/private/cache/m5-shot.png",
  status: "ready",
};

function fakeTui(): TUI {
  return {
    terminal: { columns: 80, rows: 40, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function fakeBackend(supportsVision: boolean) {
  const send = vi.fn(async () => {});
  const backend: ChatBackend = {
    kind: "fixture",
    modelLabel: supportsVision ? "Vision Fixture" : "Text Fixture",
    modelId: supportsVision ? "vision-fixture" : "text-fixture",
    supportsVision,
    start: vi.fn(async (_events: ChatBackendEvents) => {}),
    send,
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return { backend, send };
}

async function createApp(settings: AppSettings, supportsVision: boolean) {
  const backend = fakeBackend(supportsVision);
  const app = new VspiApp(fakeTui(), plainTheme(), backend.backend, {
    cwd: "/workspace/m5-media-render",
    settings,
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  return { app, send: backend.send };
}

function plain(lines: string[]): string[] {
  return lines.map(stripAnsi);
}

function expectWidthSafe(lines: string[], width: number): void {
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
}

describe("M5 media preflight", () => {
  it("blocks a non-Vision send without consuming text or attachments", async () => {
    const { app, send } = await createApp({ ...DEFAULT_SETTINGS }, false);
    const testable = app as unknown as TestableApp;
    app.composer.setText("请检查这张登录页截图");
    app.composer.addAttachment(ATTACHMENT);
    const originalText = app.composer.getText();

    await expect(testable.submit(originalText)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(app.composer.getText()).toBe(originalText);
    expect(app.composer.attachments).toEqual([ATTACHMENT]);
    expect(testable.messages).toEqual([]);
    expect(plain(app.render(80)).join("\n")).toMatch(/不支持图片输入|vision/i);
    await app.dispose();
  });
});

describe("M5 Markdown and streaming rendering", () => {
  it("keeps the required Markdown constructs bounded at 40/80/120 columns", () => {
    const source = [
      "# 中文标题",
      "",
      "- 一级 **粗体**",
      "  - 二级 *斜体* 与 `inline()`",
      "",
      "> 引用内容",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");
    for (const width of [40, 80, 120]) {
      const lines = renderMarkdownContract(source, width, plainTheme(), { wrapCode: true });
      const text = plain(lines).join("\n");

      expectWidthSafe(lines, width);
      expect(text).toContain("中文标题");
      expect(text).toContain("一级");
      expect(text).toContain("二级");
      expect(text).toContain("inline()");
      expect(text).toContain("引用内容");
      expect(text).toContain("const answer = 42;");
    }
  });

  it("makes wrapCode change only long fenced-code layout", () => {
    const token = `const payload = "${"0123456789".repeat(10)}";`;
    const source = `\`\`\`ts\n${token}\n\`\`\``;
    const noWrap = renderMarkdownContract(source, 40, plainTheme(), { wrapCode: false });
    const wrapped = renderMarkdownContract(source, 40, plainTheme(), { wrapCode: true });

    expectWidthSafe(noWrap, 40);
    expectWidthSafe(wrapped, 40);
    expect(wrapped).not.toEqual(noWrap);
    expect(wrapped.length).toBeGreaterThan(noWrap.length);
    expect(
      plain(wrapped)
        .join("")
        .replaceAll(/[❘│|\s]/g, ""),
    ).toContain(token.replaceAll(/\s/g, ""));
  });

  it("rerenders a partial fence to complete Markdown without reflow at 40/80/120 columns", () => {
    const partial: TranscriptMessage = {
      id: "stream",
      role: "assistant",
      kind: "text",
      text: "## 结果\n\n```ts\nconst answer =",
      streaming: true,
    };
    const complete: TranscriptMessage = {
      ...partial,
      text: `${partial.text} 42;\n\`\`\`\n\n完成。`,
      streaming: false,
    };
    for (const width of [40, 80, 120]) {
      const partialLines = renderTranscriptContract([partial], width, plainTheme(), { wrapCode: true });
      const completeLines = renderTranscriptContract([complete], width, plainTheme(), { wrapCode: true });
      const partialText = plain(partialLines);
      const completeText = plain(completeLines);

      expectWidthSafe(partialLines, width);
      expectWidthSafe(completeLines, width);
      expect(partialText.join("\n")).toContain("const answer =");
      expect(completeText.join("\n")).toContain("const answer = 42;");
      expect(completeText.join("\n")).toContain("完成。");
      expect(completeText.join("\n")).not.toContain("❙");
      expect(partialText.findIndex((line) => line.includes("const answer ="))).toBe(
        completeText.findIndex((line) => line.includes("const answer =")),
      );
    }
  });

  it("forwards wrapCode through transcript rendering at 40/80/120 columns", () => {
    const message: TranscriptMessage = {
      id: "long-code",
      role: "assistant",
      kind: "text",
      text: `\`\`\`txt\n${"abcdefghij".repeat(14)}\n\`\`\``,
    };
    for (const width of [40, 80, 120]) {
      const noWrap = renderTranscriptContract([message], width, plainTheme(), { wrapCode: false });
      const wrapped = renderTranscriptContract([message], width, plainTheme(), { wrapCode: true });

      expectWidthSafe(noWrap, width);
      expectWidthSafe(wrapped, width);
      expect(wrapped).not.toEqual(noWrap);
      expect(wrapped.length).toBeGreaterThan(noWrap.length);
    }
  });
});

describe("M5 thinking visibility and persistence", () => {
  it("translates one completed live Thinking record without replacing its stored source text", async () => {
    let events: ChatBackendEvents | undefined;
    const backend = fakeBackend(true).backend;
    backend.start = vi.fn(async (captured: ChatBackendEvents) => {
      events = captured;
    });
    const translator: ThinkingTranslator = {
      translate: vi.fn(async () => "正在检查相关页面。"),
    };
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/m5-thinking-translation",
      settings: {
        ...DEFAULT_SETTINGS,
        thinkingDisplay: "expanded",
        thinkingTranslationEndpoint: "http://127.0.0.1:5000/translate",
      },
      attachments: fakeAttachments(),
      thinkingTranslator: translator,
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();
    events?.onMessage({
      id: "live-thinking",
      role: "assistant",
      kind: "thinking",
      effort: "high",
      text: "",
      collapsed: false,
      streaming: true,
    });
    events?.onMessageUpdate("live-thinking", { text: "Inspecting the relevant page.", streaming: true });
    events?.onMessageUpdate("live-thinking", { text: "Inspecting the relevant page.", streaming: false });

    await vi.waitFor(() => expect(translator.translate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(plain(app.render(80)).join("\n")).toContain("正在检查相关页面。"));
    const testable = app as unknown as TestableApp;
    expect(testable.messages[0]).toMatchObject({
      text: "Inspecting the relevant page.",
      translatedText: "正在检查相关页面。",
      translationStatus: "translated",
    });
    const rendered = plain(app.render(80)).join("\n");
    expect(rendered).toContain("已翻译");
    expect(rendered).not.toContain("Inspecting the relevant page.");
    await app.dispose();
  });

  it("keeps a hidden thinking record while Inspect retains stable ids and per-entry expansion", async () => {
    const { app } = await createApp({ ...DEFAULT_SETTINGS, thinkingDisplay: "hidden", wrapCode: true }, true);
    const testable = app as unknown as TestableApp;
    testable.messages.push(
      {
        id: "thinking-entry",
        role: "assistant",
        kind: "thinking",
        effort: "high",
        text: "PRIVATE_THINKING_DETAIL",
        collapsed: true,
        streaming: false,
      },
      {
        id: "tool-entry",
        role: "assistant",
        kind: "tool",
        name: "inspect",
        summary: "完成",
        status: "success",
        output: "PRIVATE_TOOL_DETAIL",
        expanded: false,
      },
    );

    const hidden = plain(app.render(80)).join("\n");
    expect(hidden).toContain("◇ 思考 · 已隐藏");
    expect(hidden).not.toContain("PRIVATE_THINKING_DETAIL");

    app.handleInput("\t");
    app.handleInput("\u001b[C");
    app.handleInput("\u001b[C");
    expect(plain(app.render(80)).join("\n")).toContain("PRIVATE_TOOL_DETAIL");

    app.handleInput("\u001b[D");
    app.handleInput("\u001b[D");
    app.handleInput("\u001b[A");
    app.handleInput("\u001b[C");
    const inspectedThinking = plain(app.render(80)).join("\n");
    expect(inspectedThinking).toContain("PRIVATE_THINKING_DETAIL");
    expect(inspectedThinking).not.toContain("PRIVATE_TOOL_DETAIL");
    await app.dispose();
  });

  it("persists thinkingDisplay and wrapCode across global and trusted-project reloads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m5-settings-project-"));
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-settings-home-"));
    await saveSettings(cwd, { ...DEFAULT_SETTINGS, scope: "global", thinkingDisplay: "hidden", wrapCode: true }, home);

    expect(await loadSettings(cwd, home)).toMatchObject({ thinkingDisplay: "hidden", wrapCode: true });

    await saveSettings(
      cwd,
      { ...DEFAULT_SETTINGS, scope: "project", thinkingDisplay: "expanded", wrapCode: false },
      home,
      { trustedProject: true },
    );
    expect(await loadSettings(cwd, home, { trustedProject: true })).toMatchObject({
      scope: "project",
      thinkingDisplay: "expanded",
      wrapCode: false,
    });
    expect(await loadSettings(cwd, home, { trustedProject: false })).toMatchObject({
      scope: "global",
      thinkingDisplay: "hidden",
      wrapCode: true,
    });
  });

  it("applies a changed thinking mode to existing and future messages immediately", async () => {
    const { app } = await createApp({ ...DEFAULT_SETTINGS, thinkingDisplay: "expanded" }, true);
    const testable = app as unknown as TestableApp;
    const thinking: TranscriptMessage = {
      id: "existing-thinking",
      role: "assistant",
      kind: "thinking",
      effort: "medium",
      text: "VISIBLE_AFTER_APPLY",
      collapsed: true,
      streaming: false,
    };
    testable.messages.push(thinking);

    testable.applyThinkingDisplay("expanded");
    expect(testable.messages[0]).toMatchObject({ collapsed: false });
    expect(plain(app.render(80)).join("\n")).toContain("VISIBLE_AFTER_APPLY");

    testable.applyThinkingDisplay("collapsed");
    expect(testable.messages[0]).toMatchObject({ collapsed: true });
    expect(plain(app.render(80)).join("\n")).toMatch(/已折叠[\s\S]*VISIBLE_AFTER_APPLY/u);
    expect(testable.withThinkingDisplayDefault({ ...thinking, id: "future-thinking" })).toMatchObject({
      collapsed: false,
    });
    await app.dispose();
  });
});
