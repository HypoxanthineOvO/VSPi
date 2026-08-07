import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { type IPty, spawn } from "@homebridge/node-pty-prebuilt-multiarch";
import type { Terminal as HeadlessTerminal, IBufferCell, IBufferLine } from "@xterm/headless";
import headlessXterm from "@xterm/headless";

const { Terminal } = headlessXterm;

const CLEAR_VIEWPORT = "\u001b[2J";
const HOME = "\u001b[H";
const CLEAR_SCROLLBACK = "\u001b[3J";
const BEGIN_SYNC = "\u001b[?2026h";
const END_SYNC = "\u001b[?2026l";

export interface MockArguments {
  rows: number;
  columns: number;
  trace: boolean;
  columnRuler: boolean;
  theme: "Terminal" | "VSPi Dark" | "VSPi Light";
}

export interface InspectorFrame {
  id: number;
  phase: string;
  lines: string[];
  ansiLines: string[];
  baseY: number;
  viewportY: number;
  cursorY: number;
  timestamp: number;
}

export function parseMockArguments(argv: readonly string[]): MockArguments {
  const parsed: MockArguments = {
    rows: 40,
    columns: 80,
    trace: false,
    columnRuler: false,
    theme: "Terminal",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--trace") parsed.trace = true;
    else if (argument === "--ruler") parsed.columnRuler = true;
    else if (argument === "--theme") {
      const value = argv[++index];
      const themes = { terminal: "Terminal", dark: "VSPi Dark", light: "VSPi Light" } as const;
      if (!value || !(value in themes)) throw new Error("--theme must be terminal, dark, or light");
      parsed.theme = themes[value as keyof typeof themes];
    } else if (argument === "--rows" || argument === "--cols") {
      const raw = argv[++index];
      const value = Number(raw);
      if (!Number.isInteger(value)) throw new Error(`${argument} requires an integer`);
      if (argument === "--rows") parsed.rows = value;
      else parsed.columns = value;
    } else if (argument === "--help") {
      process.stdout.write(
        "npm run mock:terminal -- [--rows 40] [--cols 80] [--theme terminal|dark|light] [--ruler] [--trace]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown terminal mock option: ${argument}`);
    }
  }
  if (parsed.rows < 12 || parsed.rows > 99) throw new Error("--rows must be between 12 and 99");
  if (parsed.columns < 40 || parsed.columns > 240) throw new Error("--cols must be between 40 and 240");
  return parsed;
}

export function inferPhase(lines: readonly string[]): string {
  const content = lines.join("\n");
  if (content.includes("Sessions")) return "resume-picker";
  if (content.includes("MOCK_RESUME_")) return "resume-restored";
  if (content.includes("Trace Question")) return "question";
  if (content.includes("Working")) return "working";
  if (content.includes("◈ VSPi") || content.includes("* VSPi")) return "startup";
  return "idle";
}

export function formatInspectorRow(row: number, changed: boolean, content: string): string {
  return `${String(row).padStart(2, "0")}${changed ? "*" : " "}│${content}`;
}

function occurrences(content: string, target: string): number {
  return content.split(target).length - 1;
}

function blankFramedRow(line: string | undefined): boolean {
  return /^[│|]\s*[│|]$/u.test(line?.trimEnd() ?? "");
}

function hasBlankRowBetween(lines: readonly string[], start: number, end: number): boolean {
  return start >= 0 && end > start && lines.slice(start + 1, end).some(blankFramedRow);
}

function colorSgr(cell: IBufferCell, foreground: boolean): string | undefined {
  const color = foreground ? cell.getFgColor() : cell.getBgColor();
  const prefix = foreground ? "38" : "48";
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
    return `${prefix};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`;
  }
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return `${prefix};5;${color}`;
  return undefined;
}

function cellSgr(cell: IBufferCell): string {
  const parameters: string[] = [];
  if (cell.isBold()) parameters.push("1");
  if (cell.isDim()) parameters.push("2");
  if (cell.isItalic()) parameters.push("3");
  if (cell.isUnderline()) parameters.push("4");
  if (cell.isBlink()) parameters.push("5");
  if (cell.isInverse()) parameters.push("7");
  if (cell.isInvisible()) parameters.push("8");
  if (cell.isStrikethrough()) parameters.push("9");
  if (cell.isOverline()) parameters.push("53");
  const foreground = colorSgr(cell, true);
  const background = colorSgr(cell, false);
  if (foreground) parameters.push(foreground);
  if (background) parameters.push(background);
  return parameters.length > 0 ? `\u001b[0;${parameters.join(";")}m` : "\u001b[0m";
}

export function serializeStyledBufferLine(line: IBufferLine | undefined, columns: number): string {
  let output = "";
  let activeStyle = "";
  for (let column = 0; column < columns; column += 1) {
    const cell = line?.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const style = cellSgr(cell);
    if (style !== activeStyle) {
      output += style;
      activeStyle = style;
    }
    output += cell.getChars() || " ";
  }
  return `${output}\u001b[0m`;
}

class TerminalInspector {
  readonly terminal: HeadlessTerminal;
  readonly child: IPty;
  readonly frames: InspectorFrame[] = [];
  raw = "";
  private pendingWrites = Promise.resolve();
  private selected = -1;
  private paused = false;
  private commandPrefix = false;
  private columnRuler: boolean;
  private paintTimer: NodeJS.Timeout | undefined;
  private restored = false;
  private closed = false;
  private synchronizedOutput = false;
  private controlTail = "";

  constructor(
    readonly arguments_: MockArguments,
    logDirectory: string,
  ) {
    this.columnRuler = arguments_.columnRuler;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: arguments_.columns,
      rows: arguments_.rows,
      scrollback: arguments_.rows * 20,
      scrollOnEraseInDisplay: true,
    });
    const executable = resolve("node_modules/.bin/tsx");
    this.child = spawn(executable, [resolve("scripts/terminal-mock-child.ts")], {
      name: "xterm-256color",
      cols: arguments_.columns,
      rows: arguments_.rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PI_DEBUG_REDRAW: "1",
        PI_CODING_AGENT_DIR: logDirectory,
        VSPI_MOCK_LOG_DIR: logDirectory,
        VSPI_TERMINAL_MOCK_THEME: arguments_.theme,
        ...(arguments_.trace ? { VSPI_TERMINAL_MOCK_TRACE: "1" } : {}),
      },
    });
    this.child.onData((data) => {
      this.raw += data;
      const captureAfterWrite = this.observeOutputControls(data);
      this.pendingWrites = this.pendingWrites.then(
        () =>
          new Promise<void>((resolveWrite) => {
            this.terminal.write(data, () => {
              if (captureAfterWrite) this.capture();
              resolveWrite();
            });
          }),
      );
    });
  }

  write(data: string): void {
    this.child.write(data);
  }

  resize(columns: number, rows: number): void {
    this.child.resize(columns, rows);
    this.terminal.resize(columns, rows);
  }

  async settle(): Promise<void> {
    await this.pendingWrites;
  }

  screenText(): string {
    return this.snapshotLines().join("\n");
  }

  scrollbackText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  async waitFor(pattern: string | RegExp, timeoutMs = 12_000): Promise<InspectorFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.settle();
      const content = this.scrollbackText();
      if (typeof pattern === "string" ? content.includes(pattern) : pattern.test(content)) {
        const frame = this.frames.at(-1);
        if (frame) return frame;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 15));
    }
    throw new Error(`Timed out waiting for ${String(pattern)}\n${this.screenText()}`);
  }

  async waitUntil(predicate: (screen: string) => boolean, timeoutMs = 12_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.settle();
      if (predicate(this.screenText())) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 15));
    }
    throw new Error(`Timed out waiting for terminal state\n${this.screenText()}`);
  }

  startInteractive(): void {
    const requiredRows = this.arguments_.rows + 1 + (this.columnRuler ? 1 : 0);
    const requiredColumns = this.arguments_.columns + 4;
    if ((process.stdout.rows ?? 0) < requiredRows || (process.stdout.columns ?? 0) < requiredColumns) {
      throw new Error(
        `Outer terminal needs at least ${requiredColumns}x${requiredRows}; current is ${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}`,
      );
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => this.handleHostInput(chunk.toString("utf8")));
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    this.restored = false;
    this.schedulePaint();
  }

  restoreHost(): void {
    if (this.restored || this.arguments_.trace) return;
    this.restored = true;
    if (this.paintTimer) clearTimeout(this.paintTimer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\u001b[?25h\u001b[?1049l");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.restoreHost();
    this.child.kill();
    this.terminal.dispose();
  }

  private capture(): void {
    const buffer = this.terminal.buffer.active;
    const lines = this.snapshotLines();
    const ansiLines = this.snapshotStyledLines();
    const frame: InspectorFrame = {
      id: (this.frames.at(-1)?.id ?? 0) + 1,
      phase: inferPhase(lines),
      lines,
      ansiLines,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursorY: buffer.cursorY,
      timestamp: Date.now(),
    };
    const previous = this.frames.at(-1);
    if (
      previous &&
      previous.baseY === frame.baseY &&
      previous.viewportY === frame.viewportY &&
      previous.cursorY === frame.cursorY &&
      previous.lines.every((line, index) => line === frame.lines[index]) &&
      previous.ansiLines.every((line, index) => line === frame.ansiLines[index])
    ) {
      return;
    }
    this.frames.push(frame);
    if (this.frames.length > 1_000) this.frames.shift();
    if (!this.paused) this.selected = this.frames.length - 1;
    this.schedulePaint();
  }

  private observeOutputControls(data: string): boolean {
    const scan = this.controlTail + data;
    let cursor = 0;
    let began = false;
    let ended = false;
    while (cursor < scan.length) {
      const beginIndex = scan.indexOf(BEGIN_SYNC, cursor);
      const endIndex = scan.indexOf(END_SYNC, cursor);
      if (beginIndex < 0 && endIndex < 0) break;
      if (beginIndex >= 0 && (endIndex < 0 || beginIndex < endIndex)) {
        this.synchronizedOutput = true;
        began = true;
        cursor = beginIndex + BEGIN_SYNC.length;
      } else {
        this.synchronizedOutput = false;
        ended = true;
        cursor = endIndex + END_SYNC.length;
      }
    }
    const remainder = scan.slice(cursor);
    this.controlTail = "";
    for (let length = Math.min(END_SYNC.length - 1, remainder.length); length > 0; length -= 1) {
      const suffix = remainder.slice(-length);
      if (BEGIN_SYNC.startsWith(suffix) || END_SYNC.startsWith(suffix)) {
        this.controlTail = suffix;
        break;
      }
    }
    return ended || (!this.synchronizedOutput && !began && this.controlTail.length === 0);
  }

  private snapshotLines(): string[] {
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, offset) => {
      return buffer.getLine(buffer.viewportY + offset)?.translateToString(true) ?? "";
    });
  }

  private snapshotStyledLines(): string[] {
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, offset) => {
      return serializeStyledBufferLine(buffer.getLine(buffer.viewportY + offset), this.terminal.cols);
    });
  }

  private handleHostInput(data: string): void {
    if (this.commandPrefix) {
      this.commandPrefix = false;
      const command = data[0]?.toLowerCase();
      if (command === "q") {
        this.close();
        return;
      }
      if (command === "p" || command === " ") this.paused = !this.paused;
      else if (command === "[") {
        this.paused = true;
        this.selected = Math.max(0, this.selected - 1);
      } else if (command === "]") {
        this.paused = true;
        this.selected = Math.min(this.frames.length - 1, this.selected + 1);
      } else if (command === "l") {
        this.paused = false;
        this.selected = this.frames.length - 1;
      } else if (command === "c") this.columnRuler = !this.columnRuler;
      this.schedulePaint();
      if (data.length > 1) this.child.write(data.slice(1));
      return;
    }
    const prefix = data.indexOf("\u0007");
    if (prefix >= 0) {
      if (prefix > 0) this.child.write(data.slice(0, prefix));
      this.commandPrefix = true;
      const remainder = data.slice(prefix + 1);
      if (remainder) this.handleHostInput(remainder);
      this.schedulePaint();
      return;
    }
    this.child.write(data);
  }

  private schedulePaint(): void {
    if (this.arguments_.trace || this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = undefined;
      this.paint();
    }, 16);
  }

  private paint(): void {
    const frame = this.frames[this.selected] ?? this.frames.at(-1);
    if (!frame) return;
    const previous = this.frames[this.selected - 1];
    const mode = this.paused ? "PAUSED" : "LIVE";
    const prefixState = this.commandPrefix ? " command..." : "";
    const header = `F${String(frame.id).padStart(4, "0")} ${frame.phase} ${this.arguments_.columns}x${this.arguments_.rows} ${this.arguments_.theme} baseY=${frame.baseY} viewportY=${frame.viewportY} cursorY=${frame.cursorY} ${mode}${prefixState}  ^G [ ] p l c q`;
    const output = [header.slice(0, process.stdout.columns ?? header.length).padEnd(process.stdout.columns ?? 0)];
    if (this.columnRuler) {
      const ruler = Array.from({ length: this.arguments_.columns }, (_, index) => String((index + 1) % 10)).join("");
      output.push(`    ${ruler}`);
    }
    for (let index = 0; index < this.arguments_.rows; index += 1) {
      const changed =
        previous?.lines[index] !== frame.lines[index] || previous?.ansiLines[index] !== frame.ansiLines[index];
      const gutter = formatInspectorRow(index + 1, changed, "");
      output.push(`\u001b[0m${gutter}${frame.ansiLines[index] ?? ""}\u001b[0m`);
    }
    process.stdout.write(`\u001b[?2026h\u001b[0m\u001b[H${output.join("\r\n")}\u001b[0m\u001b[J\u001b[?2026l`);
  }
}

async function runTrace(inspector: TerminalInspector, logDirectory: string): Promise<void> {
  await inspector.waitFor("Mock Deterministic", 15_000);
  const startupFrame = inspector.frames.at(-1)?.id ?? 0;
  const runtimeRawStart = inspector.raw.length;
  const beforeStreamingBytes = inspector.raw.length;
  inspector.write("trace long\r");
  await inspector.waitFor("MOCK_RESPONSE_1_END", 15_000);
  await inspector.waitUntil((screen) => !screen.includes("Working"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  const streamingBytes = inspector.raw.length - beforeStreamingBytes;

  inspector.write("mock question\r");
  const questionFrame = await inspector.waitFor("Trace Question");
  inspector.write("\t");
  const directAnswerFrame = await inspector.waitFor("你的回答");
  inspector.write("mock typed answer");
  await inspector.waitFor("mock typed answer");
  inspector.write("\u001b");
  await inspector.waitUntil((screen) => screen.includes("Continue") && !screen.includes("你的回答"));
  inspector.write("\r");
  await inspector.waitFor("最终检查");
  inspector.write("\r");
  const noticeFrame = await inspector.waitFor("完成 · 已提交");
  await inspector.waitFor("MOCK_RESPONSE_2_END", 15_000);
  await inspector.waitUntil((screen) => !screen.includes("Working"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  inspector.write("/resume\r");
  const pickerFrame = await inspector.waitFor("Sessions");
  const rawBeforeResume = inspector.raw.length;
  const framesBeforeResume = inspector.frames.length;
  inspector.write("\r");
  const restoredFrame = await inspector.waitFor("MOCK_RESUME_072_END", 15_000);
  const resumeFrames = inspector.frames.slice(framesBeforeResume);
  const rawResume = inspector.raw.slice(rawBeforeResume);

  inspector.write("after resume\r");
  await inspector.waitFor("MOCK_RESPONSE_3_END", 15_000);
  await inspector.waitUntil((screen) => !screen.includes("Working"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  const rawBeforeResize = inspector.raw.length;
  inspector.resize(inspector.arguments_.columns + 4, inspector.arguments_.rows);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  inspector.resize(inspector.arguments_.columns, inspector.arguments_.rows);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  await inspector.settle();
  const resizeRaw = inspector.raw.slice(rawBeforeResize);

  let redrawReasons: string[] = [];
  try {
    redrawReasons = (await readFile(resolve(logDirectory, "pi-debug.log"), "utf8")).split("\n").filter(Boolean);
  } catch {}
  const startupRaw = inspector.raw.slice(0, runtimeRawStart);
  const preResizeRaw = inspector.raw.slice(runtimeRawStart, rawBeforeResize);
  const postStartupReasons = redrawReasons.filter((line) => !line.includes("first render"));
  const nonResizeReasons = postStartupReasons.filter(
    (line) => !line.includes("width changed") && !line.includes("height changed"),
  );
  const restoredSurfaceFrames = resumeFrames.filter((frame) => frame.lines.join("\n").includes("MOCK_RESUME_"));
  const partialHydrationFrames = restoredSurfaceFrames.filter(
    (frame) => !frame.lines.join("\n").includes("MOCK_RESUME_072_END"),
  );
  const questionTop = questionFrame.lines.findIndex((line) => /^[╭+]─?.*Question/u.test(line));
  const questionBottom = questionFrame.lines.findIndex((line, index) => index > questionTop && /^[╰+]/u.test(line));
  const questionMetadata = questionFrame.lines.findIndex((line) => line.includes("Question 1 / 1"));
  const questionPrompt = questionFrame.lines.findIndex((line) =>
    line.includes("Choose the deterministic continuation"),
  );
  const continueOption = questionFrame.lines.findIndex((line) => line.includes("Continue"));
  const cancelOption = questionFrame.lines.findIndex((line) => line.includes("Cancel"));
  const otherOption = questionFrame.lines.findIndex((line) => line.includes("其他"));
  const intrudingTranscriptRows = questionFrame.lines
    .map((line, index) => ({ line, row: index + 1 }))
    .filter(
      ({ line, row }) =>
        row > questionTop + 1 && row < questionBottom + 1 && line.toLowerCase().includes("mock response"),
    )
    .map(({ row }) => row);
  const noticeRow = noticeFrame.lines.findIndex((line) => line.includes("完成 · 已提交"));
  const noticeContextRow = noticeFrame.lines.findIndex(
    (line, index) => index > noticeRow && line.includes("Mock Deterministic") && line.includes("Effort"),
  );
  const selectedOptionAnsi = questionFrame.ansiLines[continueOption] ?? "";
  const questionSelectionHasBackground =
    /\[(?:0;)?7(?:;|m)/u.test(selectedOptionAnsi) ||
    selectedOptionAnsi.includes("48;2;") ||
    selectedOptionAnsi.includes("48;5;");
  const questionHasOptionRail = [continueOption, cancelOption, otherOption].some((row) =>
    /[┃#]/u.test(questionFrame.lines[row] ?? ""),
  );
  const questionHasOptionDecoration = questionFrame.lines
    .slice(continueOption, otherOption + 1)
    .some((line) => /[┌┐└┘]/u.test(line) || /[-─]{8,}/u.test(line));
  const questionOptionsAreConsecutive = cancelOption === continueOption + 1 && otherOption === cancelOption + 1;
  const questionFooterGapRow = otherOption + 1;
  const questionGutterRow = questionBottom + 1;
  const questionHasMainComposer = questionFrame.lines.some((line) => line.includes("输入消息"));
  const directAnswerLabel = directAnswerFrame.lines.findIndex((line) => line.includes("你的回答"));
  const directAnswerRow = directAnswerFrame.lines.findIndex(
    (line, index) => index > directAnswerLabel && line.includes("›"),
  );
  const pickerLongSession = pickerFrame.lines.findIndex((line) => line.includes("Long hydrated session"));
  const pickerShortSession = pickerFrame.lines.findIndex((line) => line.includes("Short session"));
  const pickerSelectionAnsi = pickerFrame.ansiLines[pickerLongSession] ?? "";
  const pickerSelectionHasBackground =
    /\[(?:0;)?7(?:;|m)/u.test(pickerSelectionAnsi) ||
    pickerSelectionAnsi.includes("48;2;") ||
    pickerSelectionAnsi.includes("48;5;");
  const questionStatusFirst = questionFrame.lines.findIndex(
    (line, index) => index > questionGutterRow && line.startsWith("Model "),
  );
  const questionStatusSecond = questionFrame.lines.findIndex(
    (line, index) => index > questionStatusFirst && line.includes("Policy"),
  );
  const timeline = inspector.frames.map((frame, index, frames) => {
    const previous = frames[index - 1];
    const firstChanged = previous ? frame.lines.findIndex((line, row) => line !== previous.lines[row]) : 0;
    return {
      id: frame.id,
      phase: frame.phase,
      baseY: frame.baseY,
      viewportY: frame.viewportY,
      cursorY: frame.cursorY,
      firstChanged: firstChanged < 0 ? null : firstChanged + 1,
    };
  });
  const violations = [
    ...(occurrences(preResizeRaw, CLEAR_VIEWPORT) > 0 ? ["viewport clear before resize"] : []),
    ...(occurrences(preResizeRaw, CLEAR_SCROLLBACK) > 0 ? ["scrollback clear before resize"] : []),
    ...(occurrences(rawResume, HOME) > 0 ? ["Home sequence during Resume"] : []),
    ...(partialHydrationFrames.length > 0
      ? [`Resume exposed ${partialHydrationFrames.length} partial hydration frames`]
      : []),
    ...(restoredFrame.lines.join("\n").includes("Sessions") ? ["Resume picker replayed in restored frame"] : []),
    ...(questionTop < 0 || questionBottom <= questionTop ? ["Question frame boundary was not found"] : []),
    ...(intrudingTranscriptRows.length > 0
      ? [`transcript entered Question frame at rows ${intrudingTranscriptRows.join(", ")}`]
      : []),
    ...(!hasBlankRowBetween(questionFrame.lines, questionMetadata, questionPrompt)
      ? ["Question metadata and prompt have no blank separator"]
      : []),
    ...(!hasBlankRowBetween(questionFrame.lines, questionPrompt, continueOption)
      ? ["Question prompt and first option have no blank separator"]
      : []),
    ...(!questionOptionsAreConsecutive ? ["Question short options are not consecutive rows"] : []),
    ...(!blankFramedRow(questionFrame.lines[questionFooterGapRow]) || questionBottom !== questionFooterGapRow + 1
      ? ["Question has no fixed one-row gap between options and footer"]
      : []),
    ...(noticeRow < 0 || noticeContextRow !== noticeRow + 1
      ? [`notice is not the first row of its Status footprint: ${noticeRow + 1}/${noticeContextRow + 1}`]
      : []),
    ...(questionSelectionHasBackground ? ["Question selected option still uses inverse or background styling"] : []),
    ...(questionHasOptionRail ? ["Question option still uses a vertical focus rail"] : []),
    ...(questionHasOptionDecoration ? ["Question option list still uses a separator or inner box"] : []),
    ...(questionFrame.lines[questionGutterRow]?.trim() ? ["Question has no blank gutter before Status"] : []),
    ...(questionHasMainComposer ? ["Question frame still renders the main Composer"] : []),
    ...(directAnswerRow < 0 ? ["Question direct-answer field has no local focus marker"] : []),
    ...(!hasBlankRowBetween(pickerFrame.lines, pickerLongSession, pickerShortSession)
      ? ["Resume sessions have no blank entity spacing"]
      : []),
    ...(pickerSelectionHasBackground ? ["Resume selected session still uses inverse or background styling"] : []),
    ...(questionStatusFirst !== questionGutterRow + 1 || questionStatusSecond !== questionStatusFirst + 1
      ? ["Question footer, gutter, and Status rows are not contiguous"]
      : []),
    ...(nonResizeReasons.length > 0 ? [`unexpected full redraw: ${nonResizeReasons.join(" | ")}`] : []),
  ];
  const report = {
    child: {
      columns: inspector.arguments_.columns,
      rows: inspector.arguments_.rows,
      theme: inspector.arguments_.theme,
    },
    frames: {
      total: inspector.frames.length,
      startup: startupFrame,
      question: questionFrame.id,
      resumePicker: pickerFrame.id,
      resumeRestored: restoredFrame.id,
      restoredSurface: restoredSurfaceFrames.length,
      hydrationPartial: partialHydrationFrames.length,
    },
    bytes: { streaming: streamingBytes, resume: rawResume.length },
    controls: {
      startupClearViewport: occurrences(startupRaw, CLEAR_VIEWPORT),
      preResizeClearViewport: occurrences(preResizeRaw, CLEAR_VIEWPORT),
      preResizeClearScrollback: occurrences(preResizeRaw, CLEAR_SCROLLBACK),
      resumeHome: occurrences(rawResume, HOME),
      resizeClearViewport: occurrences(resizeRaw, CLEAR_VIEWPORT),
    },
    geometry: {
      question: {
        frame: questionFrame.id,
        top: questionTop + 1,
        bottom: questionBottom + 1,
        metadata: questionMetadata + 1,
        prompt: questionPrompt + 1,
        options: [continueOption + 1, cancelOption + 1, otherOption + 1],
        consecutive: questionOptionsAreConsecutive,
        footerGap: questionFooterGapRow + 1,
        decorationVisible: questionHasOptionDecoration,
        intrudingTranscriptRows,
        selectionHasBackground: questionSelectionHasBackground,
        optionRailVisible: questionHasOptionRail,
        gutter: questionGutterRow + 1,
        mainComposerVisible: questionHasMainComposer,
        directAnswer: { frame: directAnswerFrame.id, row: directAnswerRow + 1 },
      },
      notice: {
        frame: noticeFrame.id,
        row: noticeRow + 1,
        statusRows: [noticeRow + 1, noticeContextRow + 1],
      },
      resumePicker: {
        selected: pickerLongSession + 1,
        next: pickerShortSession + 1,
        blankBetween: hasBlankRowBetween(pickerFrame.lines, pickerLongSession, pickerShortSession),
        selectionHasBackground: pickerSelectionHasBackground,
      },
    },
    redrawReasons,
    timeline,
    violations,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (violations.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const arguments_ = parseMockArguments(process.argv.slice(2));
  if (!arguments_.trace && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("Interactive terminal mock requires a TTY; use --trace for automation");
  }
  const logDirectory = await mkdtemp(resolve(tmpdir(), "vspi-terminal-mock-"));
  const inspector = new TerminalInspector(arguments_, logDirectory);
  const cleanup = async () => {
    inspector.close();
    await rm(logDirectory, { recursive: true, force: true });
  };
  inspector.child.onExit(() => inspector.restoreHost());
  try {
    if (arguments_.trace) await runTrace(inspector, logDirectory);
    else {
      inspector.startInteractive();
      await new Promise<void>((resolveExit) => inspector.child.onExit(() => resolveExit()));
    }
    await cleanup();
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
