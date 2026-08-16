import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adaptInteractiveTerminalOutput,
  preserveTerminalScrollback,
  renderStaticAppend,
  renderStaticCommit,
  renderStaticReplacement,
  renderSurfaceEpochBreak,
  ScrollbackTUI,
  type StaticCommitTerminal,
} from "../src/ui/scrollback-terminal.js";

class RecordingStaticTerminal implements StaticCommitTerminal {
  readonly columns = 20;
  readonly rows = 6;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  readonly commits: string[][] = [];

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(preserveTerminalScrollback(data));
  }
  commitStatic(lines: readonly string[]): void {
    this.commits.push([...lines]);
    this.write(renderStaticCommit(lines, this.rows));
  }
  appendStatic(lines: readonly string[]): void {
    this.commits.push([...lines]);
    this.write(renderStaticAppend(lines));
  }
  replaceStatic(lines: readonly string[]): void {
    this.write(renderStaticReplacement(lines, this.rows));
  }
  beginSurfaceEpoch(lineOffset = 0): void {
    this.write(renderSurfaceEpochBreak(lineOffset));
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scrollback-preserving terminal", () => {
  it("removes only CSI 3 J while preserving viewport clear and synchronized output", () => {
    const input = "\u001b[?2026h\u001b[2J\u001b[H\u001b[3Jframe\u001b[?2026l";
    expect(preserveTerminalScrollback(input)).toBe("\u001b[?2026h\u001b[2J\u001b[Hframe\u001b[?2026l");
  });

  it("leaves ordinary output unchanged", () => {
    expect(preserveTerminalScrollback("line\r\nnext")).toBe("line\r\nnext");
  });

  it("avoids per-frame synchronized flushes unless explicitly restored", () => {
    const frame = "\u001b[?2026h\u001b[12;1H\u001b[2Kframe\u001b[?2026l";
    expect(adaptInteractiveTerminalOutput(frame, {})).toBe("\u001b[12;1H\u001b[2Kframe");
    expect(adaptInteractiveTerminalOutput(frame, { VSPI_TUI_SYNC_OUTPUT: "1" })).toBe(frame);
  });

  it("pushes a static block beyond the viewport before returning to a clean home position", () => {
    const output = renderStaticCommit(["splash-a", "splash-b"], 4);
    expect(output).not.toContain("\u001b[3J");
    expect(output).toContain("\u001b[2J\u001b[Hsplash-a\r\nsplash-b");
    expect(output.endsWith("\u001b[2J\u001b[H\u001b[?7h\u001b[?2026l")).toBe(true);
    expect(output.match(/\r\n/g)).toHaveLength(5);
    expect(renderStaticCommit([], 4)).toBe("");
  });

  it("appends completed transcript without manufacturing a viewport of blank lines", () => {
    const output = renderStaticAppend(["turn-a", "turn-b"]);
    expect(output).toContain("\u001b[2J\u001b[Hturn-a\r\nturn-b\r\n");
    expect(output.match(/\r\n/g)).toHaveLength(2);
  });

  it("clears a previous Session without manufacturing a screen of blank scrollback", () => {
    const output = renderStaticReplacement([], 24);
    expect(output).toContain("\u001b[2J\u001b[H\u001b[3J");
    expect(output).not.toContain("\r\n");
  });

  it("starts an append-only surface epoch without clear or Home controls", () => {
    const output = renderSurfaceEpochBreak();
    expect(output).toBe("\u001b[?2026h\r\n\u001b[?2026l");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("\u001b[3J");
    expect(output).not.toContain("\u001b[H");
    expect(renderSurfaceEpochBreak(3)).toContain("\u001b[3B\r\n");
    expect(renderSurfaceEpochBreak(-2)).toContain("\u001b[2A\r\n");
  });

  it("renders the first frame after an epoch break without clearing the existing main screen", async () => {
    vi.useFakeTimers();
    const terminal = new RecordingStaticTerminal();
    const tui = new ScrollbackTUI(terminal, true);
    tui.addChild({ render: () => ["restored-session", "composer"], invalidate() {} });
    tui.start();
    await vi.runAllTimersAsync();

    const writesBefore = terminal.writes.length;
    tui.beginSurfaceEpoch();
    await vi.runAllTimersAsync();

    const output = terminal.writes.slice(writesBefore).join("");
    expect(output).toContain(renderSurfaceEpochBreak());
    expect(output).toContain("restored-session");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("\u001b[3J");
    expect(output).not.toContain("\u001b[H");
    tui.stop();
  });

  it("rebases an offscreen rendered prefix without clearing or rewriting the viewport", async () => {
    vi.useFakeTimers();
    const terminal = new RecordingStaticTerminal();
    const tui = new ScrollbackTUI(terminal, true);
    let frame = ["finished-turn", "tail-1", "tail-2", "tail-3", "tail-4", "tail-5", "live-frame"];
    tui.addChild({ render: () => frame, invalidate() {} });
    tui.start();
    await vi.runAllTimersAsync();

    const writesBefore = terminal.writes.length;
    frame = frame.slice(1);
    expect(tui.commitStatic(["finished-turn"])).toBe(true);
    await vi.runAllTimersAsync();

    expect(terminal.commits).toEqual([]);
    const afterCommit = terminal.writes.slice(writesBefore);
    expect(afterCommit).toEqual([]);
    expect(afterCommit.join("")).not.toContain("\u001b[2J");
    expect(afterCommit.join("")).not.toContain("\u001b[3J");
    expect(afterCommit.join("")).not.toContain("\u001b[H");
    tui.stop();
  });

  it("does not rebase a prefix that is still inside the visible viewport", async () => {
    vi.useFakeTimers();
    const terminal = new RecordingStaticTerminal();
    const tui = new ScrollbackTUI(terminal, true);
    tui.addChild({ render: () => ["visible-prefix", "live-frame"], invalidate() {} });
    tui.start();
    await vi.runAllTimersAsync();

    expect(tui.commitStatic(["visible-prefix"])).toBe(false);
    tui.stop();
  });
});
