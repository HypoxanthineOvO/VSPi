import { Terminal } from "@xterm/headless";
import { type IPty, spawn } from "node-pty";

export interface PtyHarnessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  columns?: number;
  rows?: number;
  scrollback?: number;
}

export class PtyHarness {
  readonly terminal: Terminal;
  readonly process: IPty;
  private pendingWrites = Promise.resolve();
  private exited = false;

  constructor(command: string, args: string[], options: PtyHarnessOptions) {
    const columns = options.columns ?? 80;
    const rows = options.rows ?? 24;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: columns,
      rows,
      scrollback: options.scrollback ?? 5_000,
      scrollOnEraseInDisplay: true,
    });
    this.process = spawn(command, args, {
      name: "xterm-256color",
      cols: columns,
      rows,
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
    });
    this.process.onData((data) => {
      this.pendingWrites = this.pendingWrites.then(
        () => new Promise<void>((resolve) => this.terminal.write(data, resolve)),
      );
    });
    this.process.onExit(() => {
      this.exited = true;
    });
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(columns: number, rows: number): void {
    this.process.resize(columns, rows);
    this.terminal.resize(columns, rows);
  }

  screenText(): string {
    const buffer = this.terminal.buffer.active;
    return this.lines(buffer.viewportY, buffer.viewportY + this.terminal.rows).join("\n");
  }

  scrollbackText(): string {
    return this.lines(0, this.terminal.buffer.active.length).join("\n");
  }

  async waitFor(pattern: string | RegExp, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.pendingWrites;
      const content = this.scrollbackText();
      if (typeof pattern === "string" ? content.includes(pattern) : pattern.test(content)) return content;
      if (this.exited) throw new Error(`PTY exited before output matched ${String(pattern)}\n${content}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for PTY output ${String(pattern)}\n${this.scrollbackText()}`);
  }

  async close(): Promise<void> {
    if (!this.exited) this.process.kill();
    await this.pendingWrites;
    this.terminal.dispose();
  }

  private lines(start: number, end: number): string[] {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines;
  }
}
