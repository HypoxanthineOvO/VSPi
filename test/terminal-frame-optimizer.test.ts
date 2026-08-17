import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TerminalFrameOptimizer } from "../src/ui/terminal-frame-optimizer.js";

const ENTER = "\u001b[?1049h\u001b[?7l";
const BEGIN = "\u001b[?2026h";
const END = "\u001b[?2026l";

function frame(
  lines: string[],
  changedRows = lines.map((_, index) => index),
  extra = "",
  cursor = "\u001b[1;1H",
): string {
  const updates = changedRows.map((row) => `\u001b[${row + 1};1H\u001b[2K${lines[row] ?? ""}`).join("");
  return `${BEGIN}${extra}${updates}${cursor}\u001b[?25l${END}`;
}

function replay(chunks: string[], rows: number, columns = 80): object {
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
  const core = (terminal as unknown as { _core: { writeSync(data: string): void } })._core;
  for (const chunk of chunks) core.writeSync(chunk);
  const buffer = terminal.buffer.active;
  const result = {
    lines: Array.from({ length: rows }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? ""),
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    modes: terminal.modes,
  };
  terminal.dispose();
  return result;
}

function optimize(chunks: string[], rows: number): string[] {
  const optimizer = new TerminalFrameOptimizer();
  return chunks.map((chunk) => optimizer.optimize(chunk, rows));
}

describe("terminal frame optimizer", () => {
  it("uses native scroll-up while preserving the final screen and dock", () => {
    const before = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "dock-a", "dock-b"];
    const after = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "dock-a", "dock-b"];
    const chunks = [ENTER, frame(before, undefined, "\u001b[2J"), frame(after, [0, 1, 2, 3, 4, 5, 6, 7])];
    const optimized = optimize(chunks, 10);

    expect(optimized[2]).toContain("\u001b[1;8r");
    expect(optimized[2]).toContain("\u001b[1S");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Count terminal row-update control sequences.
    expect(optimized[2]?.match(/\u001b\[\d+;1H\u001b\[2K/gu)).toHaveLength(1);
    expect(replay(optimized, 10, 10)).toEqual(replay(chunks, 10, 10));
  });

  it("uses native scroll-down and repaints a simultaneously changed dock", () => {
    const before = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "dock-a", "dock-b"];
    const after = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "dock-new", "dock-b"];
    const chunks = [ENTER, frame(before, undefined, "\u001b[2J"), frame(after, [0, 1, 2, 3, 4, 5, 6, 7, 8])];
    const optimized = optimize(chunks, 10);

    expect(optimized[2]).toContain("\u001b[1;8r");
    expect(optimized[2]).toContain("\u001b[1T");
    expect(optimized[2]).toContain("dock-new");
    expect(replay(optimized, 10)).toEqual(replay(chunks, 10));
  });

  it("ignores the independent scrollbar column when detecting a content shift", () => {
    const withScrollbar = (text: string, marker: string) => `${text.padEnd(9)}\u001b[100m${marker}\u001b[49m`;
    const before = [
      withScrollbar("A0", "."),
      withScrollbar("A1", "."),
      withScrollbar("A2", "#"),
      withScrollbar("A3", "#"),
      withScrollbar("A4", "."),
      withScrollbar("A5", "."),
      withScrollbar("A6", "."),
      withScrollbar("A7", "."),
      "dock-a",
      "dock-b",
    ];
    const after = [
      withScrollbar("A1", "."),
      withScrollbar("A2", "."),
      withScrollbar("A3", "."),
      withScrollbar("A4", "#"),
      withScrollbar("A5", "#"),
      withScrollbar("A6", "."),
      withScrollbar("A7", "."),
      withScrollbar("A8", "."),
      "dock-a",
      "dock-b",
    ];
    const chunks = [ENTER, frame(before, undefined, "\u001b[2J"), frame(after, [0, 1, 2, 3, 4, 5, 6, 7])];
    const optimizer = new TerminalFrameOptimizer();
    const optimized = chunks.map((chunk) => optimizer.optimize(chunk, 10, 10));

    expect(optimized[2]).toContain("\u001b[1S");
    expect(replay(optimized, 10, 10)).toEqual(replay(chunks, 10, 10));
  });

  it("detects a large shift inside fixed top and bottom regions", () => {
    const body = Array.from({ length: 28 }, (_, index) => `A${index}`);
    const before = ["fixed-header", ...body.slice(0, 26), "fixed-dock"];
    const after = [
      "fixed-header",
      ...body.slice(12, 28),
      ...Array.from({ length: 10 }, (_, index) => `B${index}`),
      "fixed-dock",
    ];
    const changedRows = Array.from({ length: 26 }, (_, index) => index + 1);
    const chunks = [ENTER, frame(before, undefined, "\u001b[2J"), frame(after, changedRows)];
    const optimized = optimize(chunks, 28);

    expect(optimized[2]).toContain("\u001b[2;27r");
    expect(optimized[2]).toContain("\u001b[12S");
    expect(replay(optimized, 28)).toEqual(replay(chunks, 28));
  });

  it("falls back for full redraws, images, and frames without a profitable shift", () => {
    const lines = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "dock-a", "dock-b"];
    const optimizer = new TerminalFrameOptimizer();
    expect(optimizer.optimize(ENTER, 10)).toBe(ENTER);
    const initial = frame(lines, undefined, "\u001b[2J");
    expect(optimizer.optimize(initial, 10)).toBe(initial);
    const image = `${BEGIN}\u001b[1;1H\u001b[2K\u001b_Ga=T;payload\u001b\\\u001b[?25l${END}`;
    expect(optimizer.optimize(image, 10)).toBe(image);
    const shifted = frame([...lines.slice(1, 8), "A8", "dock-a", "dock-b"], [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(optimizer.optimize(shifted, 10)).toBe(shifted);
    optimizer.optimize(initial, 10, 80);
    expect(optimizer.optimize(shifted, 10, 40)).toBe(shifted);
    optimizer.optimize(initial, 10, 80);
    const implicitCursorShift = frame(
      [...lines.slice(1, 8), "A8", "dock-a", "dock-b"],
      [0, 1, 2, 3, 4, 5, 6, 7],
      "",
      "",
    );
    expect(optimizer.optimize(implicitCursorShift, 10, 80)).toBe(implicitCursorShift);
    const changed = frame(["B0", ...lines.slice(1)], [0]);
    expect(optimizer.optimize(changed, 10)).toBe(changed);
  });

  it("drops repeated pure cursor frames and re-emits them after state changes", () => {
    const optimizer = new TerminalFrameOptimizer();
    optimizer.optimize(ENTER, 10);
    const content = frame(
      ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "dock-a", "dock-b"],
      undefined,
      "\u001b[2J",
      "\u001b[10;5H",
    );
    optimizer.optimize(content, 10);
    const tail = "\u001b[10;5H\u001b[?25h";
    const emptyFrame = `${BEGIN}${tail}${END}`;
    expect(optimizer.optimize(emptyFrame, 10)).toBe(emptyFrame);
    expect(optimizer.optimize(emptyFrame, 10)).toBe("");
    expect(optimizer.optimize(emptyFrame, 10)).toBe("");
    // A frame whose tail differs (cursor visibility flip) must pass through.
    const hiddenTail = `${BEGIN}\u001b[10;5H\u001b[?25l${END}`;
    expect(optimizer.optimize(hiddenTail, 10)).toBe(hiddenTail);
    expect(optimizer.optimize(hiddenTail, 10)).toBe("");
    // After an untracked write (static commit) the next pure tail frame is
    // forwarded again because the cursor state can no longer be assumed.
    optimizer.invalidateTail();
    expect(optimizer.optimize(hiddenTail, 10)).toBe(hiddenTail);
    // After a full redraw the tracking resets as well.
    const redraw = ["C0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "dock-a", "dock-b"];
    optimizer.optimize(frame(redraw, undefined, "\u001b[2J", "\u001b[10;5H"), 10);
    expect(optimizer.optimize(`${BEGIN}${tail}${END}`, 10)).toBe(`${BEGIN}${tail}${END}`);
  });

  it("drops pure cursor frames whose tail matches a preceding row-update frame", () => {
    const optimizer = new TerminalFrameOptimizer();
    optimizer.optimize(ENTER, 10);
    optimizer.optimize(
      frame(
        ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "dock-a", "dock-b"],
        undefined,
        "\u001b[2J",
        "\u001b[10;5H",
      ),
      10,
    );
    const updated = frame(
      ["B7", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "dock-a", "dock-b"],
      [0],
      "",
      "\u001b[10;5H",
    );
    expect(optimizer.optimize(updated, 10)).toBe(updated);
    // Same tail as the row-update frame above: the follow-up no-op is dropped.
    const repeat = `${BEGIN}\u001b[10;5H\u001b[?25l${END}`;
    expect(optimizer.optimize(repeat, 10)).toBe("");
  });
});
