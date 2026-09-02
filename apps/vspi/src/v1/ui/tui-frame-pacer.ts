import { type Terminal, TuiAltScreen, type TuiAltScreenOptions, type TuiStopOptions } from "@moonshot-ai/pi-tui";
import { recordFrameRenderMs } from "./scrollback-terminal.js";

export const DEFAULT_TUI_FRAME_INTERVAL_MS = 33;
export const DEFAULT_TUI_SCROLL_INTERVAL_MS = 100;
// C16 M4a: while the viewport is being scrolled the fullscreen frame cadence
// drops so each wheel burst costs fewer (larger) frames near the terminal.
export const DEFAULT_TUI_SCROLL_FRAME_INTERVAL_MS = 66;
const SCROLL_FRAME_WINDOW_MS = 500;

export function resolveTuiFrameInterval(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.VSPI_TUI_FRAME_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TUI_FRAME_INTERVAL_MS;
  return Math.max(16, Math.min(250, Math.floor(configured)));
}

export function resolveTuiScrollInterval(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.VSPI_TUI_SCROLL_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TUI_SCROLL_INTERVAL_MS;
  return Math.max(33, Math.min(250, Math.floor(configured)));
}

export function resolveTuiScrollFrameInterval(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.VSPI_TUI_SCROLL_FRAME_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TUI_SCROLL_FRAME_INTERVAL_MS;
  return Math.max(33, Math.min(250, Math.floor(configured)));
}

export class TuiFramePacer {
  private timer: NodeJS.Timeout | undefined;
  private lastForwardedAt = Number.NEGATIVE_INFINITY;

  constructor(private intervalMs: number) {}

  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
  }

  request(force: boolean, forward: (force: boolean) => void): void {
    if (force) {
      this.cancel();
      this.lastForwardedAt = performance.now();
      forward(true);
      return;
    }
    if (this.timer) return;
    const now = performance.now();
    const delay = Math.max(0, this.intervalMs - (now - this.lastForwardedAt));
    if (delay === 0) {
      this.lastForwardedAt = now;
      forward(false);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastForwardedAt = performance.now();
      forward(false);
    }, delay);
    this.timer.unref();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class VspiTuiAltScreen extends TuiAltScreen {
  private framePacer: TuiFramePacer | undefined;
  private readonly scrollFrameIntervalMs: number;
  private readonly defaultFrameIntervalMs: number;
  private readonly scrollIntervalMs: number;
  private pendingScrollLines = 0;
  private scrollTimer: NodeJS.Timeout | undefined;
  private lastScrollAt = Number.NEGATIVE_INFINITY;
  private lastViewportTop: number | undefined;

  constructor(
    terminal: Terminal,
    showHardwareCursor = false,
    logDirectory?: string,
    options: TuiAltScreenOptions = {},
  ) {
    super(terminal, showHardwareCursor, logDirectory, { wheelScrollLines: 3, ...options });
    this.defaultFrameIntervalMs = resolveTuiFrameInterval();
    this.scrollFrameIntervalMs = resolveTuiScrollFrameInterval();
    this.framePacer = new TuiFramePacer(this.defaultFrameIntervalMs);
    this.scrollIntervalMs = resolveTuiScrollInterval();
  }

  override requestRender(force = false): void {
    if (!this.framePacer) {
      super.requestRender(force);
      return;
    }
    // Wheel input reaches ScrollView directly (routeWheel), bypassing
    // scrollBy(); detect viewport movement itself so any scroll source
    // (wheel, keys, scrollbar drag) opens the slower scroll cadence window.
    const viewportTop = this.viewportTop;
    if (this.lastViewportTop !== undefined && this.lastViewportTop !== viewportTop) {
      this.lastViewportTop = viewportTop;
      this.lastScrollAt = performance.now();
    } else if (this.lastViewportTop === undefined) {
      this.lastViewportTop = viewportTop;
    }
    const sinceScroll = performance.now() - this.lastScrollAt;
    const cadence = sinceScroll < SCROLL_FRAME_WINDOW_MS ? this.scrollFrameIntervalMs : this.defaultFrameIntervalMs;
    this.framePacer.setIntervalMs(cadence);
    this.framePacer.request(force, (nextForce) => super.requestRender(nextForce));
  }

  protected override doRender(): void {
    const started = process.env.VSPI_FRAME_STATS ? performance.now() : 0;
    super.doRender();
    if (started) recordFrameRenderMs(performance.now() - started);
  }

  override scrollBy(lines: number): void {
    const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
    if (requested === 0) return;
    this.pendingScrollLines += requested;
    if (this.scrollTimer) return;
    const delay = Math.max(0, this.scrollIntervalMs - (performance.now() - this.lastScrollAt));
    if (delay === 0) {
      this.flushScroll();
      return;
    }
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = undefined;
      this.flushScroll();
    }, delay);
    this.scrollTimer.unref();
  }

  override scrollToTop(): void {
    this.cancelScroll();
    super.scrollToTop();
  }

  override scrollToBottom(): void {
    this.cancelScroll();
    super.scrollToBottom();
  }

  private flushScroll(): void {
    const lines = this.pendingScrollLines;
    this.pendingScrollLines = 0;
    if (lines === 0) return;
    this.lastScrollAt = performance.now();
    super.scrollBy(lines);
  }

  private cancelScroll(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    this.pendingScrollLines = 0;
  }

  override stop(options: TuiStopOptions = {}): void {
    this.cancelScroll();
    this.framePacer?.cancel();
    super.stop(options);
  }
}
