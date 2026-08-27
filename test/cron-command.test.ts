import { describe, expect, it } from "vitest";
import { parseCronCommand } from "../src/app/vspi-app.js";
import { parseCronDuration, parseCronRunAt } from "../src/cron/schedule.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

describe("manual Cron commands", () => {
  const now = new Date("2026-08-27T10:00:00+08:00").getTime();

  it("parses compound durations and native absolute run times", () => {
    expect(parseCronDuration("2h30m")).toBe(9_000_000);
    expect(parseCronRunAt("2026-08-28T09:00:00+08:00", now)).toBe(new Date("2026-08-28T09:00:00+08:00").getTime());
    expect(() => parseCronDuration("30s")).toThrow("1m");
  });

  it("creates wake, relative prompt, absolute prompt, list, and cancel commands", () => {
    expect(parseCronCommand("/cron", now)).toEqual({ kind: "list" });
    expect(parseCronCommand("/cron wake 2h", now)).toMatchObject({ kind: "create", runAt: now + 7_200_000 });
    expect(parseCronCommand("/cron in 30m check quota", now)).toEqual({
      kind: "create",
      runAt: now + 1_800_000,
      prompt: "check quota",
    });
    expect(parseCronCommand("/cron at 2026-08-28T09:00:00+08:00 continue", now)).toEqual({
      kind: "create",
      runAt: new Date("2026-08-28T09:00:00+08:00").getTime(),
      prompt: "continue",
    });
    expect(parseCronCommand("/cron cancel abc12345", now)).toEqual({ kind: "cancel", id: "abc12345" });
  });

  it("renders scheduled and failed tasks in the Cron panel", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setCronTasks([
      { id: "scheduled", runAt: now + 3_600_000, prompt: "continue work", recurring: false, createdAt: now },
      {
        id: "failed01",
        runAt: now - 60_000,
        prompt: "retry model",
        recurring: false,
        createdAt: now - 120_000,
        lastAttemptAt: now,
        lastError: "quota exhausted",
      },
    ]);
    panel.open("cron");
    const text = panel.render(100, 12, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(text).toContain("Cron");
    expect(text).toContain("scheduled");
    expect(text).toContain("failed01");
    expect(text).toContain("failed");
    expect(text).toContain("continue work");
  });
});
