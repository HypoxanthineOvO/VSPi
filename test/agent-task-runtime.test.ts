import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentTaskRuntime } from "../src/agents/task-runtime.js";
import { createAgentTaskTools } from "../src/agents/task-tools.js";

describe("Kimi-style Agent task runtime", () => {
  it("persists metadata/output and restores an interrupted task as lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-tasks-"));
    const first = await AgentTaskRuntime.open({ directory });
    const registered = await first.register({
      taskId: "agent-deadbeef",
      agentId: "child-1",
      ownerAgentId: "main",
      description: "long research",
      detached: true,
    });
    expect(registered.signal.aborted).toBe(false);
    await first.appendOutput(registered.taskId, "partial output");

    const restored = await AgentTaskRuntime.open({ directory });
    expect(restored.get(registered.taskId)).toMatchObject({
      status: "lost",
      stopReason: "Task belonged to a previous VSPi process",
      notification: "pending",
    });
    expect((await restored.output(registered.taskId, "main")).preview).toBe("partial output");
  });

  it("persists terminal output and delivers completion once after retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-notify-"));
    let fail = true;
    const delivered = vi.fn(async () => {
      if (fail) throw new Error("main busy");
    });
    const runtime = await AgentTaskRuntime.open({ directory, deliverNotification: delivered });
    const { taskId } = await runtime.register({
      agentId: "child-2",
      ownerAgentId: "main",
      description: "audit",
      detached: true,
    });
    await runtime.settle(taskId, { status: "completed", output: "final result" });
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    expect(runtime.get(taskId)?.notification).toBe("pending");
    fail = false;
    await runtime.retryNotifications();
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(runtime.get(taskId)?.notification).toBe("delivered");
    const output = await runtime.output(taskId, "main");
    expect(output.preview).toBe("final result");
    expect(await readFile(output.outputPath ?? "", "utf8")).toBe("final result");
    const restored = await AgentTaskRuntime.open({ directory, deliverNotification: delivered });
    await restored.retryNotifications();
    expect(delivered).toHaveBeenCalledTimes(2);
  });

  it("separates timeout, stop, wait timeout, and owner isolation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-stop-"));
    const runtime = await AgentTaskRuntime.open({ directory });
    const timed = await runtime.register({
      agentId: "child-timed",
      ownerAgentId: "main",
      description: "timeout",
      detached: true,
      timeoutMs: 10,
    });
    await vi.waitFor(() => expect(runtime.get(timed.taskId)?.status).toBe("timed_out"));

    const running = await runtime.register({
      agentId: "child-running",
      ownerAgentId: "main",
      description: "running",
      detached: true,
    });
    expect(await runtime.wait(running.taskId, "main", 5)).toMatchObject({ status: "running" });
    await expect(runtime.output(running.taskId, "other")).rejects.toThrow("Unknown background task");
    expect(await runtime.stop(running.taskId, "user stop", "killed", "main")).toMatchObject({
      status: "killed",
      stopReason: "user stop",
    });
  });

  it("releases a foreground task when it is detached", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-detach-"));
    const runtime = await AgentTaskRuntime.open({ directory });
    const task = await runtime.register({
      agentId: "child-detach",
      ownerAgentId: "main",
      description: "detach",
      detached: false,
    });
    const release = runtime.waitForForegroundRelease(task.taskId);
    await runtime.detach(task.taskId, "main");
    await expect(release).resolves.toBe("detached");
    expect(runtime.get(task.taskId)).toMatchObject({ status: "running", detached: true });
  });

  it("exposes TaskList, TaskOutput, TaskStop, and WaitFor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-tools-"));
    const runtime = await AgentTaskRuntime.open({ directory });
    const tools = createAgentTaskTools(runtime);
    expect(tools.map((tool) => tool.name)).toEqual(["TaskList", "TaskOutput", "TaskStop", "WaitFor"]);
  });

  it("stops a task whose output exceeds the configured cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-output-cap-"));
    const runtime = await AgentTaskRuntime.open({ directory, maxOutputBytes: 5 });
    const task = await runtime.register({
      agentId: "child-output",
      ownerAgentId: "main",
      description: "large output",
      detached: true,
    });
    await runtime.appendOutput(task.taskId, "123456");
    await vi.waitFor(() => expect(runtime.get(task.taskId)?.status).toBe("failed"));
    expect(runtime.get(task.taskId)?.stopReason).toContain("Output limit exceeded");
  });

  it("WaitFor without an id snapshots active tasks and suppresses their automatic notification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-wait-any-"));
    const runtime = await AgentTaskRuntime.open({ directory });
    const first = await runtime.register({
      agentId: "child-first",
      ownerAgentId: "main",
      description: "first",
      detached: true,
    });
    await runtime.register({
      agentId: "child-second",
      ownerAgentId: "main",
      description: "second",
      detached: true,
    });
    const waiting = runtime.waitAny("main", 1_000);
    await runtime.settle(first.taskId, { status: "completed", output: "done" });
    expect(await waiting).toMatchObject([{ taskId: first.taskId, notification: "suppressed" }]);
  });

  it("handles a concurrent task soak without losing metadata or output ordering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-agent-soak-"));
    const runtime = await AgentTaskRuntime.open({ directory });
    const tasks = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        runtime.register({
          agentId: `child-${index}`,
          ownerAgentId: "main",
          description: `task ${index}`,
          detached: true,
        }),
      ),
    );
    await Promise.all(
      tasks.map(async ({ taskId }, index) => {
        await Promise.all([runtime.appendOutput(taskId, `${index}:a\n`), runtime.appendOutput(taskId, `${index}:b\n`)]);
        await runtime.settle(taskId, { status: index % 10 === 0 ? "failed" : "completed" });
      }),
    );
    expect(runtime.list("main", true, 100)).toEqual([]);
    expect(runtime.list("main", false, 100)).toHaveLength(100);
    const restored = await AgentTaskRuntime.open({ directory });
    expect(restored.list("main", false, 100)).toHaveLength(100);
    for (const [index, task] of tasks.slice(0, 10).entries()) {
      expect((await restored.output(task.taskId, "main")).preview).toBe(`${index}:a\n${index}:b\n`);
    }
  });
});
