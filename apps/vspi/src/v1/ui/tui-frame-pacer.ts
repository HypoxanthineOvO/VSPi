import { type Terminal, TuiAltScreen, type TuiAltScreenOptions, type TuiStopOptions } from "@moonshot-ai/pi-tui";
import { type ScrollbackProcessTerminal, recordFrameRenderMs } from "./scrollback-terminal.js";
import { writeClipboardText } from '../attachments/clipboard.js';

export const DEFAULT_TUI_FRAME_INTERVAL_MS = 33;
// Main-screen resize rebuilds wait for the drag to settle so a burst of
// reported sizes produces a single history rebuild.
export const TUI_RESIZE_SETTLE_MS = 300;

export function resolveTuiFrameInterval(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.VSPI_TUI_FRAME_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TUI_FRAME_INTERVAL_MS;
  return Math.max(16, Math.min(250, Math.floor(configured)));
}

export class TuiFramePacer {
  private timer: NodeJS.Timeout | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private lastForwardedAt = Number.NEGATIVE_INFINITY;

  constructor(private intervalMs: number) {}

  requestInput(forward: () => void): void {
    if (this.resizeTimer || this.settleTimer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lastForwardedAt = performance.now();
    forward();
  }

  requestResize(forward: (force: boolean) => void): void {
    this.cancel();
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.request(false, forward);
    }, 100);
    this.resizeTimer.unref();
  }

  /** Rearm on every call; the callback fires once after `delayMs` of quiet. */
  requestSettle(settled: () => void, delayMs = TUI_RESIZE_SETTLE_MS): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      settled();
    }, delayMs);
    this.settleTimer.unref();
  }

  /** Pause/stop teardown only: cancel() must not kill an armed settle, or a
   * force render during the settle window would strand a deferred rebuild. */
  cancelSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  request(force: boolean, forward: (force: boolean) => void): void {
    if (this.resizeTimer && !force) return;
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
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class VspiTuiAltScreen extends TuiAltScreen {
  private framePacer: TuiFramePacer | undefined;

  constructor(
    terminal: Terminal,
    showHardwareCursor = false,
    logDirectory?: string,
    options: TuiAltScreenOptions = {},
  ) {
    super(terminal, showHardwareCursor, logDirectory, { wheelScrollLines: 3,
      copySelection: async text => {
        try { await writeClipboardText(text, { writeTerminal: sequence => { terminal.write(sequence); } }); return true; }
        catch { return false; }
      }, ...options });
    this.framePacer = new TuiFramePacer(resolveTuiFrameInterval());
  }

  override requestRender(force = false): void {
    if (!this.framePacer) {
      super.requestRender(force);
      return;
    }
    this.framePacer.request(force, (nextForce) => super.requestRender(nextForce));
  }

  protected override requestResizeRender(): void {
    this.framePacer?.requestResize((force) => super.requestRender(force));
  }

  protected override requestInputRender(): void {
    this.framePacer?.requestInput(() => { super.requestInputRender(); });
  }

  protected override doRender(): void {
    if ((this.terminal as Partial<ScrollbackProcessTerminal>).deferRender?.(() => this.requestRender())) return;
    const started = process.env.VSPI_FRAME_STATS ? performance.now() : 0;
    super.doRender();
    if (started) recordFrameRenderMs(performance.now() - started);
  }

  override scrollBy(lines: number): void {
    const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
    if (requested === 0) return;
    super.scrollBy(requested);
    this.requestInputRender();
  }

  override scrollToTop(): void {
    super.scrollToTop();
    this.requestInputRender();
  }

  override scrollToBottom(): void {
    super.scrollToBottom();
    this.requestInputRender();
  }

  override pauseRendering(): void {
    this.framePacer?.cancel();
    this.framePacer?.cancelSettle();
    super.pauseRendering();
  }

  override stop(options: TuiStopOptions = {}): void {
    this.framePacer?.cancel();
    this.framePacer?.cancelSettle();
    super.stop(options);
  }
}
