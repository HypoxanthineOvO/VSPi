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
  it.each([20, 40, 60] as const)(
    "keeps Splash and Composer in one downward-growing startup surface at 80x%s",
    async (rows) => {
      const home = await mkdtemp(join(tmpdir(), "vspi-pty-startup-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-startup-workspace-"));
      const harness = new PtyHarness(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "index.ts")], {
        cwd: workspace,
        env: isolatedEnv(home),
        columns: 80,
        rows,
      });

      try {
        await harness.waitFor("Offline Fixture", 20_000);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const screen = harness.screenText().split("\n");
        const splashRuntime = screen.findIndex((line) => line.includes("Backend Fixture"));
        const composerTop = screen.findIndex((line, index) => index > splashRuntime && /^[+-]|^╭/u.test(line));
        const dynamicStatus = screen.findIndex((line) => line.includes("Model Offline Fixture"));
        const buffer = harness.terminal.buffer.active;

        expect(splashRuntime).toBeGreaterThanOrEqual(0);
        expect(composerTop).toBeGreaterThan(splashRuntime);
        expect(composerTop).toBeLessThan(20);
        expect(dynamicStatus).toBeGreaterThan(composerTop);
        expect(buffer.baseY).toBeLessThanOrEqual(1);
        expect(buffer.viewportY).toBe(buffer.baseY);
      } finally {
        await harness.close();
      }
    },
    25_000,
  );

  it("keeps the latest completed output adjacent to Composer instead of replacing it with blank rows", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-pty-completion-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-completion-workspace-"));
    const harness = new PtyHarness(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "index.ts")], {
      cwd: workspace,
      env: isolatedEnv(home),
      columns: 80,
      rows: 20,
    });

    try {
      await harness.waitFor("Offline Fixture", 20_000);
      harness.userInput("COMPLETION_POSITION_SENTINEL\r");
      await harness.waitFor("effort 处理：COMPLETION_POSITION_SENTINEL", 10_000);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const screen = harness.screenText().split("\n");
      const responseRow = screen.findIndex((line) => line.includes("Fixture 回应"));
      const composerBottom = screen.findIndex((line, index) => index > responseRow && /^\+[-]+\+$/.test(line));
      const statusRow = screen.findIndex((line) => line.includes("Model Offline Fixture"));
      const buffer = harness.terminal.buffer.active;
      expect(responseRow).toBeGreaterThanOrEqual(0);
      expect(responseRow).toBeLessThanOrEqual(5);
      expect(composerBottom).toBeGreaterThan(responseRow);
      expect(statusRow).toBeGreaterThan(composerBottom);
      expect(buffer.viewportY).toBe(buffer.baseY);
      expect(buffer.cursorY).toBeLessThan(statusRow);
      expect(screen.slice(responseRow, composerBottom).filter((line) => line.trim().length === 0).length).toBeLessThan(
        6,
      );
    } finally {
      await harness.close();
    }
  }, 25_000);

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
      expect(harness.screenText()).toContain("PTY_HISTORY_5");
      expect(harness.terminal.buffer.active.viewportY).toBe(harness.terminal.buffer.active.baseY);

      harness.terminal.scrollToBottom();
      for (let page = 0; page < 8 && !harness.screenText().includes("PTY_HISTORY_0"); page += 1) {
        harness.write("\u001b[5~");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
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
