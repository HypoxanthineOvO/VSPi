import { describe, expect, it } from "vitest";
import {
  catalogSnapshotIsStale,
  PRICE_SCHEDULES,
  priceTokensCny,
  resolveKnownCnySchedule,
  resolveOfficialCnySchedule,
} from "../src/domain/pricing.js";

describe("C17 price schedules", () => {
  it("keeps official, catalog, cache-write, and context-limit provenance explicit", () => {
    expect(PRICE_SCHEDULES.deepseekFlashOld).toMatchObject({
      provider: "DeepSeek",
      model: "V4 Flash",
      currency: "CNY",
      provenance: "officialCny",
      sourceVersion: "2026-04-24",
      cacheRead: 0.2,
      uncached: 1,
      output: 2,
    });
    expect(PRICE_SCHEDULES.deepseekProPeak).toMatchObject({
      provenance: "officialCny",
      cacheRead: 0.3,
      uncached: 9,
      output: 27,
    });
    expect(PRICE_SCHEDULES.kimiK3).toMatchObject({
      provenance: "officialCny",
      cacheRead: 2,
      uncached: 20,
      output: 100,
      contextWindow: 1_048_576,
    });
    expect(PRICE_SCHEDULES.glm52).toMatchObject({
      provenance: "catalogEstimateCny",
      cacheRead: 1.768,
      uncached: 9.52,
      output: 29.92,
    });
    expect(PRICE_SCHEDULES.luna56).toMatchObject({
      provenance: "catalogEstimateCny",
      cacheWrite: 1.7,
      contextWindow: 272_000,
    });
    expect(PRICE_SCHEDULES.terra56).toMatchObject({
      provenance: "catalogEstimateCny",
      cacheRead: 1.36,
      uncached: 13.6,
      cacheWrite: 17,
      output: 81.6,
    });
    expect(PRICE_SCHEDULES.sol56).toMatchObject({
      provenance: "catalogEstimateCny",
      cacheRead: 3.4,
      uncached: 34,
      cacheWrite: 42.5,
      output: 204,
    });
  });

  it("resolves old, idle, and Beijing peak DeepSeek prices by timestamp", () => {
    expect(resolveOfficialCnySchedule("deepseek", "V4 Flash", Date.parse("2026-08-16T23:59:59+08:00"))?.id).toBe(
      "deepseek-v4-flash-old",
    );
    expect(resolveOfficialCnySchedule("deepseek", "V4 Pro", Date.parse("2026-08-17T08:00:00+08:00"))?.id).toBe(
      "deepseek-v4-pro-idle",
    );
    expect(resolveOfficialCnySchedule("deepseek", "V4 Pro", Date.parse("2026-08-17T09:00:00+08:00"))?.id).toBe(
      "deepseek-v4-pro-peak",
    );
    expect(resolveOfficialCnySchedule("deepseek", "V4 Pro", Date.parse("2026-08-17T18:00:00+08:00"))?.id).toBe(
      "deepseek-v4-pro-idle",
    );
  });

  it("resolves known catalog prices from normalized complete model names without guessing adjacent versions", () => {
    const now = Date.parse("2026-08-28T12:00:00+08:00");
    expect(resolveKnownCnySchedule("vsplab", "GPT-5.6 Sol", now)?.id).toBe("gpt-5.6-sol");
    expect(resolveKnownCnySchedule("VSPLAB", "gpt_5.6_terra", now)?.id).toBe("gpt-5.6-terra");
    expect(resolveKnownCnySchedule("open-code-go", " GLM 5.2 ", now)?.id).toBe("glm-5.2");
    expect(resolveKnownCnySchedule("vsplab", "GLM-5.3", now)).toBeUndefined();
    expect(resolveKnownCnySchedule("vsplab", "gpt-5.6-sol-preview", now)).toBeUndefined();
  });

  it("prices each token bucket and detects stale or invalid catalog dates", () => {
    expect(
      priceTokensCny(PRICE_SCHEDULES.luna56, {
        cacheRead: 1_000_000,
        uncached: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(11.356);
    expect(catalogSnapshotIsStale("2026-08-17", Date.parse("2026-08-20T00:00:00Z"))).toBe(false);
    expect(catalogSnapshotIsStale("2026-06-01", Date.parse("2026-08-20T00:00:00Z"))).toBe(true);
    expect(catalogSnapshotIsStale("invalid", Date.parse("2026-08-20T00:00:00Z"))).toBe(true);
  });
});
