import { describe, expect, it } from "vitest";
import {
  CACHE_SIMULATION_SCENARIOS,
  compareCacheHitRates,
  priceCacheTrace,
  simulateCacheTrace,
  summarizeCacheTurns,
} from "../src/domain/cache-simulation.js";
import { PRICE_SCHEDULES } from "../src/domain/pricing.js";

function scenario(id: "short" | "ultralong") {
  const value = CACHE_SIMULATION_SCENARIOS.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Missing cache simulation scenario: ${id}`);
  return value;
}

describe("C17 deterministic cache simulation", () => {
  it("moves mutable-state changes from an early prefix reset to append-only history", () => {
    const trace = simulateCacheTrace(scenario("short"));

    expect(trace.before).toEqual([
      {
        turn: 1,
        event: "cold-start",
        promptTokens: 4096,
        stablePrefixTokens: 0,
        cacheRead: 0,
        uncached: 4096,
        cacheWrite: 0,
        output: 512,
        repeatedBilledTokens: 0,
      },
      {
        turn: 2,
        event: "ordinary",
        promptTokens: 4224,
        stablePrefixTokens: 4096,
        cacheRead: 4096,
        uncached: 128,
        cacheWrite: 0,
        output: 512,
        repeatedBilledTokens: 0,
      },
      {
        turn: 3,
        event: "state-change",
        promptTokens: 4352,
        stablePrefixTokens: 2048,
        cacheRead: 2048,
        uncached: 2304,
        cacheWrite: 0,
        output: 512,
        repeatedBilledTokens: 2176,
      },
      {
        turn: 4,
        event: "ordinary",
        promptTokens: 4480,
        stablePrefixTokens: 4352,
        cacheRead: 4352,
        uncached: 128,
        cacheWrite: 0,
        output: 512,
        repeatedBilledTokens: 0,
      },
      {
        turn: 5,
        event: "review-boundary",
        promptTokens: 4608,
        stablePrefixTokens: 2048,
        cacheRead: 2048,
        uncached: 2560,
        cacheWrite: 0,
        output: 512,
        repeatedBilledTokens: 2432,
      },
      {
        turn: 6,
        event: "ordinary",
        promptTokens: 4736,
        stablePrefixTokens: 4608,
        cacheRead: 4608,
        uncached: 128,
        cacheWrite: 0,
        output: 512,
        repeatedBilledTokens: 0,
      },
    ]);
    expect(
      trace.after.map(({ cacheRead, uncached, repeatedBilledTokens }) => ({
        cacheRead,
        uncached,
        repeatedBilledTokens,
      })),
    ).toEqual([
      { cacheRead: 0, uncached: 4096, repeatedBilledTokens: 0 },
      { cacheRead: 4096, uncached: 128, repeatedBilledTokens: 0 },
      { cacheRead: 4224, uncached: 128, repeatedBilledTokens: 0 },
      { cacheRead: 4352, uncached: 128, repeatedBilledTokens: 0 },
      { cacheRead: 4480, uncached: 128, repeatedBilledTokens: 0 },
      { cacheRead: 4608, uncached: 128, repeatedBilledTokens: 0 },
    ]);
  });

  it("matches a hand-calculated short-trace summary and price delta", () => {
    const trace = simulateCacheTrace(scenario("short"));

    expect(summarizeCacheTurns(trace.before)).toEqual({
      promptTokens: 26_496,
      cacheRead: 17_152,
      uncached: 9_344,
      cacheWrite: 0,
      output: 3_072,
      repeatedBilledTokens: 4_608,
      cacheHitRate: 17_152 / 26_496,
    });
    expect(summarizeCacheTurns(trace.after)).toEqual({
      promptTokens: 26_496,
      cacheRead: 21_760,
      uncached: 4_736,
      cacheWrite: 0,
      output: 3_072,
      repeatedBilledTokens: 0,
      cacheHitRate: 21_760 / 26_496,
    });
    const cost = priceCacheTrace(trace, PRICE_SCHEDULES.deepseekFlashOld);
    expect(cost.beforeCny).toBeCloseTo((17_152 * 0.2 + 9_344 * 1 + 3_072 * 2) / 1_000_000);
    expect(cost.savedCny).toBeCloseTo((4_608 * (1 - 0.2)) / 1_000_000);
  });

  it("separates all-turn, warm-turn, and latest-turn cache hit rates", () => {
    const comparison = compareCacheHitRates(simulateCacheTrace(scenario("short")));

    expect(comparison).toEqual({
      before: {
        allTurns: 17_152 / 26_496,
        warmTurns: 17_152 / (26_496 - 4_096),
        latestTurn: 4_608 / 4_736,
      },
      after: {
        allTurns: 21_760 / 26_496,
        warmTurns: 21_760 / (26_496 - 4_096),
        latestTurn: 4_608 / 4_736,
      },
    });
  });

  it("marks the 512K fixture inapplicable to 272K models without truncation", () => {
    const trace = simulateCacheTrace(scenario("ultralong"));

    expect(priceCacheTrace(trace, PRICE_SCHEDULES.luna56)).toMatchObject({
      applicable: false,
      beforeCny: null,
      afterCny: null,
      savedCny: null,
      savedRatio: null,
    });
    expect(priceCacheTrace(trace, PRICE_SCHEDULES.kimiK3).applicable).toBe(true);
  });
});
