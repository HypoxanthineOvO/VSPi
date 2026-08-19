import { describe, expect, it } from "vitest";
import { AgentTreeScheduler } from "../src/agents/scheduler.js";

describe("AgentTreeScheduler", () => {
  it("enforces depth while allowing unbounded tree growth (C19 P0-2)", () => {
    const scheduler = new AgentTreeScheduler(16, 5, 128);
    let context = scheduler.root();
    for (let depth = 1; depth <= 5; depth += 1) context = scheduler.child(context, `run-${depth}`);
    expect(() => scheduler.child(context, "too-deep")).toThrow("depth limit");

    // tree size 不再是拒绝条件：超过 maxAgentsPerTree 仍可继续 spawn。
    const second = new AgentTreeScheduler(16, 5, 2);
    const root = second.root();
    second.child(root, "one");
    second.child(root, "two");
    expect(() => second.child(root, "three")).not.toThrow();
  });

  it("rejects duplicate work but no longer caps direct fanout (C19 P0-2)", () => {
    const scheduler = new AgentTreeScheduler(16, 3, 12);
    const root = scheduler.root();
    scheduler.child(root, "one", "task-one");
    expect(() => scheduler.child(root, "duplicate", "task-one")).toThrow("Duplicate agent task");
    scheduler.child(root, "two", "task-two");
    scheduler.child(root, "three", "task-three");
    // per-parent child=3 硬限制已移除，第 4 个直接子节点正常启动。
    expect(() => scheduler.child(root, "four", "task-four")).not.toThrow();
  });

  it("keeps spawning after tree token or cost figures exceed warning lines (C19 P0-2)", () => {
    const tokenScheduler = new AgentTreeScheduler(16, 3, 12, 1_000, 20);
    const tokenRoot = tokenScheduler.root();
    tokenScheduler.recordUsage(tokenRoot.treeId, 1_000, 0);
    // 预算仅遥测：超限后仍允许 spawn，结果可通过 budget() 查询。
    expect(() => tokenScheduler.child(tokenRoot, "over-token-budget")).not.toThrow();
    expect(tokenScheduler.budget(tokenRoot.treeId).tokens).toBeGreaterThanOrEqual(1_000);

    const costScheduler = new AgentTreeScheduler(16, 3, 12, 500_000, 1);
    const costRoot = costScheduler.root();
    costScheduler.recordUsage(costRoot.treeId, 1, 1);
    expect(() => costScheduler.child(costRoot, "over-cost-budget")).not.toThrow();
  });

  it("aborts the tree signal and rejects future descendants on cancellation", () => {
    const scheduler = new AgentTreeScheduler();
    const root = scheduler.root();
    const signal = scheduler.treeSignal(root.treeId);
    scheduler.cancelTree(root.treeId);
    expect(signal.aborted).toBe(true);
    expect(() => scheduler.child(root, "after-cancel")).toThrow("cancelled");
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
