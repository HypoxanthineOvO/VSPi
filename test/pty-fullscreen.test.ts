import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PtyHarness } from "./pty-harness.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("real fullscreen PTY", () => {
  it("scrolls transcript inside alt-screen while keeping the dock fixed", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-pty-fullscreen-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-fullscreen-workspace-"));
    const harness = new PtyHarness(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "index.ts")], {
      cwd: workspace,
      columns: 80,
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
      for (let index = 0; index < 5; index += 1) {
        harness.write(`FULLSCREEN_HISTORY_${index}\r`);
        await harness.waitFor(`effort 处理：FULLSCREEN_HISTORY_${index}`, 10_000);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      const dock = harness.screenText().split("\n").slice(-2);
      expect(dock.join("\n")).toContain("Model Offline Fixture");
      expect(harness.terminal.buffer.active.baseY).toBe(0);

      for (let page = 0; page < 10 && !harness.screenText().includes("FULLSCREEN_HISTORY_0"); page += 1) {
        harness.write("\u001b[5~");
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      expect(harness.screenText()).toContain("FULLSCREEN_HISTORY_0");
      expect(harness.screenText().split("\n").slice(-2)).toEqual(dock);
      expect(harness.terminal.buffer.active.baseY).toBe(0);

      harness.write("\u001b[F");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(harness.screenText()).toContain("FULLSCREEN_HISTORY_4");
      expect(harness.screenText().split("\n").slice(-2)).toEqual(dock);
    } finally {
      harness.write("/quit\r");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await harness.close();
    }
  }, 35_000);
});
