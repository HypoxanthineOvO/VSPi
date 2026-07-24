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
});
