import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents, SendOptions } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { Attachment, SessionOption, TranscriptMessage } from "../src/domain/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import type { PanelEvent } from "../src/ui/panels.js";
import type { TranscriptWindow } from "../src/ui/transcript.js";
import { plainTheme } from "./helpers.js";

type SessionReason = "startup" | "new" | "resume" | "fork";
type SessionResetEvents = ChatBackendEvents & {
  onSessionReset?: (session: { id: string; reason: SessionReason }) => void;
};
type NewSessionOptions = { defaults?: boolean; continuePlan?: boolean };
type TestableApp = {
  submit(raw: string): Promise<void>;
  applyPanelEvent(event: PanelEvent): Promise<void>;
  messages: TranscriptMessage[];
  busy: boolean;
  inspectNodeId?: string;
  currentTranscriptWindow(width?: number): TranscriptWindow;
  focusTranscript(): boolean;
};

function fakeTui(setProgress = vi.fn(), rows = 24): TUI {
  return {
    terminal: { rows, columns: 80, setProgress, write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function sessionBackend() {
  let events: SessionResetEvents | undefined;
  const newSession = vi.fn(async (_options?: NewSessionOptions) => {
    events?.onSessionReset?.({ id: `new-${newSession.mock.calls.length}`, reason: "new" });
    events?.onUsage({ ...DEFAULT_USAGE, inputTokens: 0, outputTokens: 0 });
  });
  const switchSession = vi.fn(async (id: string) => {
    events?.onSessionReset?.({ id, reason: "resume" });
    events?.onMessage({ id: `${id}-message`, role: "assistant", kind: "text", text: `TRANSCRIPT_${id}` });
    events?.onUsage({ ...DEFAULT_USAGE, inputTokens: 7, outputTokens: 11 });
  });
  const forkSession = vi.fn(async (id: string) => {
    events?.onSessionReset?.({ id: `fork-of-${id}`, reason: "fork" });
    events?.onMessage({ id: `fork-${id}-message`, role: "assistant", kind: "text", text: `FORK_${id}` });
  });
  const backend = {
    kind: "pi",
    modelLabel: "Anthropic / M2 Model",
    modelId: "m2-model",
    supportsVision: true,
    start: vi.fn(async (captured: ChatBackendEvents) => {
      events = captured;
      captured.onMessage({ id: "old", role: "assistant", kind: "text", text: "OLD_SESSION_SENTINEL" });
      captured.onUsage({ ...DEFAULT_USAGE, inputTokens: 99, outputTokens: 88 });
    }),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession,
    listSessions: vi.fn(async () => []),
    switchSession,
    forkSession,
    dispose: vi.fn(async () => {}),
  } as unknown as ChatBackend;
  return { backend, newSession, switchSession, forkSession };
}

async function createApp(backend: ChatBackend, tui = fakeTui()): Promise<VspiApp> {
  const app = new VspiApp(tui, plainTheme(), backend, {
    cwd: "/workspace/m2-lifecycle",
    settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  return app;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("M2 session identity isolation", () => {
  it("keeps the visible waterfall bounded while Inspect loads earlier history on demand", async () => {
    const controlled = sessionBackend();
    const app = await createApp(controlled.backend);
    const testable = app as unknown as TestableApp;
    testable.messages = Array.from({ length: 140 }, (_, index) => ({
      id: `history-${index}`,
      role: "assistant",
      kind: "text",
      text: `HISTORY_CONTENT_${index}`,
    }));
    const window = testable.currentTranscriptWindow(80);
    expect(window.hiddenBlocks).toBeGreaterThan(0);

    const rendered = app.render(80).map(stripAnsi).join("\n");
    expect(rendered).toContain(`更早的 ${window.hiddenBlocks} 条内容暂未显示`);
    expect(rendered).toContain("HISTORY_CONTENT_139");
    expect(rendered).not.toContain("HISTORY_CONTENT_0");

    // 前景窗口仍然 bounded，但 Inspect 向上越界时逐批加载，完整历史始终可达。
    expect(testable.focusTranscript()).toBe(true);
    for (let index = 0; index < 400 && testable.inspectNodeId !== "history-0"; index += 1) app.handleInput("\u001b[A");
    expect(testable.inspectNodeId).toBe("history-0");
    const inspected = app.render(80).map(stripAnsi).join("\n");
    expect(inspected).toContain("HISTORY_CONTENT_0");
    expect(app.render(80).length).toBeLessThanOrEqual(24);
    await app.dispose();
  });

  it("lets Sessions take over the full content area and restores chat on Escape", async () => {
    const controlled = sessionBackend();
    vi.mocked(controlled.backend.listSessions).mockResolvedValue([
      { id: "current", label: "当前会话", relativeTime: "刚刚", branchDepth: 0, current: true },
      { id: "older", label: "较早会话", relativeTime: "8 分钟前", branchDepth: 0 },
    ]);
    const app = await createApp(controlled.backend);

    await (app as unknown as TestableApp).submit("/resume");
    const sessions = app.render(80).map(stripAnsi);
    const surface = sessions.join("\n");
    expect(sessions).toHaveLength(23);
    expect(surface).toContain("Sessions");
    expect(surface).toContain("2 个会话");
    expect(surface).toContain("当前会话");
    expect(surface).toContain("Enter 打开");
    expect(surface).not.toContain("OLD_SESSION_SENTINEL");
    expect(surface).not.toContain("输入消息");
    expect(surface).not.toContain("Working");
    expect(surface).not.toContain("Plan");

    app.handleInput("\u001b");
    await flush();
    const restored = app.render(80).map(stripAnsi).join("\n");
    expect(restored).toContain("OLD_SESSION_SENTINEL");
    expect(restored).toMatch(/╭─+╮[\s\S]*╰─+╯/u);
    await app.dispose();
  });

  it.each([12, 24, 40])("keeps the Resume title visible with a bottom safety row at %i terminal rows", async (rows) => {
    const controlled = sessionBackend();
    vi.mocked(controlled.backend.listSessions).mockResolvedValue(
      Array.from({ length: 80 }, (_, index) => ({
        id: `session-${index}`,
        label: `会话 ${index}`,
        relativeTime: `${index} 分钟前`,
        branchDepth: 0,
      })),
    );
    const app = await createApp(controlled.backend, fakeTui(vi.fn(), rows));

    await (app as unknown as TestableApp).submit("/resume");
    const rendered = app.render(80).map(stripAnsi);

    expect(rendered).toHaveLength(rows - 1);
    expect(rendered[0]).toMatch(/^╭ Sessions/u);
    expect(rendered.slice(-2).join("\n")).toContain("Context");
    expect(rendered.at(-1)).toContain("Policy Standard");
    expect(rendered.join("\n")).toContain("会话 0");
    await app.dispose();
  });

  it("clears the old transcript before hydrating a switched session", async () => {
    const controlled = sessionBackend();
    const app = await createApp(controlled.backend);
    const session: SessionOption = {
      id: "restored-session",
      label: "Restored",
      relativeTime: "刚刚",
      branchDepth: 0,
    };

    await (app as unknown as TestableApp).applyPanelEvent({ type: "session", session });

    const messages = (app as unknown as TestableApp).messages;
    expect(messages).toEqual([
      expect.objectContaining({ id: "restored-session-message", text: "TRANSCRIPT_restored-session" }),
    ]);
    expect(messages.some((message) => message.kind === "text" && message.text === "OLD_SESSION_SENTINEL")).toBe(false);
    expect(controlled.switchSession).toHaveBeenCalledWith("restored-session");
    await app.dispose();
  });

  it.each([
    ["/new", { defaults: false, continuePlan: false }],
    ["/new --default", { defaults: true, continuePlan: false }],
    ["/new --continue", { defaults: false, continuePlan: true }],
  ] as const)("maps %s to explicit inheritance semantics", async (command, expected) => {
    const controlled = sessionBackend();
    const app = await createApp(controlled.backend);

    await (app as unknown as TestableApp).submit(command);

    expect(controlled.newSession).toHaveBeenCalledWith(expected);
    expect((app as unknown as TestableApp).messages).toEqual([]);
    await app.dispose();
  });

  it("routes the Sessions fork action to a real backend fork and isolates the fork transcript", async () => {
    const controlled = sessionBackend();
    const app = await createApp(controlled.backend);
    const session: SessionOption = {
      id: "fork-source",
      label: "Fork source",
      relativeTime: "刚刚",
      branchDepth: 0,
    };

    await (app as unknown as TestableApp).applyPanelEvent({ type: "fork", session });

    expect(controlled.forkSession).toHaveBeenCalledWith("fork-source");
    expect((app as unknown as TestableApp).messages).toEqual([
      expect.objectContaining({ id: "fork-fork-source-message", text: "FORK_fork-source" }),
    ]);
    await app.dispose();
  });
});

describe("M2 cancellation recovery", () => {
  it("retains submitted messages in the transcript and clears busy after consecutive Ctrl+C cancellations", async () => {
    let events: ChatBackendEvents | undefined;
    let releaseSend: (() => void) | undefined;
    const send = vi.fn(async (_text: string, _options: SendOptions) => {
      events?.onBusy(true);
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });
    const cancel = vi.fn(async () => {
      events?.onBusy(false);
      releaseSend?.();
    });
    const backend: ChatBackend = {
      kind: "pi",
      modelLabel: "Anthropic / Abort Model",
      modelId: "abort-model",
      supportsVision: true,
      start: vi.fn(async (captured) => {
        events = captured;
      }),
      send,
      cancel,
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const app = await createApp(backend);
    const testable = app as unknown as TestableApp;

    for (const draft of ["FIRST_ABORTED_DRAFT", "SECOND_ABORTED_DRAFT"]) {
      app.composer.setText(draft);
      const pending = testable.submit(draft);
      await flush();
      expect(testable.busy).toBe(true);

      app.handleInput("\u0003");
      await pending;
      await flush();

      expect(app.composer.getText()).toBe("");
      expect(testable.busy).toBe(false);
      expect(testable.messages.some((message) => message.kind === "text" && message.text === draft)).toBe(true);
    }
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    await app.dispose();
  });

  it("keeps the submitted message and attachment in the transcript when backend abort rejects", async () => {
    let events: ChatBackendEvents | undefined;
    let releaseSend: (() => void) | undefined;
    const send = vi.fn(async () => {
      events?.onBusy(true);
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });
    const cancelError = new Error("abort rejection sentinel");
    const cancel = vi.fn(async () => {
      throw cancelError;
    });
    const backend: ChatBackend = {
      kind: "pi",
      modelLabel: "Anthropic / Abort Reject Model",
      modelId: "abort-reject-model",
      supportsVision: true,
      start: vi.fn(async (captured) => {
        events = captured;
      }),
      send,
      cancel,
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const setProgress = vi.fn();
    const app = await createApp(backend, fakeTui(setProgress));
    const testable = app as unknown as TestableApp & {
      notice?: { text: string; tone: string };
    };
    const draft = "ABORT_REJECTED_DRAFT";
    const attachment: Attachment = {
      id: "abort-rejected-attachment",
      alias: "取消失败截图",
      mimeType: "image/png",
      width: 1280,
      height: 720,
      size: 1234,
      path: "/tmp/abort-rejected.png",
      status: "ready",
    };
    app.composer.setText(draft);
    app.composer.addAttachment(attachment);
    const pending = testable.submit(draft);
    await flush();
    expect(testable.busy).toBe(true);

    app.handleInput("\u0003");
    await flush();
    let sendSettled = false;
    try {
      expect(cancel).toHaveBeenCalledOnce();
      expect(app.composer.getText()).toBe("");
      expect(app.composer.attachments).toEqual([]);
      expect(testable.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "text", text: draft, attachments: [attachment] })]),
      );
      expect(testable.busy).toBe(false);
      expect(setProgress).toHaveBeenLastCalledWith(false);
      expect(testable.notice).toMatchObject({ tone: "error" });
      expect(testable.notice?.text).toContain("取消生成失败");
      expect(testable.notice?.text).toContain(cancelError.message);

      app.composer.setText("NEW_DRAFT_AFTER_CANCEL_RECOVERY");
      releaseSend?.();
      sendSettled = true;
      await pending;
      await flush();
      expect(app.composer.getText()).toBe("NEW_DRAFT_AFTER_CANCEL_RECOVERY");
      expect(app.composer.attachments).toEqual([]);
      expect(testable.messages.some((message) => message.kind === "text" && message.text === draft)).toBe(true);
      expect(testable.busy).toBe(false);
      expect(testable.notice?.text).toContain(cancelError.message);
    } finally {
      if (!sendSettled) {
        releaseSend?.();
        await pending;
      }
      await app.dispose();
    }
  });
});
