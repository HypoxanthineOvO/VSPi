import { type Component, type ScrollView, type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { TranscriptMessage } from "../src/domain/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { plainTheme } from "./helpers.js";

class FullscreenTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  columns = 80;
  rows = 24;
  private input: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {
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

async function flushRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function transcriptMessages(count: number): TranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    kind: "text",
    text: `Transcript row ${index} ${"content ".repeat(8)}`,
  }));
}

describe("fullscreen TUI shell", () => {
  it("keeps the dock fixed while the upstream viewport scrolls the transcript", async () => {
    const terminal = new FullscreenTerminal();
    const tui = new TuiAltScreen(terminal, true);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/fullscreen",
      settings: { ...DEFAULT_SETTINGS, tuiMode: "fullscreen", fullscreenScrollbar: "always" },
      attachments: attachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    tui.addChild(app);
    tui.setFocus(app);
    await app.start();
    (app as unknown as { messages: TranscriptMessage[] }).messages.push(...transcriptMessages(60));
    app.invalidate();
    tui.start();
    await flushRender();
    const fullscreen = app as unknown as { fullscreenLayout: Component; fullscreenScrollView: ScrollView };
    const renderFrame = () =>
      renderLayoutFrame(fullscreen.fullscreenLayout, terminal.columns, terminal.rows, () => {}).lines.map(stripAnsi);

    renderFrame();
    fullscreen.fullscreenScrollView.scrollToEnd();
    const bottom = renderFrame();
    const dock = bottom.slice(-4);
    expect(bottom).toHaveLength(terminal.rows);
    expect(bottom.join("\n")).toContain("Transcript row 59");

    fullscreen.fullscreenScrollView.scrollToStart();
    const top = renderFrame();
    expect(top.slice(-4)).toEqual(dock);
    expect(top.join("\n")).toContain("Transcript row 0");
    expect(top.join("\n")).not.toContain("Transcript row 59");

    terminal.emit("\x1b[F");
    await flushRender();
    const tailTop = tui.viewportTop;
    terminal.emit("\x1b[5~");
    await flushRender();
    expect(tui.viewportTop).toBeLessThan(tailTop);
    expect(tui.isFollowingOutput).toBe(false);
    terminal.emit("\x1b[H");
    await flushRender();
    expect(tui.viewportTop).toBe(0);
    terminal.emit("\x1b[F");
    await flushRender();
    expect(tui.isFollowingOutput).toBe(true);
    const beforeWheel = tui.viewportTop;
    terminal.emit("\x1b[<64;10;10M");
    await flushRender();
    expect(tui.viewportTop).toBeLessThan(beforeWheel);
    await app.dispose();
    tui.stop();
  });

  it("switches between fullscreen and regular renderers without replacing app state", async () => {
    const terminal = new FullscreenTerminal();
    const tui = new TuiAltScreen(terminal, true);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/tui-switch",
      settings: { ...DEFAULT_SETTINGS, tuiMode: "fullscreen" },
      attachments: attachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    tui.addChild(app);
    tui.setFocus(app);
    await app.start();
    tui.start();
    app.composer.setText("preserved draft");
    const switchMode = (mode: "fullscreen" | "regular") =>
      (app as unknown as { switchTuiMode(mode: "fullscreen" | "regular"): boolean }).switchTuiMode(mode);

    expect(switchMode("regular")).toBe(true);
    expect(app.getActiveTui().mode).toBe("regular");
    expect(app.getActiveTui().terminal).toBe(terminal);
    expect(stripAnsi(app.render(80).join("\n"))).toContain("preserved draft");

    expect(switchMode("fullscreen")).toBe(true);
    expect(app.getActiveTui().mode).toBe("fullscreen");
    expect(app.focused).toBe(true);
    expect(stripAnsi(app.getActiveTui().render(80).join("\n"))).toContain("preserved draft");
    await app.dispose();
    app.getActiveTui().stop();
  });
});
