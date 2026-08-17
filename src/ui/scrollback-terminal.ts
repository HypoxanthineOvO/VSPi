import { appendFileSync } from "node:fs";
import { ProcessTerminal, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.js";
import { TerminalFrameOptimizer } from "./terminal-frame-optimizer.js";
import { resolveTuiFrameInterval, TuiFramePacer } from "./tui-frame-pacer.js";

const CLEAR_SCROLLBACK = "\u001b[3J";
const BEGIN_SYNC = "\u001b[?2026h";
const END_SYNC = "\u001b[?2026l";
const DISABLE_AUTOWRAP = "\u001b[?7l";
const ENABLE_AUTOWRAP = "\u001b[?7h";
const CLEAR_VIEWPORT_HOME = "\u001b[2J\u001b[H";

export interface StaticCommitTerminal extends Terminal {
  commitStatic(lines: readonly string[]): void;
  appendStatic(lines: readonly string[]): void;
  replaceStatic(lines: readonly string[]): void;
  beginSurfaceEpoch(lineOffset?: number): void;
}

export function preserveTerminalScrollback(chunk: string): string {
  return chunk.split(CLEAR_SCROLLBACK).join("");
}

export function adaptInteractiveTerminalOutput(chunk: string, env: NodeJS.ProcessEnv = process.env): string {
  const preserved = preserveTerminalScrollback(chunk);
  if (env.VSPI_TUI_SYNC_OUTPUT === "1") return preserved;
  return preserved.split(BEGIN_SYNC).join("").split(END_SYNC).join("");
}

export function renderStaticCommit(lines: readonly string[], rows: number): string {
  if (lines.length === 0) return "";
  const height = Math.max(1, Math.floor(rows));
  const content = lines.join("\r\n");
  return `${BEGIN_SYNC}${DISABLE_AUTOWRAP}${CLEAR_VIEWPORT_HOME}${content}${"\r\n".repeat(height)}${CLEAR_VIEWPORT_HOME}${ENABLE_AUTOWRAP}${END_SYNC}`;
}

export function renderStaticAppend(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const content = lines.join("\r\n");
  return `${BEGIN_SYNC}${DISABLE_AUTOWRAP}${CLEAR_VIEWPORT_HOME}${content}\r\n${ENABLE_AUTOWRAP}${END_SYNC}`;
}

export function renderStaticReplacement(lines: readonly string[], rows: number): string {
  if (lines.length === 0) {
    return `${BEGIN_SYNC}${DISABLE_AUTOWRAP}${CLEAR_VIEWPORT_HOME}${CLEAR_SCROLLBACK}${ENABLE_AUTOWRAP}${END_SYNC}`;
  }
  const height = Math.max(1, Math.floor(rows));
  const content = lines.join("\r\n");
  return `${BEGIN_SYNC}${DISABLE_AUTOWRAP}${CLEAR_VIEWPORT_HOME}${CLEAR_SCROLLBACK}${content}${"\r\n".repeat(height)}${CLEAR_VIEWPORT_HOME}${ENABLE_AUTOWRAP}${END_SYNC}`;
}

export function renderSurfaceEpochBreak(lineOffset = 0): string {
  const move = lineOffset > 0 ? `\u001b[${lineOffset}B` : lineOffset < 0 ? `\u001b[${-lineOffset}A` : "";
  return `${BEGIN_SYNC}${move}\r\n${END_SYNC}`;
}

export class ScrollbackProcessTerminal extends ProcessTerminal implements StaticCommitTerminal {
  private readonly frameOptimizer = new TerminalFrameOptimizer();

  override write(data: string): void {
    super.write(adaptInteractiveTerminalOutput(this.frameOptimizer.optimize(data, this.rows, this.columns)));
  }

  commitStatic(lines: readonly string[]): void {
    this.frameOptimizer.invalidateTail();
    super.write(renderStaticCommit(lines, this.rows));
  }

  appendStatic(lines: readonly string[]): void {
    this.frameOptimizer.invalidateTail();
    super.write(renderStaticAppend(lines));
  }

  replaceStatic(lines: readonly string[]): void {
    this.frameOptimizer.invalidateTail();
    super.write(renderStaticReplacement(lines, this.rows));
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

  constructor(terminal: Terminal, showHardwareCursor = true, logDirectory?: string) {
    super(terminal, showHardwareCursor, logDirectory);
    this.framePacer = new TuiFramePacer(resolveTuiFrameInterval());
    this.setClearOnShrink(false);
  }

  protected override doRender(): void {
    const started = FRAME_STATS_PATH ? performance.now() : 0;
    super.doRender();
    if (FRAME_STATS_PATH) recordFrameRenderMs(performance.now() - started);
  }

  override requestRender(force = false): void {
    if (!this.framePacer) {
      super.requestRender(force);
      return;
    }
    this.framePacer.request(force, (nextForce) => super.requestRender(nextForce));
  }

  override stop(options = {}): void {
    this.framePacer?.cancel();
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

  replaceStatic(lines: readonly string[]): void {
    (this.terminal as StaticCommitTerminal).replaceStatic(lines);
    this.resetScrollbackRenderState();
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
