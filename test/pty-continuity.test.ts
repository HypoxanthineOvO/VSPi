import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PtyHarness } from "./pty-harness.js";

const ROOT = resolve(import.meta.dirname, "..");

function scenario(workspace: string, extraEnv: NodeJS.ProcessEnv = {}): PtyHarness {
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
        ...extraEnv,
      },
    },
  );
}

function emptyFixtureResume(home: string, workspace: string): PtyHarness {
  return new PtyHarness(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "index.ts"), "resume"], {
    cwd: workspace,
    columns: 80,
    rows: 24,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_CODING_AGENT_DIR: join(home, ".pi-agent"),
      TERM: "xterm-256color",
      VSPi_FIXTURE: "1",
      VSPi_REDUCED_MOTION: "1",
      VSPi_TUI_MODE: "fullscreen",
    },
  });
}

function fixtureShell(home: string, workspace: string): PtyHarness {
  return new PtyHarness("bash", ["--noprofile", "--norc", "-i"], {
    cwd: workspace,
    columns: 80,
    rows: 24,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_CODING_AGENT_DIR: join(home, ".pi-agent"),
      PS1: "VSPI_RELOAD_PROMPT> ",
      TERM: "xterm-256color",
      VSPi_FIXTURE: "1",
      VSPi_REDUCED_MOTION: "1",
      VSPi_TUI_MODE: "fullscreen",
    },
  });
}

describe("PTY continuity scenarios", () => {
  it("keeps the shell foreground job alive while a reload successor owns the TTY", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-reload-"));
    const home = await mkdtemp(join(tmpdir(), "vspi-pty-reload-home-"));
    const harness = fixtureShell(home, workspace);
    try {
      await harness.waitFor("VSPI_RELOAD_PROMPT>", 5_000);
      harness.write(`${process.execPath} ${join(ROOT, "dist", "index.js")}\r`);
      await harness.waitFor("Offline Fixture", 15_000);
      harness.write("/reload\r");

      await new Promise((resolve) => setTimeout(resolve, 4_000));
      // reload 后普通按键必须进入续接进程的 composer：若旧进程退出时把 PTY
      // 打回 cooked+ECHO，这里会变成内核回显的控制记法乱码而非可用输入。
      harness.write("zzreload9");
      await harness.waitFor("zzreload9", 5_000);
      harness.write("\x7f".repeat(9));
      await new Promise((resolve) => setTimeout(resolve, 300));
      harness.write("/model\r");
      await harness.waitFor("选择模型", 5_000);
      const output = harness.scrollbackText();
      expect(output.match(/VSPI_RELOAD_PROMPT>/gu)).toHaveLength(1);
      expect(output).not.toContain("read EIO");
      expect(output).not.toContain("Unhandled 'error' event");
      expect(output).toContain("Offline Fixture");
    } finally {
      await harness.close();
    }
  }, 25_000);

  it("lets Question replace Composer with one gutter before the two-line Status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-question-"));
    const harness = scenario(workspace, { VSPI_PTY_QUESTION: "1" });
    try {
      await harness.waitFor("Question spacing", 15_000);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const screen = harness.screenText().split("\n");
      const questionTop = screen.findIndex((line) => line.includes("Question"));
      const questionBottom = screen.findIndex((line, index) => index > questionTop && /^[+]/u.test(line));
      expect(questionTop).toBeGreaterThanOrEqual(0);
      expect(questionBottom).toBeGreaterThan(questionTop);
      expect(screen[questionBottom + 1]?.trim()).toBe("");
      expect(screen[questionBottom + 2]).toMatch(/^Model /);
      expect(screen[questionBottom + 3]).toContain("Policy");
      expect(screen.join("\n")).not.toContain("Working");
      expect(screen.join("\n")).not.toContain("输入消息");
      expect(harness.terminal.buffer.active.viewportY).toBe(harness.terminal.buffer.active.baseY);
    } finally {
      await harness.close();
    }
  }, 25_000);

  it("keeps an empty Resume picker useful on normal and short terminals", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-pty-empty-resume-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-empty-resume-workspace-"));
    const harness = emptyFixtureResume(home, workspace);
    try {
      await harness.waitFor("0 个会话", 15_000);
      const normal = harness.screenText().split("\n");
      const normalTop = normal.findIndex((line) => line.includes("Sessions"));
      const normalBottom = normal.findIndex((line, index) => index > normalTop && line.startsWith("+"));
      expect(normalTop).toBeGreaterThanOrEqual(2);
      expect(normalBottom - normalTop + 1).toBeGreaterThanOrEqual(3);
      expect(harness.terminal.buffer.active.viewportY).toBe(harness.terminal.buffer.active.baseY);

      harness.resize(60, 12);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const short = harness.screenText().split("\n");
      expect(short).toHaveLength(12);
      expect(short.findIndex((line) => line.includes("Sessions"))).toBeGreaterThanOrEqual(2);
      expect(short.join("\n")).toContain("Sessions");
      expect(short.join("\n")).toContain("暂无会话");
      expect(harness.terminal.buffer.active.viewportY).toBe(harness.terminal.buffer.active.baseY);
    } finally {
      await harness.close();
    }
  }, 25_000);

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
      await new Promise((resolve) => setTimeout(resolve, 150));
      const before = harness.terminal.buffer.active;
      const beforePosition = {
        baseY: before.baseY,
        viewportY: before.viewportY,
        cursorX: before.cursorX,
        cursorY: before.cursorY,
      };
      await harness.waitFor("PLAN_LATEST_REFRESH", 5_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(harness.screenText()).toContain("PLAN_LATEST_REFRESH");
      expect(harness.screenText()).not.toContain("PLAN_STALE_REFRESH");
      const after = harness.terminal.buffer.active;
      expect({
        baseY: after.baseY,
        viewportY: after.viewportY,
        cursorX: after.cursorX,
        cursorY: after.cursorY,
      }).toEqual(beforePosition);
    } finally {
      await harness.close();
    }
  }, 20_000);

  it("keeps a useful Resume surface and follows the restored Session to the bottom", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-pty-resume-"));
    const harness = scenario(workspace);
    try {
      await harness.waitFor("PTY_SCENARIO_INPUT_READY", 15_000);
      harness.resize(98, 62);
      await new Promise((resolve) => setTimeout(resolve, 150));
      harness.write("/resume\r");
      await harness.waitFor("PTY Resume Session", 5_000);
      const panelLines = harness.screenText().split("\n");
      const panelTop = panelLines.findIndex((line) => line.includes("Sessions"));
      const panelBottom = panelLines.findIndex((line, index) => index > panelTop && line.startsWith("+"));
      const sessionRow = panelLines.findIndex((line) => line.includes("PTY Resume Session"));
      const statusRowBeforeResume = panelLines.findIndex((line) => line.includes("Model Test / PTY Scenario"));
      expect(panelTop).toBeGreaterThanOrEqual(2);
      expect(sessionRow).toBeGreaterThan(panelTop);
      expect(statusRowBeforeResume).toBeGreaterThan(panelBottom);
      expect(panelBottom - panelTop + 1).toBeGreaterThanOrEqual(3);

      harness.terminal.scrollToTop();
      harness.userInput("\r");
      await harness.waitFor("RESUMED_HISTORY_23", 5_000);
      await harness.waitFor("PLAN_LATEST_REFRESH", 5_000);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const buffer = harness.terminal.buffer.active;
      expect(buffer.viewportY).toBe(buffer.baseY);
      expect(harness.screenText()).toContain("PLAN_LATEST_REFRESH");
      expect(harness.screenText()).not.toContain("PLAN_STALE_REFRESH");
      expect(harness.screenText()).toContain("RESUMED_HISTORY_23");
      expect(harness.screenText()).toContain("RESUMED_HISTORY_0");
      const restoredLines = harness.screenText().split("\n");
      const latestHistoryRow = restoredLines.findIndex((line) => line.includes("RESUMED_HISTORY_23"));
      const planRow = restoredLines.findIndex((line) => line.includes("Plan"));
      const statusRow = restoredLines.findLastIndex((line) => line.includes("Model Test / PTY Scenario"));
      expect(latestHistoryRow).toBeGreaterThanOrEqual(0);
      expect(planRow).toBeGreaterThan(latestHistoryRow);
      expect(statusRow).toBeGreaterThan(planRow);

      harness.resize(60, 16);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(harness.screenText().split("\n")).toHaveLength(16);
      expect(harness.screenText()).toContain("RESUMED_HISTORY_23");
      expect(harness.terminal.buffer.active.viewportY).toBe(harness.terminal.buffer.active.baseY);

      for (let page = 0; page < 8 && !harness.screenText().includes("RESUMED_HISTORY_0"); page += 1) {
        harness.userInput("\u001b[5~");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(harness.screenText()).toContain("RESUMED_HISTORY_0");
    } finally {
      await harness.close();
    }
  }, 25_000);
});
