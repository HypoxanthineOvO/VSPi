import { ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.js";

const CLEAR_SCROLLBACK = "\u001b[3J";
const BEGIN_SYNC = "\u001b[?2026h";
const END_SYNC = "\u001b[?2026l";
const DISABLE_AUTOWRAP = "\u001b[?7l";
const ENABLE_AUTOWRAP = "\u001b[?7h";
const CLEAR_VIEWPORT_HOME = "\u001b[2J\u001b[H";

interface TuiRenderState {
  previousLines: string[];
  previousKittyImageIds: Set<number>;
  previousWidth: number;
  previousHeight: number;
  cursorRow: number;
  hardwareCursorRow: number;
  maxLinesRendered: number;
  previousViewportTop: number;
}

export interface StaticCommitTerminal extends Terminal {
  commitStatic(lines: readonly string[]): void;
  appendStatic(lines: readonly string[]): void;
  replaceStatic(lines: readonly string[]): void;
  beginSurfaceEpoch(lineOffset?: number): void;
}

export function preserveTerminalScrollback(chunk: string): string {
  return chunk.split(CLEAR_SCROLLBACK).join("");
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
  override write(data: string): void {
    super.write(preserveTerminalScrollback(data));
  }

  commitStatic(lines: readonly string[]): void {
    super.write(renderStaticCommit(lines, this.rows));
  }

  appendStatic(lines: readonly string[]): void {
    super.write(renderStaticAppend(lines));
  }

  replaceStatic(lines: readonly string[]): void {
    super.write(renderStaticReplacement(lines, this.rows));
  }

  beginSurfaceEpoch(lineOffset = 0): void {
    super.write(renderSurfaceEpochBreak(lineOffset));
  }
}

export class ScrollbackTUI extends TUI {
  constructor(terminal: Terminal, showHardwareCursor = true, logDirectory?: string) {
    super(terminal, showHardwareCursor, logDirectory);
    this.setClearOnShrink(false);
  }

  commitStatic(lines: readonly string[]): boolean {
    if (lines.length === 0) return false;
    const state = this as unknown as TuiRenderState;
    if (lines.length > state.previousViewportTop || lines.length > state.previousLines.length) return false;
    for (const [index, line] of lines.entries()) {
      if (stripAnsi(state.previousLines[index] ?? "") !== stripAnsi(line)) return false;
    }

    state.previousLines = state.previousLines.slice(lines.length);
    state.cursorRow = Math.max(0, state.cursorRow - lines.length);
    state.hardwareCursorRow = Math.max(0, state.hardwareCursorRow - lines.length);
    state.maxLinesRendered = Math.max(0, state.maxLinesRendered - lines.length);
    state.previousViewportTop = Math.max(0, state.previousViewportTop - lines.length);
    this.requestRender();
    return true;
  }

  replaceStatic(lines: readonly string[]): void {
    (this.terminal as StaticCommitTerminal).replaceStatic(lines);
    this.resetRenderState();
  }

  beginSurfaceEpoch(): void {
    const state = this as unknown as TuiRenderState;
    const finalRow = Math.max(0, state.previousLines.length - 1);
    const lineOffset = finalRow - state.hardwareCursorRow;
    const terminal = this.terminal as Partial<StaticCommitTerminal>;
    terminal.beginSurfaceEpoch?.(lineOffset);
    this.resetRenderState();
  }

  private resetRenderState(): void {
    const state = this as unknown as TuiRenderState;
    state.previousLines = [];
    state.previousKittyImageIds = new Set();
    state.previousWidth = 0;
    state.previousHeight = 0;
    state.cursorRow = 0;
    state.hardwareCursorRow = 0;
    state.maxLinesRendered = 0;
    state.previousViewportTop = 0;
    this.requestRender();
  }
}
