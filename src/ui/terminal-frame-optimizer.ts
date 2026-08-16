import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";

const ENTER_ALT_SCREEN = "\u001b[?1049h";
const EXIT_ALT_SCREEN = "\u001b[?1049l";
const BEGIN_SYNC = "\u001b[?2026h";
const END_SYNC = "\u001b[?2026l";
const FULL_REDRAW = "\u001b[2J";
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const ROW_UPDATE = /\u001b\[(\d+);1H\u001b\[2K/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const CURSOR_TAIL = /(?:\u001b\[\d+;\d+H)?\u001b\[\?25[hl]\u001b\[\?2026l$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const IMAGE_SEQUENCE = /\u001b(?:_G|Pq)|\u001b\]1337;(?:File|MultipartFile)=/u;

interface ParsedFrame {
  prefix: string;
  suffix: string;
  updates: Map<number, string>;
  fullRedraw: boolean;
  explicitCursor: boolean;
}

interface ShiftCandidate {
  direction: "up" | "down";
  amount: number;
  regionStart: number;
  regionEnd: number;
  rewrites: number[];
}

function parseFrame(data: string, rows: number): ParsedFrame | undefined {
  if (!data.includes(BEGIN_SYNC) || !data.endsWith(END_SYNC) || IMAGE_SEQUENCE.test(data)) return undefined;
  const matches = [...data.matchAll(ROW_UPDATE)];
  if (matches.length === 0) return undefined;
  const tailMatch = CURSOR_TAIL.exec(data);
  if (!tailMatch || tailMatch.index === undefined) return undefined;
  const updates = new Map<number, string>();
  for (const [index, match] of matches.entries()) {
    const row = Number(match[1]) - 1;
    if (!Number.isInteger(row) || row < 0 || row >= rows || match.index === undefined) return undefined;
    const payloadStart = match.index + match[0].length;
    const payloadEnd = matches[index + 1]?.index ?? tailMatch.index;
    if (payloadEnd < payloadStart) return undefined;
    updates.set(row, data.slice(payloadStart, payloadEnd));
  }
  const tail = tailMatch[0];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI cursor positioning is the protocol being parsed.
  const hasExplicitCursor = /^\u001b\[\d+;\d+H/u.test(tail);
  return {
    prefix: data.slice(0, matches[0]?.index ?? 0),
    suffix: data.slice(tailMatch.index),
    updates,
    fullRedraw: data.includes(FULL_REDRAW),
    explicitCursor: hasExplicitCursor,
  };
}

function applyUpdates(previous: string[], frame: ParsedFrame, rows: number): string[] {
  const next = frame.fullRedraw ? Array.from({ length: rows }, () => "") : [...previous];
  while (next.length < rows) next.push("");
  next.length = rows;
  for (const [row, line] of frame.updates) next[row] = line;
  return next;
}

function simulateShift(
  previous: string[],
  rows: number,
  direction: "up" | "down",
  amount: number,
  start: number,
  end: number,
) {
  const simulated = [...previous];
  if (direction === "up") {
    for (let row = start; row < end - amount; row += 1) simulated[row] = previous[row + amount] ?? "";
    for (let row = end - amount; row < end; row += 1) simulated[row] = "";
  } else {
    for (let row = end - 1; row >= start + amount; row -= 1) simulated[row] = previous[row - amount] ?? "";
    for (let row = start; row < start + amount; row += 1) simulated[row] = "";
  }
  simulated.length = rows;
  return simulated;
}

function findShift(
  previous: string[],
  next: string[],
  originalRewrites: number,
  columns: number,
): ShiftCandidate | undefined {
  const rows = next.length;
  const minimumRun = 6;
  const contentWidth = Math.max(1, columns - 1);
  const comparablePrevious = previous.map((line) => stripTerminalSequences(sliceByColumn(line, 0, contentWidth, true)));
  const comparableNext = next.map((line) => stripTerminalSequences(sliceByColumn(line, 0, contentWidth, true)));
  const candidates: ShiftCandidate[] = [];
  const addRuns = (direction: "up" | "down", amount: number) => {
    const firstTarget = direction === "up" ? 0 : amount;
    const lastTarget = direction === "up" ? rows - amount : rows;
    let runStart = firstTarget;
    let runLength = 0;
    const flushRun = () => {
      if (runLength < minimumRun) return;
      const regionStart = direction === "up" ? runStart : runStart - amount;
      const regionEnd = direction === "up" ? runStart + runLength + amount : runStart + runLength;
      const simulated = simulateShift(previous, rows, direction, amount, regionStart, regionEnd);
      const rewrites = next.flatMap((line, row) => (line === simulated[row] ? [] : [row]));
      candidates.push({ direction, amount, regionStart, regionEnd, rewrites });
    };
    for (let target = firstTarget; target < lastTarget; target += 1) {
      const source = direction === "up" ? target + amount : target - amount;
      if (comparableNext[target] === comparablePrevious[source]) {
        if (runLength === 0) runStart = target;
        runLength += 1;
      } else {
        flushRun();
        runLength = 0;
      }
    }
    flushRun();
  };
  for (let amount = 1; amount <= rows - minimumRun; amount += 1) {
    addRuns("up", amount);
    addRuns("down", amount);
  }
  return candidates
    .filter((candidate) => candidate.rewrites.length + 2 < originalRewrites)
    .sort((left, right) => left.rewrites.length - right.rewrites.length || right.regionEnd - left.regionEnd)[0];
}

function renderShift(frame: ParsedFrame, next: string[], candidate: ShiftCandidate): string {
  const operation = candidate.direction === "up" ? "S" : "T";
  const scroll = `\u001b[0m\u001b[${candidate.regionStart + 1};${candidate.regionEnd}r\u001b[${candidate.regionStart + 1};1H\u001b[${candidate.amount}${operation}\u001b[r`;
  const rewrites = candidate.rewrites.map((row) => `\u001b[${row + 1};1H\u001b[2K${next[row] ?? ""}`).join("");
  return `${frame.prefix}${scroll}${rewrites}${frame.suffix}`;
}

export class TerminalFrameOptimizer {
  private altScreen = false;
  private screen: string[] = [];
  private columns = 0;
  private rows = 0;

  optimize(data: string, rows: number, columns = 80): string {
    const safeRows = Math.max(1, Math.floor(rows));
    const safeColumns = Math.max(2, Math.floor(columns));
    if (data.includes(ENTER_ALT_SCREEN)) {
      this.altScreen = true;
      this.screen = [];
      this.columns = safeColumns;
      this.rows = safeRows;
    }
    if (!this.altScreen) return data;
    if (this.columns !== safeColumns || this.rows !== safeRows) {
      this.screen = [];
      this.columns = safeColumns;
      this.rows = safeRows;
    }

    if (IMAGE_SEQUENCE.test(data)) {
      this.screen = [];
      return data;
    }

    const frame = parseFrame(data, safeRows);
    if (frame) {
      const hadScreen = this.screen.length === safeRows;
      if (!hadScreen && !frame.fullRedraw) return data;
      const previous = hadScreen ? this.screen : Array.from({ length: safeRows }, () => "");
      const next = applyUpdates(previous, frame, safeRows);
      this.screen = next;
      if (hadScreen && !frame.fullRedraw && frame.explicitCursor) {
        const candidate = findShift(previous, next, frame.updates.size, safeColumns);
        if (candidate) data = renderShift(frame, next, candidate);
      }
    } else if (data.includes(FULL_REDRAW) || data.includes("\u001b[2K")) {
      this.screen = [];
    }

    if (data.includes(EXIT_ALT_SCREEN)) {
      this.altScreen = false;
      this.screen = [];
      this.columns = 0;
      this.rows = 0;
    }
    return data;
  }
}
