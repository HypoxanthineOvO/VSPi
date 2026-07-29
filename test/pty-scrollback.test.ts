import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PtyHarness } from "./pty-harness.js";

const ROOT = resolve(import.meta.dirname, "..");

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, ".pi-agent"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    VSPi_FIXTURE: "1",
    VSPi_REDUCED_MOTION: "1",
  };
}

describe("real PTY scrollback", () => {
  it("keeps committed turns reachable and pages through Inspect without clickable folds", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-pty-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-workspace-"));
    const harness = new PtyHarness(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "index.ts")], {
      cwd: workspace,
      env: isolatedEnv(home),
      columns: 80,
      rows: 20,
    });

    try {
      await harness.waitFor("Offline Fixture", 20_000);
      for (let index = 0; index < 6; index += 1) {
        harness.write(`PTY_HISTORY_${index}\r`);
        await harness.waitFor(`effort 处理：PTY_HISTORY_${index}`, 10_000);
        // The input echo and streaming response contain the marker before the stable
        // turn is committed. Wait for Fixture's bounded stream to settle.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      expect(harness.terminal.buffer.active.baseY).toBeGreaterThan(0);
      const history = harness.scrollbackText();
      expect(history).toContain("PTY_HISTORY_0");
      expect(history).toContain("PTY_HISTORY_5");
      expect(history).not.toMatch(/更早的 \d+ 条|已折叠 \d+ 条/u);

      harness.terminal.scrollToBottom();
      harness.write("\u001b[5~");
      await harness.waitFor(/PTY_HISTORY_[0-4]/u);
      harness.write("\u001b[5~");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(harness.screenText()).toContain("PTY_HISTORY_0");

      harness.resize(60, 16);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(harness.screenText().split("\n")).toHaveLength(16);
    } finally {
      harness.write("/quit\r");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await harness.close();
    }
  }, 30_000);
});
