import { type Terminal, TuiAltScreen, type TuiAltScreenOptions, type TuiStopOptions } from "@earendil-works/pi-tui";

export const DEFAULT_TUI_FRAME_INTERVAL_MS = 33;
export const DEFAULT_TUI_SCROLL_INTERVAL_MS = 100;

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

export class TuiFramePacer {
  private timer: NodeJS.Timeout | undefined;
  private lastForwardedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs: number) {}

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
  private readonly scrollIntervalMs: number;
  private pendingScrollLines = 0;
  private scrollTimer: NodeJS.Timeout | undefined;
  private lastScrollAt = Number.NEGATIVE_INFINITY;

  constructor(
    terminal: Terminal,
    showHardwareCursor = false,
    logDirectory?: string,
    options: TuiAltScreenOptions = {},
  ) {
    super(terminal, showHardwareCursor, logDirectory, { wheelScrollLines: 3, ...options });
    this.framePacer = new TuiFramePacer(resolveTuiFrameInterval());
    this.scrollIntervalMs = resolveTuiScrollInterval();
  }

  override requestRender(force = false): void {
    if (!this.framePacer) {
      super.requestRender(force);
      return;
    }
    this.framePacer.request(force, (nextForce) => super.requestRender(nextForce));
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
