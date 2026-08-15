import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PtyHarness } from "./pty-harness.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("real /agents PTY", () => {
  it("opens and navigates Map, Timeline, Tools, and Pools at narrow and wide sizes", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-agents-pty-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "vspi-agents-pty-workspace-"));
    const harness = new PtyHarness(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "index.ts")], {
      cwd: workspace,
      columns: 40,
      rows: 24,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PI_CODING_AGENT_DIR: join(home, ".pi-agent"),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        VSPi_FIXTURE: "1",
        VSPi_REDUCED_MOTION: "1",
        VSPi_TUI_MODE: "fullscreen",
      },
    });

    try {
      await harness.waitFor("Offline Fixture", 20_000);
      harness.write("/agents\r");
      await harness.waitFor("Agents ⋅ Map", 10_000);
      expect(harness.screenText()).toContain("Map  Timeline  Tools  Pools");
      expect(harness.screenText()).toContain("limits d3");

      harness.write("\t");
      await harness.waitFor("Agents ⋅ Timeline", 5_000);
      harness.write("\t");
      await harness.waitFor("Agents ⋅ Tools", 5_000);
      harness.write("\t");
      await harness.waitFor("Agents ⋅ Pools", 5_000);

      for (const columns of [80, 120]) {
        harness.resize(columns, 24);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        expect(harness.screenText()).toContain("Agents ⋅ Pools");
      }
    } finally {
      harness.write("\u001b");
      harness.write("/quit\r");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      await harness.close();
    }
  }, 30_000);
});
