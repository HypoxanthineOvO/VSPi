import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  type GrepToolDetails,
  type GrepToolInput,
  type TruncationResult,
  truncateLine,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_LIMIT = 100;
const MAX_LINE_LENGTH = 500;

type VspiGrepDetails = GrepToolDetails & {
  observedBeforeTermination?: { lines: number; bytes: number; complete: false };
};

export function createVspiGrepToolDefinition(cwd: string): ReturnType<typeof createGrepToolDefinition> {
  const native = createGrepToolDefinition(cwd);
  return {
    ...native,
    execute: async (_toolCallId, input, signal) => executeGrep(cwd, input, signal),
  };
}

async function executeGrep(cwd: string, input: GrepToolInput, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Operation aborted");

  const searchPath = resolve(cwd, input.path || ".");
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(searchPath)).isDirectory();
  } catch {
    throw new Error(`Path not found: ${searchPath}`);
  }

  const context = input.context && input.context > 0 ? Math.floor(input.context) : 0;
  const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
  const args = [
    "--no-config",
    "--null",
    "--line-number",
    "--with-filename",
    "--color=never",
    "--hidden",
    "--max-columns",
    String(MAX_LINE_LENGTH),
    "--max-columns-preview",
  ];
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.glob) args.push("--glob", input.glob);
  if (context > 0) args.push("--context", String(context));
  args.push("--", input.pattern, searchPath);

  return new Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: VspiGrepDetails | undefined;
  }>((resolvePromise, rejectPromise) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let aborted = false;
    let matchLimitReached = false;
    let stoppedForLimit = false;
    let stoppedForBytes = false;
    let matchCount = 0;
    let trailingContext = 0;
    let linesTruncated = false;
    let stderr = "";
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const outputLines: string[] = [];
    let outputBytes = 0;
    let observedLines = 0;
    let observedBytes = 0;

    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const stopChild = () => terminateChild(child);
    const onAbort = () => {
      aborted = true;
      stopChild();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8", 0, 8192 - stderr.length);
    });

    const appendLine = (line: string): boolean => {
      const separatorBytes = outputLines.length === 0 ? 0 : 1;
      const bytes = Buffer.byteLength(line, "utf8") + separatorBytes;
      observedLines += 1;
      observedBytes += bytes;
      if (outputBytes + bytes > DEFAULT_MAX_BYTES) {
        stoppedForBytes = true;
        stopChild();
        return false;
      }
      outputLines.push(line);
      outputBytes += bytes;
      return true;
    };

    const formatPath = (filePath: string) => {
      if (isDirectory) {
        const rel = relative(searchPath, filePath);
        if (rel && !rel.startsWith("..")) return rel.replaceAll("\\", "/");
      }
      return basename(filePath);
    };

    const consume = () => {
      while (!settled && !stoppedForBytes) {
        if (pending.subarray(0, 3).equals(Buffer.from("--\n"))) {
          pending = pending.subarray(3);
          if (outputLines.at(-1) !== "--" && !appendLine("--")) return;
          continue;
        }
        const nul = pending.indexOf(0);
        if (nul < 0) return;
        const newline = pending.indexOf(10, nul + 1);
        if (newline < 0) return;

        const filePath = pending.subarray(0, nul).toString("utf8");
        const record = pending
          .subarray(nul + 1, newline)
          .toString("utf8")
          .replace(/\r$/u, "");
        pending = pending.subarray(newline + 1);
        const parsed = /^(\d+)(:|-)(.*)$/u.exec(record);
        if (!parsed) continue;

        const [, lineNumber = "", marker = ":", rawText = ""] = parsed;
        const isMatch = marker === ":";
        if (isMatch) {
          if (matchCount >= limit) {
            stoppedForLimit = true;
            stopChild();
            return;
          }
          matchCount += 1;
          if (matchCount === limit) {
            matchLimitReached = true;
            trailingContext = context;
          }
        } else if (matchCount === limit && trailingContext > 0) {
          trailingContext -= 1;
        }

        const { text, wasTruncated } = truncateLine(rawText, MAX_LINE_LENGTH);
        linesTruncated ||= wasTruncated || rawText.includes("[... omitted end of long line]");
        const path = formatPath(filePath);
        const formatted = isMatch ? `${path}:${lineNumber}: ${text}` : `${path}-${lineNumber}- ${text}`;
        if (!appendLine(formatted)) return;

        if (matchCount === limit && (context === 0 || trailingContext === 0)) {
          stoppedForLimit = true;
          stopChild();
          return;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      consume();
    });
    child.on("error", (error) => {
      settle(() => rejectPromise(new Error(`Failed to run ripgrep: ${error.message}`)));
    });
    child.on("close", (code) => {
      consume();
      if (aborted) {
        settle(() => rejectPromise(new Error("Operation aborted")));
        return;
      }
      if (!stoppedForLimit && !stoppedForBytes && code !== 0 && code !== 1) {
        settle(() => rejectPromise(new Error(stderr.trim() || `ripgrep exited with code ${code}`)));
        return;
      }
      if (matchCount === 0 && !stoppedForBytes) {
        settle(() => resolvePromise({ content: [{ type: "text", text: "No matches found" }], details: undefined }));
        return;
      }

      const details: VspiGrepDetails = {};
      const notices: string[] = [];
      if (matchLimitReached) {
        details.matchLimitReached = limit;
        notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
      }
      if (stoppedForBytes) {
        const truncation: TruncationResult = {
          content: outputLines.join("\n"),
          truncated: true,
          truncatedBy: "bytes",
          totalLines: observedLines,
          totalBytes: observedBytes,
          outputLines: outputLines.length,
          outputBytes,
          lastLinePartial: false,
          firstLineExceedsLimit: outputLines.length === 0,
          maxLines: Number.MAX_SAFE_INTEGER,
          maxBytes: DEFAULT_MAX_BYTES,
        };
        details.truncation = truncation;
        details.observedBeforeTermination = { lines: observedLines, bytes: observedBytes, complete: false };
        notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
      }
      if (linesTruncated) {
        details.linesTruncated = true;
        notices.push(`Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
      }
      let text = outputLines.join("\n");
      if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
      settle(() =>
        resolvePromise({
          content: [{ type: "text", text }],
          details: Object.keys(details).length > 0 ? details : undefined,
        }),
      );
    });
  });
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 250);
  timer.unref();
}
