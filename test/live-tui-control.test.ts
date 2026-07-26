import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents, SendOptions } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { renderActivityRail, renderQueuedMessage } from "../src/ui/activity.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { plainTheme } from "./helpers.js";

class ControlledTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  columns = 80;
  rows = 30;
  stopCount = 0;
  private input: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {
    this.stopCount += 1;
    this.input = undefined;
  }
  emit(data: string): void {
    this.input?.(data);
  }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function attachments(): AttachmentService {
  return { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } as unknown as AttachmentService;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("real TUI live run control", () => {
  it("keeps the composer live, layers Escape, and never exits or replaces the Session", async () => {
    const terminal = new ControlledTerminal();
    const tui = new TUI(terminal, true);
    let events: ChatBackendEvents | undefined;
    let releasePrimary: (() => void) | undefined;
    const send = vi.fn(async (_text: string, options: SendOptions) => {
      if (send.mock.calls.length > 1) {
        return {
          status: "queued" as const,
          delivery: options.behavior === "followUp" ? ("followUp" as const) : ("steer" as const),
        };
      }
      events?.onBusy(true);
      await new Promise<void>((resolve) => {
        releasePrimary = resolve;
      });
      events?.onBusy(false);
      return { status: "completed" as const };
    });
    const cancel = vi.fn(async () => {
      events?.onBusy(false);
      releasePrimary?.();
      return { queuedMessages: [] };
    });
    const newSession = vi.fn(async () => {});
    const onExit = vi.fn();
    const backend: ChatBackend = {
      kind: "pi",
      modelLabel: "Test Model",
      modelId: "test-model",
      supportsVision: true,
      start: vi.fn(async (captured) => {
        events = captured;
      }),
      send,
      cancel,
      compact: vi.fn(async () => {}),
      newSession,
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const app = new VspiApp(tui, plainTheme(), backend, {
      cwd: "/workspace/live-tui",
      settings: { ...DEFAULT_SETTINGS, reducedMotion: true, bridgeEnabled: false },
      attachments: attachments(),
      onExit,
    });
    tui.addChild(app);
    tui.setFocus(app);
    await app.start();
    tui.start();
    const testable = app as unknown as { workspaceFocus: "composer" | "transcript" | "plan" };

    try {
      for (const char of "PRIMARY") terminal.emit(char);
      terminal.emit("\r");
      await flush();
      expect(send).toHaveBeenCalledTimes(1);
      expect(app.focused).toBe(true);
      expect(stripAnsi(app.render(80).join("\n"))).toContain("Working ●");

      for (const char of "STEER") terminal.emit(char);
      terminal.emit("\r");
      await flush();
      expect(send.mock.calls[1]?.[0]).toBe("STEER");
      expect(send.mock.calls[1]?.[1].behavior).toBe("prompt");

      for (const char of "FOLLOW") terminal.emit(char);
      terminal.emit("\x1b\r");
      await flush();
      expect(send.mock.calls[2]?.[0]).toBe("FOLLOW");
      expect(send.mock.calls[2]?.[1].behavior).toBe("followUp");

      terminal.emit("\t");
      terminal.emit("\x1b");
      await flush();
      expect(cancel).not.toHaveBeenCalled();
      terminal.emit("\x1b");
      await flush();
      expect(cancel).toHaveBeenCalledOnce();
      expect(newSession).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
      expect(terminal.stopCount).toBe(0);

      terminal.emit("\x1b[Z");
      expect(testable.workspaceFocus).toBe("transcript");
      terminal.emit("\x1b[Z");
      expect(testable.workspaceFocus).toBe("plan");
      terminal.emit("\x1b[Z");
      expect(testable.workspaceFocus).toBe("composer");

      const beforeNotice = app.render(80);
      (app as unknown as { showNotice(text: string, tone: "success"): void }).showNotice(
        "已保存到 /tmp/config.json",
        "success",
      );
      const withNotice = app.render(80);
      expect(tui.hasOverlay()).toBe(false);
      expect(app.focused).toBe(true);
      expect(withNotice).toHaveLength(beforeNotice.length);
      expect(stripAnsi(withNotice.join("\n"))).toContain("已保存到 /tmp/config.json");
    } finally {
      releasePrimary?.();
      await app.dispose();
      tui.stop();
    }
  });

  it.each([40, 80, 120] as const)("keeps the independent activity rail within %s columns", (width) => {
    const rendered = renderActivityRail({ indicator: "⠋", steering: 2, followUp: 1 }, width, plainTheme());
    expect(visibleWidth(rendered)).toBe(width);
    expect(stripAnsi(rendered)).toContain("Working ⠋");
    expect(stripAnsi(rendered)).not.toMatch(/▌|插入|后续|队列/);
  });

  it.each([40, 80, 120] as const)("renders a queued message as one quiet row at %s columns", (width) => {
    const rendered = renderQueuedMessage(
      { id: "queued", role: "user", kind: "text", text: "另外，选项说明必须始终可见。", delivery: "steer" },
      width,
      plainTheme(),
    );
    expect(visibleWidth(rendered)).toBe(width);
    expect(stripAnsi(rendered)).toContain("▌");
    expect(stripAnsi(rendered)).toContain("↪");
    expect(stripAnsi(rendered)).not.toMatch(/等待|下一次调用|已插入/);
  });
});
