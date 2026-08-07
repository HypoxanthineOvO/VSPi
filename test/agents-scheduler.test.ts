import { describe, expect, it } from "vitest";
import { AgentTreeScheduler } from "../src/agents/scheduler.js";

describe("AgentTreeScheduler", () => {
  it("enforces depth and cumulative tree limits", () => {
    const scheduler = new AgentTreeScheduler(16, 5, 128);
    let context = scheduler.root();
    for (let depth = 1; depth <= 5; depth += 1) context = scheduler.child(context, `run-${depth}`);
    expect(() => scheduler.child(context, "too-deep")).toThrow("depth limit");

    const second = new AgentTreeScheduler(16, 5, 2);
    const root = second.root();
    second.child(root, "one");
    second.child(root, "two");
    expect(() => second.child(root, "three")).toThrow("tree size limit");
  });

  it("rejects duplicate work and limits direct fanout", () => {
    const scheduler = new AgentTreeScheduler(16, 3, 12);
    const root = scheduler.root();
    scheduler.child(root, "one", "task-one");
    expect(() => scheduler.child(root, "duplicate", "task-one")).toThrow("Duplicate agent task");
    scheduler.child(root, "two", "task-two");
    scheduler.child(root, "three", "task-three");
    expect(() => scheduler.child(root, "four", "task-four")).toThrow("child limit");
  });

  it("releases a waiting ancestor generation slot for recursive delegation", async () => {
    const scheduler = new AgentTreeScheduler(1);
    const parent = scheduler.createLease();
    await parent.acquire();
    parent.suspend();

    const child = scheduler.createLease();
    await expect(child.acquire()).resolves.toBeUndefined();
    child.release();
    await expect(parent.resume()).resolves.toBeUndefined();
    parent.release();
  });

  it("serializes writers while allowing read-only operations through", async () => {
    const scheduler = new AgentTreeScheduler(4);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = scheduler.withWriter(true, async () => {
      order.push("first-start");
      markStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = scheduler.withWriter(true, async () => order.push("second"));
    await started;
    await scheduler.withWriter(false, async () => order.push("reader"));
    expect(order).toEqual(["first-start", "reader"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "reader", "first-end", "second"]);
  });
});
