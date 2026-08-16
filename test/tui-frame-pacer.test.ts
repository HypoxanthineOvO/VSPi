import type { Component, Terminal } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TUI_FRAME_INTERVAL_MS,
  DEFAULT_TUI_SCROLL_INTERVAL_MS,
  resolveTuiFrameInterval,
  resolveTuiScrollInterval,
  TuiFramePacer,
  VspiTuiAltScreen,
} from "../src/ui/tui-frame-pacer.js";

class PacerTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  readonly columns = 80;
  readonly rows = 24;
  private onInput: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  emit(data: string): void {
    this.onInput?.(data);
  }
  stop(): void {}
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

afterEach(() => vi.useRealTimers());

describe("TUI frame pacing", () => {
  it("defaults to 30fps and bounds explicit overrides", () => {
    expect(resolveTuiFrameInterval({})).toBe(DEFAULT_TUI_FRAME_INTERVAL_MS);
    expect(resolveTuiFrameInterval({ VSPI_TUI_FRAME_INTERVAL_MS: "16" })).toBe(16);
    expect(resolveTuiFrameInterval({ VSPI_TUI_FRAME_INTERVAL_MS: "50" })).toBe(50);
    expect(resolveTuiFrameInterval({ VSPI_TUI_FRAME_INTERVAL_MS: "1" })).toBe(16);
    expect(resolveTuiFrameInterval({ VSPI_TUI_FRAME_INTERVAL_MS: "999" })).toBe(250);
    expect(resolveTuiScrollInterval({})).toBe(DEFAULT_TUI_SCROLL_INTERVAL_MS);
    expect(resolveTuiScrollInterval({ VSPI_TUI_SCROLL_INTERVAL_MS: "1" })).toBe(33);
    expect(resolveTuiScrollInterval({ VSPI_TUI_SCROLL_INTERVAL_MS: "999" })).toBe(250);
  });

  it("coalesces ordinary renders while preserving forced renders", async () => {
    vi.useFakeTimers();
    const calls: boolean[] = [];
    const pacer = new TuiFramePacer(33);
    const forward = (force: boolean) => calls.push(force);

    pacer.request(false, forward);
    pacer.request(false, forward);
    expect(calls).toEqual([false]);

    await vi.advanceTimersByTimeAsync(32);
    expect(calls).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([false, false]);

    pacer.request(false, forward);
    pacer.request(true, forward);
    expect(calls).toEqual([false, false, true]);
    await vi.runAllTimersAsync();
    expect(calls).toEqual([false, false, true]);
  });

  it("caps viewport frames without delaying focused keyboard input", async () => {
    vi.useFakeTimers();
    const terminal = new PacerTerminal();
    const tui = new VspiTuiAltScreen(terminal, true);
    let renders = 0;
    let inputs = 0;
    const component: Component = {
      render: () => [`frame ${++renders}`],
      invalidate() {},
      handleInput: () => {
        inputs += 1;
      },
    };
    tui.addChild(component);
    tui.setFocus(component);
    tui.start();
    await vi.advanceTimersByTimeAsync(20);
    const beforeBurst = renders;

    for (let elapsed = 0; elapsed < 100; elapsed += 1) {
      tui.requestRender();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(renders - beforeBurst).toBeLessThanOrEqual(4);

    const beforeInput = renders;
    terminal.emit("x");
    await vi.advanceTimersByTimeAsync(1);
    expect(inputs).toBe(1);
    expect(renders).toBeGreaterThan(beforeInput);
    tui.stop();
  });

  it("moves three logical lines per wheel event", async () => {
    vi.useFakeTimers();
    const terminal = new PacerTerminal();
    const tui = new VspiTuiAltScreen(terminal, true);
    tui.addChild({ render: () => Array.from({ length: 100 }, (_, index) => `line ${index}`), invalidate() {} });
    tui.start();
    await vi.advanceTimersByTimeAsync(20);
    const before = tui.viewportTop;

    terminal.emit("\u001b[<64;1;1M");

    expect(before - tui.viewportTop).toBe(3);
    tui.stop();
  });

  it("coalesces rapid viewport scroll into net movement", async () => {
    vi.useFakeTimers();
    const terminal = new PacerTerminal();
    const tui = new VspiTuiAltScreen(terminal, true);
    tui.addChild({ render: () => Array.from({ length: 100 }, (_, index) => `line ${index}`), invalidate() {} });
    tui.start();
    await vi.advanceTimersByTimeAsync(20);
    const start = tui.viewportTop;

    tui.scrollBy(-3);
    tui.scrollBy(-3);
    tui.scrollBy(-3);
    tui.scrollBy(3);

    expect(start - tui.viewportTop).toBe(3);
    await vi.advanceTimersByTimeAsync(DEFAULT_TUI_SCROLL_INTERVAL_MS);
    expect(start - tui.viewportTop).toBe(6);
    tui.stop();
  });
});
