import { describe, expect, it, vi } from "vitest";
import { CronRuntime } from "../src/cron/runtime.js";
import type { CronFire, CronStore, CronStoreEvent } from "../src/cron/types.js";

class MemoryStore implements CronStore {
  readonly events: CronStoreEvent[] = [];

  read(): readonly unknown[] {
    return this.events;
  }

  append(event: CronStoreEvent): void {
    this.events.push(structuredClone(event));
  }
}

function local(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

async function harness(start = local(2026, 8, 27, 10, 0, 30)) {
  let now = start;
  let idle = true;
  const store = new MemoryStore();
  const fires: Array<{ prompt: string; fire: CronFire }> = [];
  const runtime = await CronRuntime.restore({
    store,
    now: () => now,
    isIdle: () => idle,
    injectPrompt: (prompt, fire) => {
      fires.push({ prompt, fire });
    },
  });
  return {
    runtime,
    store,
    fires,
    setNow: (value: number) => {
      now = value;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

describe("foreground session Cron runtime", () => {
  it("defers while busy, then fires and removes a one-shot while idle", async () => {
    const h = await harness();
    const task = await h.runtime.create({ cron: "1 10 * * *", prompt: "check deploy", recurring: false });
    h.setNow(local(2026, 8, 27, 10, 1, 10));
    h.setIdle(false);
    await h.runtime.tick();
    expect(h.fires).toEqual([]);
    expect(h.runtime.list()).toHaveLength(1);

    h.setIdle(true);
    await h.runtime.tick();
    expect(h.fires).toHaveLength(1);
    expect(h.fires[0]?.prompt).toContain('coalescedCount="1"');
    expect(h.fires[0]?.prompt).toContain("check deploy");
    expect(h.runtime.list()).toEqual([]);
    expect(h.store.events.at(-1)).toEqual({ version: 1, operation: "delete", id: task.id });
  });

  it("coalesces all missed recurring occurrences into one injection and persists its cursor", async () => {
    const h = await harness();
    const task = await h.runtime.create({ cron: "* * * * *", prompt: "poll CI" });
    h.setNow(local(2026, 8, 27, 10, 3, 10));
    await h.runtime.tick();

    expect(h.fires).toHaveLength(1);
    expect(h.fires[0]?.fire.coalescedCount).toBe(3);
    expect(h.runtime.list()[0]?.lastFiredAt).toBe(local(2026, 8, 27, 10, 3));
    expect(h.store.events.at(-1)).toEqual({
      version: 1,
      operation: "cursor",
      id: task.id,
      lastFiredAt: local(2026, 8, 27, 10, 3),
    });
  });

  it("restores task and cursor state from the same session store", async () => {
    const h = await harness();
    const task = await h.runtime.create({ cron: "* * * * *", prompt: "resume me" });
    h.setNow(local(2026, 8, 27, 10, 2, 5));
    await h.runtime.tick();

    const restoredFires: CronFire[] = [];
    const restored = await CronRuntime.restore({
      store: h.store,
      now: () => local(2026, 8, 27, 10, 3, 5),
      isIdle: () => true,
      injectPrompt: (_prompt, fire) => {
        restoredFires.push(fire);
      },
    });
    expect(restored.list()).toEqual([{ ...task, lastFiredAt: local(2026, 8, 27, 10, 2) }]);
    await restored.tick();
    expect(restoredFires).toHaveLength(1);
    expect(restoredFires[0]?.coalescedCount).toBe(1);
  });

  it("persists deletion and does not restore deleted tasks", async () => {
    const h = await harness();
    const task = await h.runtime.create({ cron: "0 11 * * *", prompt: "temporary" });
    expect(await h.runtime.delete(task.id)).toBe(true);
    expect(await h.runtime.delete(task.id)).toBe(false);

    const restored = await CronRuntime.restore({ store: h.store, isIdle: () => true, injectPrompt: vi.fn() });
    expect(restored.list()).toEqual([]);
  });

  it("persists a visible failed state without automatically retrying prompt injection", async () => {
    let now = local(2026, 8, 27, 10, 0, 30);
    let fail = true;
    const store = new MemoryStore();
    const inject = vi.fn(async () => {
      if (fail) throw new Error("queue unavailable");
    });
    const runtime = await CronRuntime.restore({ store, now: () => now, isIdle: () => true, injectPrompt: inject });
    await runtime.create({ cron: "* * * * *", prompt: "retry me" });
    now = local(2026, 8, 27, 10, 1, 5);

    await runtime.tick();
    expect(runtime.list()[0]?.lastFiredAt).toBeUndefined();
    expect(runtime.list()[0]).toMatchObject({ lastAttemptAt: now, lastError: "queue unavailable" });
    expect(store.events.some((event) => event.operation === "cursor")).toBe(false);
    expect(store.events.at(-1)).toMatchObject({ operation: "failure", error: "queue unavailable" });

    fail = false;
    await runtime.tick();
    expect(inject).toHaveBeenCalledOnce();
    expect(runtime.list()[0]?.lastFiredAt).toBeUndefined();
  });

  it("fires an overdue native runAt one-shot once after the session becomes idle", async () => {
    const h = await harness();
    const runAt = local(2026, 8, 27, 12, 0);
    const task = await h.runtime.createAt({ runAt, prompt: "wake and continue" });
    h.setNow(local(2026, 8, 27, 12, 30));
    h.setIdle(false);
    await h.runtime.tick();
    expect(h.fires).toEqual([]);
    h.setIdle(true);
    await h.runtime.tick();
    expect(h.fires[0]?.prompt).toContain(`runAt="${new Date(runAt).toISOString()}"`);
    expect(h.store.events.at(-1)).toEqual({ version: 1, operation: "delete", id: task.id });
  });

  it("uses an unref 1-second foreground poll timer", async () => {
    const unref = vi.fn();
    const clear = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const schedule = vi.fn(() => timer) as unknown as typeof setInterval;
    const runtime = await CronRuntime.restore({
      store: new MemoryStore(),
      isIdle: () => true,
      injectPrompt: vi.fn(),
      setInterval: schedule,
      clearInterval: clear as unknown as typeof clearInterval,
    });

    runtime.start();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(unref).toHaveBeenCalledOnce();
    runtime.stop();
    expect(clear).toHaveBeenCalledWith(timer);
  });
});
