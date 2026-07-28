import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preserveTerminalScrollback,
  renderStaticCommit,
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

  it("pushes a static block beyond the viewport before returning to a clean home position", () => {
    const output = renderStaticCommit(["splash-a", "splash-b"], 4);
    expect(output).not.toContain("\u001b[3J");
    expect(output).toContain("\u001b[2J\u001b[Hsplash-a\r\nsplash-b");
    expect(output.endsWith("\u001b[2J\u001b[H\u001b[?7h\u001b[?2026l")).toBe(true);
    expect(output.match(/\r\n/g)).toHaveLength(5);
    expect(renderStaticCommit([], 4)).toBe("");
  });

  it("resets pi-tui differential state and redraws live content after a static commit", async () => {
    vi.useFakeTimers();
    const terminal = new RecordingStaticTerminal();
    const tui = new ScrollbackTUI(terminal, true);
    tui.addChild({ render: () => ["live-frame"], invalidate() {} });
    tui.start();
    await vi.runAllTimersAsync();

    tui.commitStatic(["finished-turn"]);
    await vi.runAllTimersAsync();

    expect(terminal.commits).toEqual([["finished-turn"]]);
    const afterCommit = terminal.writes.slice(terminal.writes.findIndex((chunk) => chunk.includes("finished-turn")));
    expect(afterCommit.some((chunk) => chunk.includes("live-frame"))).toBe(true);
    expect(afterCommit.join("")).not.toContain("\u001b[3J");
    tui.stop();
  });
});
