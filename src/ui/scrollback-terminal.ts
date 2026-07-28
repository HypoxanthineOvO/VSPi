import { ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";

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

export class ScrollbackProcessTerminal extends ProcessTerminal implements StaticCommitTerminal {
  override write(data: string): void {
    super.write(preserveTerminalScrollback(data));
  }

  commitStatic(lines: readonly string[]): void {
    super.write(renderStaticCommit(lines, this.rows));
  }
}

export class ScrollbackTUI extends TUI {
  commitStatic(lines: readonly string[]): void {
    if (lines.length === 0) return;
    (this.terminal as StaticCommitTerminal).commitStatic(lines);
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
