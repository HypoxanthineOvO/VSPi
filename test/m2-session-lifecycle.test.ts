import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents, SendOptions } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { Attachment, SessionOption, TranscriptMessage } from "../src/domain/types.js";
import type { PanelEvent } from "../src/ui/panels.js";
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
};

function fakeTui(setProgress = vi.fn()): TUI {
  return {
    terminal: { rows: 24, columns: 80, setProgress, write: vi.fn() },
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
  it("restores the submitted draft and clears busy after consecutive Ctrl+C cancellations", async () => {
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

      expect(app.composer.getText()).toBe(draft);
      expect(testable.busy).toBe(false);
      expect(testable.messages.some((message) => message.kind === "text" && message.text === draft)).toBe(false);
      app.composer.setText("");
    }
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    await app.dispose();
  });

  it("restores draft, attachments and idle state immediately when backend abort rejects", async () => {
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
      expect(app.composer.getText()).toBe(draft);
      expect(app.composer.attachments).toEqual([attachment]);
      expect(testable.messages.some((message) => message.kind === "text" && message.text === draft)).toBe(false);
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
      expect(app.composer.attachments).toEqual([attachment]);
      expect(testable.messages.some((message) => message.kind === "text" && message.text === draft)).toBe(false);
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
