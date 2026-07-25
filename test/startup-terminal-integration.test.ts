import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as startupModule from "../src/app/startup.js";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService, AttachmentServiceEvents } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { VSPI_VERSION } from "../src/version.js";
import { plainTheme } from "./helpers.js";

const PI_STATUS = {
  model: "OpenAI / GPT-5.4",
  backend: "Pi" as const,
  policy: "Standard",
  boundary: "Host" as const,
  version: "9.8.7-test",
};
const DYNAMIC_MARKERS = ["当前计划为空", "输入消息", PI_STATUS.model] as const;
const LOGO = [
  "██╗   ██╗███████╗██████╗ ██╗",
  "██║   ██║██╔════╝██╔══██╗██║",
  "██║   ██║███████╗██████╔╝██║",
  "╚██╗ ██╔╝╚════██║██╔═══╝ ██║",
  " ╚████╔╝ ███████║██║     ██║",
  "  ╚═══╝  ╚══════╝╚═╝     ╚═╝",
] as const;

type StartupResult = "success" | "backend-failure" | "attachment-failure";

interface InteractiveShutdownOptions {
  disposeApp: () => Promise<void>;
  tui: Pick<TUI, "stop">;
  drainInput: () => Promise<void>;
}

type InteractiveShutdown = (options: InteractiveShutdownOptions) => Promise<void>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface TerminalWrite {
  data: string;
  source: "splash" | "tui";
}

class VirtualTerminalBuffer {
  private readonly lines: string[][] = [];
  private cursorRow = 0;
  private cursorColumn = 0;

  constructor(
    private readonly columns: number,
    private readonly rows: number,
  ) {}

  write(data: string): void {
    for (let index = 0; index < data.length; ) {
      if (data[index] === "\u001b") {
        const next = data[index + 1];
        if (next === "[") {
          let end = index + 2;
          while (end < data.length && !/[@-~]/.test(data[end] ?? "")) end += 1;
          if (end >= data.length) break;
          this.applyCsi(data.slice(index + 2, end), data[end] ?? "");
          index = end + 1;
          continue;
        }
        if (next === "]" || next === "_") {
          index += 2;
          while (index < data.length) {
            if (data.charCodeAt(index) === 7) {
              index += 1;
              break;
            }
            if (data[index] === "\u001b" && data[index + 1] === "\\") {
              index += 2;
              break;
            }
            index += 1;
          }
          continue;
        }
        index += 2;
        continue;
      }
      if (data[index] === "\r") {
        this.cursorColumn = 0;
        index += 1;
        continue;
      }
      if (data[index] === "\n") {
        this.cursorRow += 1;
        this.cursorColumn = 0;
        index += 1;
        continue;
      }
      const codePoint = data.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      if ((codePoint >= 32 && codePoint !== 127) || codePoint > 159) this.writeCharacter(character);
      index += character.length;
    }
  }

  captureRows(): string[] {
    let end = this.lines.length;
    while (end > 0 && this.renderRow(end - 1).trim().length === 0) end -= 1;
    return Array.from({ length: end }, (_, row) => this.renderRow(row));
  }

  private viewportTop(): number {
    return Math.max(0, this.cursorRow - this.rows + 1);
  }

  private ensureRow(row: number): string[] {
    while (this.lines.length <= row) this.lines.push(Array.from({ length: this.columns }, () => " "));
    return this.lines[row] as string[];
  }

  private renderRow(row: number): string {
    const cells = this.lines[row] ?? [];
    const rendered = cells.filter((cell) => cell !== "").join("");
    return `${rendered}${" ".repeat(Math.max(0, this.columns - visibleWidth(rendered)))}`;
  }

  private writeCharacter(character: string): void {
    if (this.cursorColumn >= this.columns) {
      this.cursorRow += 1;
      this.cursorColumn = 0;
    }
    const width = Math.max(1, visibleWidth(character));
    const row = this.ensureRow(this.cursorRow);
    row[this.cursorColumn] = character;
    for (let offset = 1; offset < width && this.cursorColumn + offset < this.columns; offset += 1) {
      row[this.cursorColumn + offset] = "";
    }
    this.cursorColumn += width;
  }

  private applyCsi(rawParameters: string, final: string): void {
    const parameters = rawParameters.replace(/^\?/, "").split(";").filter(Boolean).map(Number);
    const first = parameters[0] ?? 0;
    if (final === "A") this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, first));
    else if (final === "B") this.cursorRow += Math.max(1, first);
    else if (final === "C") this.cursorColumn = Math.min(this.columns, this.cursorColumn + Math.max(1, first));
    else if (final === "D") this.cursorColumn = Math.max(0, this.cursorColumn - Math.max(1, first));
    else if (final === "G") this.cursorColumn = Math.max(0, Math.min(this.columns, Math.max(1, first) - 1));
    else if (final === "H" || final === "f") {
      this.cursorRow = this.viewportTop() + Math.max(0, (parameters[0] ?? 1) - 1);
      this.cursorColumn = Math.max(0, (parameters[1] ?? 1) - 1);
    } else if (final === "K") {
      const row = this.ensureRow(this.cursorRow);
      if (first === 2) row.fill(" ");
      else for (let column = this.cursorColumn; column < this.columns; column += 1) row[column] = " ";
    } else if (final === "J") {
      if (first === 3) {
        for (let row = 0; row < this.viewportTop(); row += 1) this.lines[row]?.fill(" ");
      } else if (first === 2) {
        const top = this.viewportTop();
        for (let row = top; row < top + this.rows; row += 1) this.ensureRow(row).fill(" ");
      } else {
        const current = this.ensureRow(this.cursorRow);
        for (let column = this.cursorColumn; column < this.columns; column += 1) current[column] = " ";
        for (let row = this.cursorRow + 1; row < this.lines.length; row += 1) this.lines[row]?.fill(" ");
      }
    }
  }
}

class RecordingTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 24;
  readonly kittyProtocolActive = false;
  readonly writes: TerminalWrite[] = [];
  starts = 0;
  stops = 0;
  drains = 0;
  cursorShows = 0;
  cursorHides = 0;
  readonly buffer = new VirtualTerminalBuffer(this.columns, this.rows);
  private splashWriteDepth = 0;
  private onInput: ((data: string) => void) | undefined;

  constructor(private readonly onDynamicWrite: (plain: string) => void = () => {}) {}

  get tuiBytes(): number {
    return this.writes
      .filter((entry) => entry.source === "tui")
      .reduce((total, entry) => total + Buffer.byteLength(entry.data), 0);
  }

  get splashWrites(): string[] {
    return this.writes.filter((entry) => entry.source === "splash").map((entry) => entry.data);
  }

  writeSplash(data: string): void {
    this.splashWriteDepth += 1;
    try {
      this.write(data);
    } finally {
      this.splashWriteDepth -= 1;
    }
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.starts += 1;
    this.onInput = onInput;
  }

  stop(): void {
    this.stops += 1;
  }

  async drainInput(): Promise<void> {
    this.drains += 1;
  }

  write(data: string): void {
    const source = this.splashWriteDepth > 0 ? "splash" : "tui";
    this.writes.push({ data, source });
    this.buffer.write(data);
    if (source === "tui") this.onDynamicWrite(stripAnsi(data));
  }

  sendInput(data: string): void {
    this.onInput?.(data);
  }

  moveBy(_lines: number): void {}

  hideCursor(): void {
    this.cursorHides += 1;
  }

  showCursor(): void {
    this.cursorShows += 1;
  }

  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

class ControlledBackend implements ChatBackend {
  readonly kind = "pi" as const;
  readonly modelLabel = PI_STATUS.model;
  readonly modelId = "gpt-5.4";
  readonly supportsVision = true;
  readonly startCalls = vi.fn();
  readonly newSessionCalls = vi.fn();
  readonly dispose = vi.fn(async () => {});
  readonly gate = deferred<void>();

  constructor(private readonly result: StartupResult) {}

  async start(events: ChatBackendEvents): Promise<void> {
    this.startCalls();
    events.onUsage(DEFAULT_USAGE);
    if (this.result !== "attachment-failure") await this.gate.promise;
    if (this.result === "backend-failure") throw new Error("backend startup failure sentinel");
  }

  async send(): Promise<void> {}
  async cancel(): Promise<void> {}
  async compact(): Promise<void> {}
  async newSession(): Promise<void> {
    this.newSessionCalls();
  }
  async listSessions(): Promise<[]> {
    return [];
  }
  async switchSession(): Promise<void> {}
}

class ControlledAttachments {
  readonly startCalls = vi.fn();
  readonly dispose = vi.fn(async () => {});
  readonly gate = deferred<void>();

  constructor(private readonly result: StartupResult) {}

  async start(_events: AttachmentServiceEvents, _bridgeEnabled: boolean): Promise<void> {
    this.startCalls();
    if (this.result !== "attachment-failure") return;
    await this.gate.promise;
    throw new Error("attachment startup failure sentinel");
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function flushNextTicks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function flushTuiRender(): Promise<void> {
  await flushMicrotasks();
  await flushNextTicks();
  await vi.runAllTimersAsync();
  await flushMicrotasks();
  await flushNextTicks();
}

async function exerciseStartup(reducedMotion: boolean, result: StartupResult): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const lifecycle: string[] = [];
  let finalSplashCount = 0;
  let dynamicBytesAtFinal = -1;
  let tuiStartCalls = 0;
  const terminal = new RecordingTerminal((plain) => {
    if (DYNAMIC_MARKERS.some((marker) => plain.includes(marker)) && lifecycle.at(-1) !== "tui:dynamic") {
      lifecycle.push("tui:dynamic");
    }
  });
  const tui = new TUI(terminal, true);
  const backend = new ControlledBackend(result);
  const attachments = new ControlledAttachments(result);
  const theme = plainTheme({ reducedMotion });
  const app = new VspiApp(tui, theme, backend, {
    cwd: "/workspace/real-tui-startup",
    settings: DEFAULT_SETTINGS,
    attachments: attachments as unknown as AttachmentService,
    onExit: vi.fn(),
  });
  tui.addChild(app);
  tui.setFocus(app);

  const startup = startupModule.startUiAfterSplash({
    width: terminal.columns,
    theme,
    write: (chunk) => {
      if (terminal.splashWrites.length === 0) lifecycle.push("splash:initial-brand");
      if (stripAnsi(chunk).includes(PI_STATUS.model)) {
        finalSplashCount += 1;
        dynamicBytesAtFinal = terminal.tuiBytes;
        lifecycle.push("splash:final");
      }
      terminal.writeSplash(chunk);
    },
    startApp: async () => {
      await app.start();
      lifecycle.push("app:resolved");
      return PI_STATUS;
    },
    startTui: () => {
      tuiStartCalls += 1;
      lifecycle.push("tui:start");
      tui.start();
    },
  });

  await flushTuiRender();
  const label = `${reducedMotion ? "reduced" : "animated"}/${result}`;
  expect.soft(terminal.tuiBytes, `${label}: dynamic terminal bytes before final splash`).toBe(0);
  expect.soft(finalSplashCount, `${label}: final splash while initialization is pending`).toBe(0);
  expect.soft(tuiStartCalls, `${label}: TUI callback starts while initialization is pending`).toBe(0);
  expect.soft(terminal.starts, `${label}: terminal starts while initialization is pending`).toBe(0);

  if (result === "attachment-failure") attachments.gate.resolve();
  else backend.gate.resolve();

  if (result === "success") {
    await startup;
    await flushTuiRender();
    const finalWrite = terminal.splashWrites.find((chunk) => stripAnsi(chunk).includes(PI_STATUS.model));
    expect.soft(dynamicBytesAtFinal, `${label}: dynamic bytes existed when final splash committed`).toBe(0);
    expect.soft(finalWrite, `${label}: resolved final splash exists`).toBeDefined();
    expect.soft(finalWrite?.endsWith("\n"), `${label}: final splash terminates with newline`).toBe(true);
    expect.soft(tuiStartCalls, `${label}: TUI callback start count`).toBe(1);
    expect.soft(terminal.starts, `${label}: terminal start count`).toBe(1);
    expect.soft(terminal.tuiBytes, `${label}: dynamic terminal bytes after final splash`).toBeGreaterThan(0);
    expect
      .soft(terminal.tuiBytes, `${label}: dynamic render must follow the final splash commit`)
      .toBeGreaterThan(dynamicBytesAtFinal);
    expect
      .soft(lifecycle, `${label}: startup lifecycle`)
      .toEqual(["splash:initial-brand", "app:resolved", "splash:final", "tui:start", "tui:dynamic"]);
  } else {
    await expect(startup).rejects.toThrow(`${result === "backend-failure" ? "backend" : "attachment"} startup failure`);
    await app.dispose();
    tui.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect.soft(terminal.tuiBytes, `${label}: lifetime dynamic terminal bytes after failure`).toBe(0);
    expect.soft(finalSplashCount, `${label}: lifetime final splash count after failure`).toBe(0);
    expect.soft(tuiStartCalls, `${label}: lifetime TUI callback starts after failure`).toBe(0);
    expect.soft(terminal.starts, `${label}: lifetime terminal starts after failure`).toBe(0);
  }

  if (result === "success") {
    await app.dispose();
    tui.stop();
  }
}

async function exerciseShutdown(shutdownInteractiveSession: InteractiveShutdown, result: StartupResult): Promise<void> {
  const terminal = new RecordingTerminal();
  const tui = new TUI(terminal, true);
  const backend = new ControlledBackend(result);
  const attachments = new ControlledAttachments(result);
  const app = new VspiApp(tui, plainTheme(), backend, {
    cwd: "/workspace/real-tui-shutdown",
    settings: DEFAULT_SETTINGS,
    attachments: attachments as unknown as AttachmentService,
    onExit: vi.fn(),
  });
  tui.addChild(app);
  tui.setFocus(app);
  if (result === "attachment-failure") attachments.gate.resolve();
  else backend.gate.resolve();

  if (result === "success") {
    await app.start();
    tui.start();
  } else {
    await expect(app.start()).rejects.toThrow(
      `${result === "backend-failure" ? "backend" : "attachment"} startup failure`,
    );
  }

  let appDisposes = 0;
  await shutdownInteractiveSession({
    disposeApp: async () => {
      appDisposes += 1;
      await app.dispose();
    },
    tui,
    drainInput: () => terminal.drainInput(),
  });

  const label = `shutdown/${result}`;
  expect.soft(appDisposes, `${label}: app dispose count`).toBe(1);
  expect.soft(backend.dispose, `${label}: backend dispose count`).toHaveBeenCalledOnce();
  expect.soft(attachments.dispose, `${label}: attachment dispose count`).toHaveBeenCalledOnce();
  expect.soft(terminal.stops, `${label}: terminal stop ownership`).toBe(1);
  expect.soft(terminal.cursorShows, `${label}: cursor restore ownership`).toBe(1);
  expect.soft(terminal.drains, `${label}: terminal drain count`).toBe(1);
  expect.soft(terminal.starts, `${label}: terminal start count`).toBe(result === "success" ? 1 : 0);
}

async function exerciseSessionReset(command: "/new" | "/clear"): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const terminal = new RecordingTerminal();
  const tui = new TUI(terminal, true);
  const backend = new ControlledBackend("success");
  const attachments = new ControlledAttachments("success");
  const theme = plainTheme({ reducedMotion: true });
  const app = new VspiApp(tui, theme, backend, {
    cwd: "/workspace/real-tui-session-reset",
    settings: DEFAULT_SETTINGS,
    attachments: attachments as unknown as AttachmentService,
    onExit: vi.fn(),
  });
  tui.addChild(app);
  tui.setFocus(app);
  backend.gate.resolve();

  await startupModule.startUiAfterSplash({
    width: terminal.columns,
    theme,
    write: (chunk) => terminal.writeSplash(chunk),
    startApp: async () => {
      await app.start();
      return PI_STATUS;
    },
    startTui: () => tui.start(),
  });
  await flushTuiRender();

  for (const character of command) terminal.sendInput(character);
  terminal.sendInput("\r");
  await flushTuiRender();

  const rows = terminal.buffer.captureRows();
  const plain = rows.join("\n");
  const firstLogoRows = rows.map((line, index) => (line.includes(LOGO[0]) ? index : -1)).filter((index) => index >= 0);
  const secondSplashStart = firstLogoRows[1] ?? -1;
  const freshPlanRow = rows.findIndex((line, index) => index > secondSplashStart && line.includes("当前计划为空"));
  const secondSplash = rows.slice(Math.max(0, secondSplashStart - 3), freshPlanRow).join("\n");

  expect(backend.newSessionCalls).toHaveBeenCalledOnce();
  expect(firstLogoRows).toHaveLength(2);
  expect(secondSplashStart).toBeGreaterThan(-1);
  expect(freshPlanRow).toBeGreaterThan(secondSplashStart);
  for (const logoLine of LOGO) expect(secondSplash).toContain(logoLine);
  expect(secondSplash).toContain(`Backend ${PI_STATUS.backend}`);
  expect(secondSplash).toContain(`Policy ${PI_STATUS.policy} · ${PI_STATUS.boundary}`);
  expect(secondSplash).toContain(`v${VSPI_VERSION}`);
  expect(secondSplash).toMatch(/╭─+╮[\s\S]*╰─+╯/);
  expect(secondSplash).not.toContain("\u001b");
  expect(rows.slice(secondSplashStart - 2, freshPlanRow).every((line) => visibleWidth(line) === 80)).toBe(true);
  expect(plain.match(/当前计划为空/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

  await app.dispose();
  tui.stop();
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("real terminal startup integration", () => {
  it("keeps mounted app output behind the final splash in every motion and slow-start path", async () => {
    for (const reducedMotion of [false, true]) {
      for (const result of ["success", "backend-failure", "attachment-failure"] as const) {
        await exerciseStartup(reducedMotion, result);
      }
    }
  });

  it("uses one callable shutdown owner for failed initialization and normal interactive exit", async () => {
    const exports = startupModule as typeof startupModule & {
      shutdownInteractiveSession?: InteractiveShutdown;
    };
    expect
      .soft(
        exports.shutdownInteractiveSession,
        "startup must expose the narrow shutdown boundary used by the interactive entry point",
      )
      .toBeTypeOf("function");
    if (!exports.shutdownInteractiveSession) return;
    for (const result of ["backend-failure", "attachment-failure", "success"] as const) {
      await exerciseShutdown(exports.shutdownInteractiveSession, result);
    }
  });

  it.each(["/new", "/clear"] as const)(
    "keeps a second complete %s Splash in real TUI scrollback before the fresh empty UI",
    async (command) => {
      await exerciseSessionReset(command);
    },
  );
});
