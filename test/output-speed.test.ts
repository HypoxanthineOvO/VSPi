import { describe, expect, it } from "vitest";
import { OutputSpeedTracker } from "../src/backend/output-speed.js";

describe("output speed telemetry", () => {
  it("uses a rolling two-second content-delta window and expires idle speed", () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);

    expect(tracker.recordDelta("1234")).toEqual({ now: null, average: null });
    now = 1_500;
    expect(tracker.recordDelta("5678").now).toBe(4);
    now = 2_500;
    expect(tracker.snapshot().now).toBeCloseTo(4 / 3);
    now = 3_501;
    expect(tracker.snapshot().now).toBeNull();
  });

  it("weights completed response speed by authoritative output usage and content duration", () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.recordDelta("first");
    now = 1_500;
    tracker.recordDelta("last");
    expect(tracker.finish(20)).toEqual({ now: null, average: 40 });

    now = 3_000;
    tracker.recordDelta("first");
    now = 4_000;
    tracker.recordDelta("last");
    expect(tracker.finish(30).average).toBeCloseTo(100 / 3);
  });
});
