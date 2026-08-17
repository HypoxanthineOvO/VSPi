import { describe, expect, it } from "vitest";
import { calculateCacheTelemetry, calculateOfficialCostCny } from "../src/backend/usage-telemetry.js";

function assistant(options: {
  input: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputCost?: number;
  cacheReadCost?: number;
  timestamp?: number;
}) {
  return {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    timestamp: options.timestamp ?? Date.parse("2026-08-17T10:00:00+08:00"),
    usage: {
      input: options.input,
      output: options.output ?? 0,
      cacheRead: options.cacheRead ?? 0,
      cacheWrite: options.cacheWrite ?? 0,
      cost: {
        input: options.inputCost ?? 0,
        output: 0,
        cacheRead: options.cacheReadCost ?? 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  };
}

function session(entries: unknown[]) {
  return {
    messages: entries.flatMap((entry) =>
      typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message"
        ? [(entry as { message: unknown }).message]
        : [],
    ),
    sessionManager: { getBranch: () => entries },
  } as never;
}

describe("usage telemetry", () => {
  it("calculates cache rates, miss cost, and official CNY from the session timeline", () => {
    const first = assistant({ input: 1_999, cacheWrite: 1, inputCost: 0.01999 });
    const second = assistant({ input: 2_000, output: 100, inputCost: 0.02 });
    const source = session([
      { type: "message", message: first },
      { type: "message", message: second },
    ]);

    expect(
      calculateCacheTelemetry({
        session: source,
        latest: second,
        totals: { input: 3_999, cacheRead: 0, cacheWrite: 1 },
        catalogCacheReadRate: () => 1,
      }),
    ).toEqual({
      reported: true,
      recentHitPercent: 0,
      sessionHitPercent: 0,
      missedTokens: 2_000,
      missedCostUsd: 0.018000000000000002,
    });
    expect(calculateOfficialCostCny(source, second)).toBe(0.0129);
  });

  it("does not infer cache support and does not carry miss detection across compaction", () => {
    const uncached = assistant({ input: 2_000 });
    expect(
      calculateCacheTelemetry({
        session: session([{ type: "message", message: uncached }]),
        latest: uncached,
        totals: { input: 2_000, cacheRead: 0, cacheWrite: 0 },
        catalogCacheReadRate: () => 1,
      }),
    ).toEqual({
      reported: false,
      recentHitPercent: null,
      sessionHitPercent: null,
      missedTokens: null,
      missedCostUsd: null,
    });

    const after = assistant({ input: 2_000, cacheWrite: 1 });
    expect(
      calculateCacheTelemetry({
        session: session([
          { type: "message", message: assistant({ input: 2_000, cacheWrite: 1 }) },
          { type: "compaction" },
          { type: "message", message: after },
        ]),
        latest: after,
        totals: { input: 4_000, cacheRead: 0, cacheWrite: 2 },
        catalogCacheReadRate: () => 1,
      }).missedTokens,
    ).toBe(0);
  });
});
