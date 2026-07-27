import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { Attachment, SessionOption, TranscriptMessage } from "../src/domain/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import type { PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

type TestableApp = {
  submit(raw: string): Promise<void>;
  applyPanelEvent(event: PanelEvent): Promise<void>;
  messages: TranscriptMessage[];
  notice?: { text: string; tone: "info" | "success" | "warning" | "error" };
};

function fakeTui(setProgress = vi.fn()): TUI {
  return {
    terminal: { rows: 24, setProgress },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function throwingBackend(method: "send" | "newSession" | "compact" | "switchSession"): ChatBackend {
  const fail = async (name: string): Promise<never> => {
    throw new Error(`${name} backend failure sentinel`);
  };
  return {
    kind: "fixture",
    modelLabel: "Test Model",
    modelId: "test-model",
    supportsVision: true,
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {
      if (method === "send") await fail("send");
    }),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {
      if (method === "compact") await fail("compact");
    }),
    newSession: vi.fn(async () => {
      if (method === "newSession") await fail("newSession");
    }),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {
      if (method === "switchSession") await fail("switchSession");
    }),
    dispose: vi.fn(async () => {}),
  };
}

async function createApp(backend: ChatBackend, tui = fakeTui()): Promise<VspiApp> {
  const app = new VspiApp(tui, plainTheme(), backend, {
    cwd: "/workspace/error-recovery",
    settings: DEFAULT_SETTINGS,
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  return app;
}

function attachment(id: string): Attachment {
  return {
    id,
    alias: `截图-${id}`,
    mimeType: "image/png",
    width: 1440,
    height: 900,
    size: 120_000,
    path: `/tmp/${id}.png`,
    status: "ready",
  };
}

async function expectVisibleCaughtError(app: VspiApp, action: () => Promise<void>): Promise<void> {
  await expect(action()).resolves.toBeUndefined();
  const testable = app as unknown as TestableApp;
  expect(testable.notice?.tone).toBe("error");
  expect(testable.notice?.text).toMatch(/失败/);
  expect(app.render(80).map(stripAnsi).join("\n")).toContain(testable.notice?.text);
}

describe("VspiApp backend error recovery", () => {
  it("restores composer text and every attachment when send fails", async () => {
    const app = await createApp(throwingBackend("send"));
    app.composer.setText("请比较两张截图");
    app.composer.addAttachment(attachment("before"));
    app.composer.addAttachment(attachment("after"));
    const originalText = app.composer.getText();
    const originalAttachments = [...app.composer.attachments];

    await expect((app as unknown as TestableApp).submit(originalText)).resolves.toBeUndefined();
    expect(app.composer.getText()).toBe(originalText);
    expect(app.composer.attachments).toEqual(originalAttachments);
    await app.dispose();
  });

  it("clears backend-reported busy state after a rejected send", async () => {
    let events: ChatBackendEvents | undefined;
    const backend = throwingBackend("send");
    const send = vi.fn(async () => {
      if (!events) throw new Error("backend events were not registered");
      events.onBusy(true);
      throw new Error("busy send backend failure sentinel");
    });
    backend.start = vi.fn(async (captured) => {
      events = captured;
    });
    backend.send = send;
    const setProgress = vi.fn();
    const app = await createApp(backend, fakeTui(setProgress));
    const testable = app as unknown as TestableApp;

    app.composer.setText("第一次提交");
    await expect(testable.submit(app.composer.getText())).resolves.toBeUndefined();
    expect(app.render(80).map(stripAnsi).join("\n")).not.toContain("生成中");
    expect.soft(setProgress).toHaveBeenLastCalledWith(false);

    app.composer.setText("第二次提交");
    await expect(testable.submit(app.composer.getText())).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    await app.dispose();
  });

  it.each([
    ["/new", "newSession"],
    ["/compact", "compact"],
  ] as const)("catches %s backend failures and renders an error notice", async (command, method) => {
    const app = await createApp(throwingBackend(method));
    const testable = app as unknown as TestableApp;
    const existingTranscript: TranscriptMessage[] = [
      { id: "existing", role: "assistant", kind: "text", text: "必须保留的既有内容" },
    ];
    if (command === "/new") testable.messages.push(...existingTranscript);

    await expectVisibleCaughtError(app, () => testable.submit(command));
    if (command === "/new") expect(testable.messages).toEqual(existingTranscript);
    await app.dispose();
  });

  it("keeps /compact out of the composer after a successful manual compact", async () => {
    const backend = throwingBackend("send");
    backend.compact = vi.fn(async () => {});
    const app = await createApp(backend);
    const testable = app as unknown as TestableApp;
    try {
      await testable.submit("/compact continuity");
      expect(backend.compact).toHaveBeenCalledOnce();
      expect(app.composer.getText()).toBe("");
      expect(testable.notice?.tone).not.toBe("error");
    } finally {
      await app.dispose();
    }
  });

  it("restores /compact only when the backend compaction fails", async () => {
    const app = await createApp(throwingBackend("compact"));
    const testable = app as unknown as TestableApp;
    try {
      await testable.submit("/compact continuity");
      expect(app.composer.getText()).toBe("/compact continuity");
      expect(testable.notice?.tone).toBe("error");
    } finally {
      await app.dispose();
    }
  });

  it("catches session-switch failures and renders an error notice", async () => {
    const app = await createApp(throwingBackend("switchSession"));
    const session: SessionOption = {
      id: "broken-session",
      label: "无法恢复的会话",
      relativeTime: "刚刚",
      branchDepth: 0,
    };
    await expectVisibleCaughtError(app, () =>
      (app as unknown as TestableApp).applyPanelEvent({ type: "session", session }),
    );
    await app.dispose();
  });
});
