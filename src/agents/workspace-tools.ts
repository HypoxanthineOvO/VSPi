import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export function createWorkspaceBashOperations(workspaceInput: string): BashOperations {
  const workspace = resolve(workspaceInput);
  return {
    async exec(command, cwd, options) {
      assertInside(workspace, resolve(cwd), "bash cwd");
      const args = [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        ...(looksNetworkCommand(command) ? ["--share-net"] : []),
        "--clearenv",
        "--setenv",
        "PATH",
        process.env.PATH ?? ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
        "--setenv",
        "HOME",
        "/tmp/vspi-home",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "LANG",
        process.env.LANG ?? "C.UTF-8",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind-try",
        "/bin",
        "/bin",
        "--ro-bind-try",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind-try",
        "/etc",
        "/etc",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/tmp/vspi-home",
        "--bind",
        workspace,
        workspace,
        "--tmpfs",
        join(workspace, ".vspi"),
        "--remount-ro",
        join(workspace, ".vspi"),
        "--chdir",
        resolve(cwd),
        "/bin/sh",
        "-lc",
        command,
      ];
      await access("/usr/bin/bwrap").catch(() => {
        throw new Error("Subagent bash is unavailable because bubblewrap is not installed");
      });
      return spawnSandbox(args, options);
    },
  };
}

function spawnSandbox(
  args: string[],
  options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolveRun, reject) => {
    const child = spawn("/usr/bin/bwrap", args, { stdio: ["ignore", "pipe", "pipe"] });
    let timeout: NodeJS.Timeout | undefined;
    const terminate = () => child.kill("SIGKILL");
    const onAbort = () => terminate();
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.timeout && options.timeout > 0) timeout = setTimeout(terminate, options.timeout);
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolveRun({ exitCode });
    });
  });
}

function looksNetworkCommand(command: string): boolean {
  return /\b(?:curl|wget|ssh|scp|rsync|npm\s+(?:install|publish)|pnpm\s+(?:add|install|publish)|yarn\s+add)\b/i.test(
    command,
  );
}

function assertInside(workspace: string, candidate: string, label: string): void {
  const relation = relative(workspace, candidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return;
  throw new Error(`${label} is outside the workspace boundary`);
}

function abortError(): Error {
  const error = new Error("Subagent bash was cancelled");
  error.name = "AbortError";
  return error;
}
