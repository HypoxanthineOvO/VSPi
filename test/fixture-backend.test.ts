import { describe, expect, it, vi } from "vitest";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import type { UsageSnapshot } from "../src/domain/types.js";

describe("offline fixture backend defaults", () => {
  it("starts empty and identifies itself explicitly instead of impersonating a real model", async () => {
    const backend = new FixtureBackend();
    const usage: UsageSnapshot[] = [];

    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: (snapshot) => usage.push(snapshot),
      onNotice: vi.fn(),
    });

    expect.soft(backend.modelLabel).toContain("Offline Fixture");
    expect.soft(backend.modelLabel).not.toMatch(/kimi/i);
    expect.soft(usage).toHaveLength(1);
    expect.soft(usage[0]).toMatchObject({
      contextTokens: 0,
      contextWindow: 0,
      contextPercent: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect.soft(await backend.listSessions()).toEqual([]);

    await backend.dispose();
  });

  it("mirrors native queue and cancellation semantics for offline interaction testing", async () => {
    const backend = new FixtureBackend();
    const queueUpdates: Array<{ steering: number; followUp: number }> = [];
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onQueueUpdate: (queue) => queueUpdates.push(queue),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    const active = backend.send("primary", { attachments: [], effort: "high", behavior: "prompt" });
    await expect(backend.send("correction", { attachments: [], effort: "high", behavior: "prompt" })).resolves.toEqual({
      status: "queued",
      delivery: "steer",
    });
    await expect(backend.send("summary", { attachments: [], effort: "high", behavior: "followUp" })).resolves.toEqual({
      status: "queued",
      delivery: "followUp",
    });
    expect(queueUpdates).toContainEqual({ steering: 1, followUp: 1 });

    await expect(backend.cancel()).resolves.toEqual({ queuedMessages: ["correction", "summary"] });
    await expect(active).resolves.toEqual({ status: "cancelled" });
    expect(queueUpdates.at(-1)).toEqual({ steering: 0, followUp: 0 });
    await backend.dispose();
  });
});
