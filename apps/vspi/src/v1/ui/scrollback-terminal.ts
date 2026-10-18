import { appendFileSync } from "node:fs";
import { ProcessTerminal, type Terminal, TuiMainScreen } from "@moonshot-ai/pi-tui";
import { stripAnsi } from "./ansi.js";
import { TerminalFrameOptimizer } from "./terminal-frame-optimizer.js";
import { resolveTuiFrameInterval, TuiFramePacer } from "./tui-frame-pacer.js";

const CLEAR_SCROLLBACK = "\u001b[3J";
const BEGIN_SYNC = "\u001b[?2026h";
const END_SYNC = "\u001b[?2026l";
const FOCUS_IN = "\u001b[I";
const FOCUS_OUT = "\u001b[O";

export interface StaticCommitTerminal extends Terminal {
  beginSurfaceEpoch(lineOffset?: number): void;
}

export function preserveTerminalScrollback(chunk: string): string {
  return chunk.split(CLEAR_SCROLLBACK).join("");
}

export function adaptInteractiveTerminalOutput(chunk: string, env: NodeJS.ProcessEnv = process.env): string {
  const preserved = preserveTerminalScrollback(chunk);
  if (env.VSPI_TUI_SYNC_OUTPUT !== "0") return preserved;
  return preserved.split(BEGIN_SYNC).join("").split(END_SYNC).join("");
}

export function renderSurfaceEpochBreak(lineOffset = 0): string {
  const move = lineOffset > 0 ? `\u001b[${lineOffset}B` : lineOffset < 0 ? `\u001b[${-lineOffset}A` : "";
  return `${BEGIN_SYNC}${move}\r\n${END_SYNC}`;
}

export class ScrollbackProcessTerminal extends ProcessTerminal implements StaticCommitTerminal {
  private readonly frameOptimizer = new TerminalFrameOptimizer();
  private reloadHandoff = false;
  private pendingRender: (() => void) | undefined;
  private readonly resumeRender = () => {
    const render = this.pendingRender;
    this.pendingRender = undefined;
    render?.();
  };

  deferRender(render: () => void): boolean {
    if (!process.stdout.writableNeedDrain) return false;
    if (!this.pendingRender) process.stdout.once("drain", this.resumeRender);
    this.pendingRender = render;
    return true;
  }

  /**
   * /reload 静默移交：续接进程已 spawn 并即将接管同一 TTY。
   *
   * raw mode 是 PTY 的设备级属性：本进程退出路径的 stop() 会执行
   * setRawMode(wasRaw) 恢复 cooked + ECHO；若此刻续接进程已完成自己的
   * setRawMode(true)，终端就被打回 cooked——按键被内核回显为控制记法
   * （^[ 乱码）并被行缓冲吞掉，表现为 reload 后无法输入。因此移交后：
   * 停止读取 stdin，后续 stop()/drainInput() 不再恢复终端模式，
   * termios 与终端状态完全交由续接进程管理。
   */
  prepareReloadHandoff(): void {
    if (this.reloadHandoff) return;
    this.reloadHandoff = true;
    const internals = this as unknown as {
      stdinDataHandler?: (data: string) => void;
      inputHandler?: unknown;
    };
    if (internals.stdinDataHandler) process.stdin.removeListener("data", internals.stdinDataHandler);
    internals.inputHandler = undefined;
    process.stdin.pause();
  }

  override stop(): void {
    process.stdout.removeListener("drain", this.resumeRender);
    this.pendingRender = undefined;
    // 静默移交后不写恢复序列、不恢复 termios（见 prepareReloadHandoff）。
    if (this.reloadHandoff) return;
    super.stop();
  }

  override drainInput(): Promise<void> {
    // 静默移交后不重新挂输入监听、不发键盘协议复位序列。
    if (this.reloadHandoff) return Promise.resolve();
    return super.drainInput();
  }

  override write(data: string): void {
    super.write(adaptInteractiveTerminalOutput(this.frameOptimizer.optimize(data, this.rows, this.columns)));
  }


  beginSurfaceEpoch(lineOffset = 0): void {
    this.frameOptimizer.invalidateTail();
    super.write(renderSurfaceEpochBreak(lineOffset));
  }
}

// C16 M3: per-frame render latency samples without screen content. Enable
// with VSPI_FRAME_STATS=<path>; each JSON line is {t, ms} for one doRender.
const FRAME_STATS_PATH = process.env.VSPI_FRAME_STATS || "";
let frameStatsBuffer: string[] = [];
let frameStatsLastFlush = 0;

export function recordFrameRenderMs(ms: number): void {
  if (!FRAME_STATS_PATH) return;
  frameStatsBuffer.push(`{"t":${Math.round(performance.now())},"ms":${+ms.toFixed(2)}}`);
  const now = performance.now();
  if (now - frameStatsLastFlush < 1000 && frameStatsBuffer.length < 512) return;
  frameStatsLastFlush = now;
  try {
    appendFileSync(FRAME_STATS_PATH, `${frameStatsBuffer.join("\n")}\n`, "utf8");
  } catch {
    // diagnostics only; never break rendering on stats failure
  }
  frameStatsBuffer = [];
}

export class ScrollbackTUI extends TuiMainScreen {
  private framePacer: TuiFramePacer | undefined;
  private clearingDeferred = false;
  /** Runs synchronously after every rendered frame so the host can freeze scrolled-off rows. */
  onFrameRendered: (() => void) | undefined;
  /** Runs after resize or a clearing fallback settles; the host preserves the old frame. */
  onRebuildSettled: ((reason: string) => void) | undefined;

  constructor(terminal: Terminal, showHardwareCursor = true, logDirectory?: string) {
    super(terminal, showHardwareCursor, logDirectory);
    this.framePacer = new TuiFramePacer(resolveTuiFrameInterval());
    this.setClearOnShrink(false);
    // Some terminals can report focus after switching away from fullscreen.
    // Treat those reports as terminal metadata, not latency-sensitive user input.
    this.addInputListener(data => data === FOCUS_IN || data === FOCUS_OUT ? { consume: true } : undefined);
  }

  private rebuildSettleArmed = false;

  /**
   * Arm the rebuild settle timer. Resize events re-arm it so a drag rebuilds
   * once after the size settles; deferred frames only arm it, otherwise a
   * busy stream of deferred renders would starve the rebuild indefinitely.
   */
  private armRebuildSettle(reason: string, rearm: boolean): void {
    if (this.rebuildSettleArmed && !rearm) return;
    this.rebuildSettleArmed = true;
    this.framePacer?.requestSettle(() => {
      this.rebuildSettleArmed = false;
      this.onRebuildSettled?.(reason);
    });
  }

  protected override deferClearingRedraw(reason: string): boolean {
    // The host opens a new native surface instead of clearing; coalesce bursts through
    // the same settle timer as resize drags.
    this.clearingDeferred = true;
    this.armRebuildSettle(reason, false);
    return true;
  }

  protected override requestResizeRender(): void {
    // Resize drags report a stream of sizes; rebuild once after the size settles.
    this.armRebuildSettle("resize", true);
  }

  protected override requestInputRender(): void {
    this.requestRender();
  }

  protected override doRender(): void {
    if ((this.terminal as Partial<ScrollbackProcessTerminal>).deferRender?.(() => this.requestRender())) return;
    const previous = this.captureRenderState();
    if (previous.previousWidth > 0 && (previous.previousWidth !== this.terminal.columns || previous.previousHeight !== this.terminal.rows)) {
      this.deferClearingRedraw("resize");
      return;
    }
    const started = FRAME_STATS_PATH ? performance.now() : 0;
    // A deferred clearing redraw leaves the render state pinned to the
    // pre-resize frame; the host's per-node row ranges no longer match it, so
    // freeze bookkeeping must wait for the next committed frame.
    this.clearingDeferred = false;
    super.doRender();
    if (FRAME_STATS_PATH) recordFrameRenderMs(performance.now() - started);
    if (!this.clearingDeferred) this.onFrameRendered?.();
  }

  override renderNow(force = false): void {
    if (force && this.framePacer && this.captureRenderState().previousWidth > 0) {
      this.armRebuildSettle("force", false);
      return;
    }
    super.renderNow(force);
  }

  override requestRender(force = false): void {
    if (force && this.framePacer && this.captureRenderState().previousWidth > 0) {
      this.armRebuildSettle("force", false);
      return;
    }
    if (!this.framePacer) {
      super.requestRender(force);
      return;
    }
    this.framePacer.request(force, (nextForce) => super.requestRender(nextForce));
  }

  override pauseRendering(): void {
    this.framePacer?.cancel();
    this.framePacer?.cancelSettle();
    this.rebuildSettleArmed = false;
    super.pauseRendering();
  }

  override stop(options = {}): void {
    this.framePacer?.cancel();
    this.framePacer?.cancelSettle();
    this.rebuildSettleArmed = false;
    super.stop(options);
  }

  commitStatic(lines: readonly string[]): boolean {
    if (lines.length === 0) return false;
    const state = this.captureRenderState();
    if (lines.length > state.previousViewportTop || lines.length > state.previousLines.length) return false;
    for (const [index, line] of lines.entries()) {
      if (stripAnsi(state.previousLines[index] ?? "") !== stripAnsi(line)) return false;
    }

    this.restoreRenderState({
      ...state,
      previousLines: state.previousLines.slice(lines.length),
      cursorRow: Math.max(0, state.cursorRow - lines.length),
      hardwareCursorRow: Math.max(0, state.hardwareCursorRow - lines.length),
      maxLinesRendered: Math.max(0, state.maxLinesRendered - lines.length),
      previousViewportTop: Math.max(0, state.previousViewportTop - lines.length),
    });
    this.requestRender();
    return true;
  }


  preserveViewportEpoch(): void {
    this.terminal.write(`${BEGIN_SYNC}\u001b[${Math.max(1, this.terminal.rows)};1H\r\n${END_SYNC}`);
    this.resetScrollbackRenderState();
  }

  reflowViewport(): void {
    this.preserveViewportEpoch();
  }


  beginSurfaceEpoch(): void {
    const state = this.captureRenderState();
    const finalRow = Math.max(0, state.previousLines.length - 1);
    const lineOffset = finalRow - state.hardwareCursorRow;
    const terminal = this.terminal as Partial<StaticCommitTerminal>;
    terminal.beginSurfaceEpoch?.(lineOffset);
    this.resetScrollbackRenderState();
  }

  private resetScrollbackRenderState(): void {
    // A new append-only epoch is a first render on the existing main screen.
    // Pi 0.84's resetRenderState() uses -1 dimensions to request a clearing
    // redraw, which would erase native scrollback during Resume.
    this.restoreRenderState({
      previousLines: [],
      previousWidth: 0,
      previousHeight: 0,
      cursorRow: 0,
      hardwareCursorRow: 0,
      maxLinesRendered: 0,
      previousViewportTop: 0,
    });
    this.requestRender();
  }
}
