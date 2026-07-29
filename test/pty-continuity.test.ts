import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PtyHarness } from "./pty-harness.js";

const ROOT = resolve(import.meta.dirname, "..");

function scenario(workspace: string): PtyHarness {
  return new PtyHarness(
    join(ROOT, "node_modules", ".bin", "tsx"),
    [join(ROOT, "test", "fixtures", "pty-continuity-scenario.ts")],
    {
      cwd: workspace,
      columns: 80,
      rows: 24,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: "xterm-256color",
        VSPi_REDUCED_MOTION: "1",
      },
    },
  );
}

describe("PTY continuity scenarios", () => {
  it("continues after every successful threshold compaction in one long task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-continuity-"));
    const harness = scenario(workspace);
    try {
      await harness.waitFor("PTY_SCENARIO_INPUT_READY", 15_000);
      harness.write("RUN_TWO_COMPACTIONS\r");
      await harness.waitFor("AFTER_COMPACTION_2", 10_000);
      expect(harness.scrollbackText()).toContain("AFTER_COMPACTION_1");
    } finally {
      await harness.close();
    }
  }, 25_000);

  it("redraws the newest Plan revision and rejects a late stale refresh", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-plan-refresh-"));
    const harness = scenario(workspace);
    try {
      await harness.waitFor("PTY_SCENARIO_INPUT_READY", 15_000);
      await harness.waitFor("PLAN_LATEST_REFRESH", 5_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(harness.screenText()).toContain("PLAN_LATEST_REFRESH");
      expect(harness.screenText()).not.toContain("PLAN_STALE_REFRESH");
    } finally {
      await harness.close();
    }
  }, 20_000);
});
