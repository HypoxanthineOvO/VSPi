import { describe, expect, it } from "vitest";
import { computeNextCronRun, parseCronExpression } from "../src/cron/expression.js";

describe("5-field local-time cron expressions", () => {
  it("supports lists, ranges, steps, Sunday 7, and standard day OR semantics", () => {
    const parsed = parseCronExpression("*/15 9-10 27 8 4,7");
    expect([...parsed.minutes]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hours]).toEqual([9, 10]);
    expect([...parsed.daysOfWeek]).toEqual([4, 0]);
    const thursday = new Date(2026, 7, 27, 8, 59, 30).getTime();
    expect(computeNextCronRun(parsed, thursday)).toBe(new Date(2026, 7, 27, 9, 0, 0).getTime());
  });

  it("rejects malformed and out-of-range expressions", () => {
    expect(() => parseCronExpression("* * * *")).toThrow("exactly 5 fields");
    expect(() => parseCronExpression("60 * * * *")).toThrow("outside 0..59");
    expect(() => parseCronExpression("*/0 * * * *")).toThrow("step must be positive");
    expect(() => parseCronExpression("1--2 * * * *")).toThrow("invalid range");
  });
});
