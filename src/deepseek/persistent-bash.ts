import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED_MESSAGE = "\n<response clipped>";

export class DeepSeekPersistentBashOperations implements BashOperations {
  #process: ChildProcessWithoutNullStreams | undefined;
  #cwd: string | undefined;
  #queue: Promise<void> = Promise.resolve();

  exec: BashOperations["exec"] = (command, cwd, options) => {
    const task = this.#queue.then(() => this.#execute(command, cwd, options));
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  async reset(): Promise<void> {
    const process = this.#process;
    this.#process = undefined;
    this.#cwd = undefined;
    if (!process || process.exitCode !== null) return;
    killProcessTree(process);
    await new Promise<void>((resolve) => process.once("close", () => resolve()));
  }

  async #execute(
    command: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
  ): Promise<{ exitCode: number | null }> {
    if (options.signal?.aborted) throw new Error("aborted");
    if (this.#cwd !== cwd) await this.reset();
    const process = this.#process ?? this.#start(cwd, options.env);
    const marker = `__VSPI_DSH_${randomUUID().replaceAll("-", "")}__`;
    const endPattern = new RegExp(`\\n?${marker}:(-?\\d+)\\r?\\n`);
    const markerPrefix = `\n${marker}:`;
    let markerBuffer = "";
    let visibleChars = 0;
    let clippingReported = false;

    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (error?: Error, exitCode: number | null = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else {
          reportClipping();
          resolve({ exitCode });
        }
      };
      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        process.stdout.off("data", onData);
        process.stderr.off("data", onData);
        process.off("close", onClose);
        process.off("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const failAndReset = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        appendVisible(markerBuffer);
        markerBuffer = "";
        reportClipping();
        void this.reset().then(() => reject(error), reject);
      };
      const onAbort = () => failAndReset(new Error("aborted"));
      const onClose = () => {
        this.#process = undefined;
        this.#cwd = undefined;
        finish(new Error("Persistent bash session exited before the command completed"));
      };
      const onError = (error: Error) => failAndReset(error);
      const onData = (chunk: Buffer) => {
        markerBuffer += chunk.toString("utf8");
        const match = endPattern.exec(markerBuffer);
        if (!match) {
          const safeChars = markerBuffer.length - pendingMarkerChars(markerBuffer, markerPrefix);
          appendVisible(markerBuffer.slice(0, safeChars));
          markerBuffer = markerBuffer.slice(safeChars);
          return;
        }
        const status = Number.parseInt(match[1] ?? "1", 10);
        appendVisible(markerBuffer.slice(0, match.index));
        markerBuffer = "";
        finish(undefined, status);
      };
      const appendVisible = (text: string) => {
        if (text.length === 0) return;
        const remaining = Math.max(0, MAX_OUTPUT_CHARS - visibleChars);
        if (remaining > 0) {
          options.onData(Buffer.from(text.slice(0, remaining)));
        }
        visibleChars += text.length;
      };
      const reportClipping = () => {
        if (visibleChars > MAX_OUTPUT_CHARS && !clippingReported) {
          clippingReported = true;
          options.onData(Buffer.from(TRUNCATED_MESSAGE));
        }
      };

      process.stdout.on("data", onData);
      process.stderr.on("data", onData);
      process.once("close", onClose);
      process.once("error", onError);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutSeconds = options.timeout ?? 120;
      timeoutHandle = setTimeout(
        () => failAndReset(new Error(`timeout:${timeoutSeconds}`)),
        Math.max(0, timeoutSeconds * 1_000),
      );
      const quoted = `'${command.replaceAll("'", `'"'"'`)}'`;
      process.stdin.write(`eval ${quoted}\n__vspi_status=$?\nprintf '\\n${marker}:%s\\n' "$__vspi_status"\n`);
    });
  }

  #start(cwd: string, env: NodeJS.ProcessEnv | undefined): ChildProcessWithoutNullStreams {
    const executable = globalThis.process.env.BASH ?? (globalThis.process.platform === "win32" ? "bash" : "/bin/bash");
    const process = spawn(executable, ["--noprofile", "--norc"], {
      cwd,
      detached: globalThis.process.platform !== "win32",
      env: env ?? processEnv(),
      stdio: "pipe",
      windowsHide: true,
    });
    this.#process = process;
    this.#cwd = cwd;
    return process;
  }
}

function pendingMarkerChars(text: string, markerPrefix: string): number {
  const markerStart = text.lastIndexOf(markerPrefix);
  if (markerStart >= 0 && /^-?\d*\r?$/.test(text.slice(markerStart + markerPrefix.length))) {
    return text.length - markerStart;
  }
  const maximum = Math.min(text.length, markerPrefix.length);
  for (let length = maximum; length > 0; length -= 1) {
    if (text.endsWith(markerPrefix.slice(0, length))) return length;
  }
  return 0;
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid && globalThis.process.platform !== "win32") {
    try {
      globalThis.process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may already have exited.
    }
  }
  child.kill("SIGKILL");
}

function processEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}
