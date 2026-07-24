import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { UsageSnapshot } from "../src/domain/types.js";

describe("usage snapshot contract", () => {
  it("keeps current context occupancy separate from cumulative billed usage", () => {
    const snapshot: UsageSnapshot = {
      contextTokens: 50_176,
      contextWindow: 128_000,
      contextPercent: 39,
      inputTokens: 900_000,
      outputTokens: 120_000,
      costUsd: 7.25,
      currency: "CNY",
      source: "fixture",
      asOf: "2026-07-23",
      fxRate: 7.18,
    };

    expect(snapshot).toMatchObject({
      contextTokens: 50_176,
      contextWindow: 128_000,
      contextPercent: 39,
      inputTokens: 900_000,
      outputTokens: 120_000,
      costUsd: 7.25,
    });
  });

  it("uses explicit zero context capacity for the default offline snapshot", () => {
    expect(DEFAULT_USAGE).toMatchObject({
      contextTokens: 0,
      contextWindow: 0,
      contextPercent: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("represents post-compaction context occupancy as unknown while preserving the model window", () => {
    const snapshot: UsageSnapshot = {
      contextTokens: null,
      contextWindow: 128_000,
      contextPercent: null,
      inputTokens: 250_000,
      outputTokens: 40_000,
      costUsd: 9.75,
      currency: "CNY",
      source: "fixture",
      asOf: "2026-07-23",
      fxRate: 7.18,
    };

    expect(snapshot).toMatchObject({
      contextTokens: null,
      contextWindow: 128_000,
      contextPercent: null,
    });
  });
});
