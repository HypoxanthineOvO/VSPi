import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeepSeekPersistentBashOperations } from "../src/deepseek/persistent-bash.js";

async function execute(
  operations: DeepSeekPersistentBashOperations,
  command: string,
  cwd: string,
  options: { signal?: AbortSignal; timeout?: number } = {},
) {
  let output = "";
  const result = await operations.exec(command, cwd, {
    ...options,
    onData: (chunk) => {
      output += chunk.toString("utf8");
    },
  });
  return { output, exitCode: result.exitCode };
}

describe("DeepSeek persistent bash operations", () => {
  it("serializes calls and preserves cwd and exported environment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-dsh-bash-"));
    await mkdir(join(workspace, "nested"));
    const operations = new DeepSeekPersistentBashOperations();
    try {
      expect(await execute(operations, "export DS_TEST=kept; cd nested", workspace)).toEqual({
        output: "",
        exitCode: 0,
      });
      const [first, second] = await Promise.all([
        execute(operations, 'printf "%s:%s" "$DS_TEST" "$(basename "$PWD")"', workspace),
        execute(operations, "printf second", workspace),
      ]);
      expect([first, second]).toEqual([
        { output: "kept:nested", exitCode: 0 },
        { output: "second", exitCode: 0 },
      ]);
    } finally {
      await operations.reset();
    }
  });

  it("returns exit status, clips long output, and resets after timeout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-dsh-bash-reset-"));
    const operations = new DeepSeekPersistentBashOperations();
    try {
      expect(await execute(operations, "printf failed; bash -c 'exit 7'", workspace)).toEqual({
        output: "failed",
        exitCode: 7,
      });
      const clipped = await execute(operations, "printf '%*s' 17000 ''", workspace);
      expect(clipped.output).toHaveLength(16_019);
      expect(clipped.output.endsWith("\n<response clipped>")).toBe(true);
      const heavilyClipped = await execute(operations, "printf '%*s' 2000000 ''", workspace);
      expect(heavilyClipped.output).toHaveLength(16_019);
      expect(heavilyClipped.output.endsWith("\n<response clipped>")).toBe(true);
      await expect(execute(operations, "export LOST=yes; sleep 1", workspace, { timeout: 0.02 })).rejects.toThrow(
        "timeout:0.02",
      );
      expect(await execute(operations, 'printf "$LOST"; test -n "$LOST" || printf unset', workspace)).toEqual({
        output: "unset",
        exitCode: 0,
      });
    } finally {
      await operations.reset();
    }
  });

  it("streams output before a long-running command completes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-dsh-bash-stream-"));
    const operations = new DeepSeekPersistentBashOperations();
    let output = "";
    try {
      const command = operations.exec("printf first; sleep 0.08; printf second", workspace, {
        onData: (chunk) => {
          output += chunk.toString("utf8");
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(output).toBe("first");
      await expect(command).resolves.toEqual({ exitCode: 0 });
      expect(output).toBe("firstsecond");
    } finally {
      await operations.reset();
    }
  });

  it("kills descendants and resets the shell before timeout or abort returns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-dsh-bash-tree-"));
    const operations = new DeepSeekPersistentBashOperations();
    const timeoutTarget = join(workspace, "timeout-side-effect");
    const abortTarget = join(workspace, "abort-side-effect");
    try {
      await expect(
        execute(operations, `(sleep 0.15; printf late > '${timeoutTarget}') & wait`, workspace, { timeout: 0.02 }),
      ).rejects.toThrow("timeout:0.02");
      const controller = new AbortController();
      const aborted = execute(operations, `(sleep 0.15; printf late > '${abortTarget}') & wait`, workspace, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(aborted).rejects.toThrow("aborted");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(access(timeoutTarget)).rejects.toThrow();
      await expect(access(abortTarget)).rejects.toThrow();
      expect(await execute(operations, "printf clean", workspace)).toEqual({ output: "clean", exitCode: 0 });
    } finally {
      await operations.reset();
    }
  });
});
