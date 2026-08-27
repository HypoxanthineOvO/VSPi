import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentTaskRuntime } from "../src/agents/task-runtime.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("Agent task process recovery", () => {
  it("marks a task lost after its owning process is killed and preserves output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-task-crash-"));
    const ready = join(directory, "ready");
    const child = spawn(
      join(ROOT, "node_modules", ".bin", "tsx"),
      [join(ROOT, "test", "fixtures", "agent-task-crash-worker.ts"), directory, ready],
      { stdio: "ignore" },
    );
    try {
      await waitUntil(async () =>
        access(ready).then(
          () => true,
          () => false,
        ),
      );
      child.kill("SIGKILL");
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      const restored = await AgentTaskRuntime.open({ directory });
      expect(restored.get("agent-crash0001")).toMatchObject({ status: "lost", notification: "pending" });
      expect((await restored.output("agent-crash0001", "main")).preview).toBe("before crash");
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }
  });
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("worker did not become ready");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}
