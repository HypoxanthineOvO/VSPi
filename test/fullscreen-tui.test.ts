import { type Component, CURSOR_MARKER, type ScrollView, type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { TranscriptMessage } from "../src/domain/types.js";
import type { StoredGoal } from "../src/goals/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { plainTheme } from "./helpers.js";

class FullscreenTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  columns = 80;
  rows = 24;
  private input: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {
    this.input = undefined;
  }
  emit(data: string): void {
    this.input?.(data);
  }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function attachments(): AttachmentService {
  return { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } as unknown as AttachmentService;
}

async function flushRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function transcriptMessages(count: number): TranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    kind: "text",
    text: `Transcript row ${index} ${"content ".repeat(8)}`,
  }));
}

describe("fullscreen TUI shell", () => {
  it("expands the Model selector to its tall-terminal row budget", async () => {
    const terminal = new FullscreenTerminal();
    terminal.rows = 40;
    const tui = new TuiAltScreen(terminal, true);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/tall-model-panel",
      settings: { ...DEFAULT_SETTINGS, tuiMode: "fullscreen" },
      attachments: attachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();
    app.setStartupSurface([]);
    const internal = app as unknown as { panels: { open(kind: "models"): void } };
    internal.panels.open("models");

    const frame = app.render(80).map(stripAnsi);
    const start = frame.findIndex((line) => line.startsWith("╭ Model"));
    const end = frame.findIndex((line, index) => index > start && line.startsWith("╰"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end - start + 1).toBe(24);
    await app.dispose();
  });

  it("refreshes a visible startup surface when the model identity changes", async () => {
    const terminal = new FullscreenTerminal();
    const tui = new TuiAltScreen(terminal, true);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/startup-model",
      settings: { ...DEFAULT_SETTINGS, tuiMode: "fullscreen" },
      attachments: attachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();
    app.setStartupSurface(["STALE STARTUP MODEL"]);
    const goal: StoredGoal = {
      id: "goal-model-refresh",
      revision: 1,
      semanticHash: "a".repeat(64),
      contract: { objective: "Verify model presentation", completionCriteria: ["Model label is current"] },
      planId: "plan-model-refresh",
      limits: { maxAutoRounds: 4, maxNoProgressRounds: 2, maxTokens: 10_000 },
      owner: { sessionId: "session-1", processId: "process-1", acquiredAt: "2026-08-16T00:00:00.000Z" },
      initialTokens: 0,
      state: "executing",
      autoRounds: 1,
      noProgressRounds: 0,
      consumedTokens: 100,
      markers: [],
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    };
    const internal = app as unknown as {
      goalSnapshot: StoredGoal | undefined;
      modelLabel: string;
      panels: {
        open(kind: "goal"): void;
        setGoalSnapshot(snapshot: StoredGoal, modelLabel: string): void;
      };
      refreshModelPresentation(): void;
    };
    internal.goalSnapshot = goal;
    internal.panels.setGoalSnapshot(goal, "STALE GOAL MODEL");
    internal.modelLabel = "Updated Model";
    internal.refreshModelPresentation();

    const frame = stripAnsi(app.render(80).join("\n"));
    expect(frame).toContain("Updated Model");
    expect(frame).not.toContain("STALE STARTUP MODEL");

    app.setStartupSurface([]);
    internal.panels.open("goal");
    const goalFrame = stripAnsi(app.render(80).join("\n"));
    expect(goalFrame).toContain("Updated Model");
    expect(goalFrame).not.toContain("STALE GOAL MODEL");
    await app.dispose();
  });

  it("rebuilds the visible frame after cursor-only input", async () => {
    const terminal = new FullscreenTerminal();
    const tui = new TuiAltScreen(terminal, true);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/fullscreen-cursor",
      settings: { ...DEFAULT_SETTINGS, tuiMode: "fullscreen" },
      attachments: attachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    tui.addChild(app);
    tui.setFocus(app);
    await app.start();
    app.composer.setText("abcdef");
    tui.start();
    await flushRender();
    const fullscreen = app as unknown as {
      fullscreenLayout: Component;
      fullscreenBodyCache: unknown;
      fullscreenDockCache: unknown;
    };
    const buildBody = vi.spyOn(app as never, "buildRenderBody");
    const buildDock = vi.spyOn(app as never, "buildRenderDock");
    const renderFrame = () =>
      renderLayoutFrame(fullscreen.fullscreenLayout, terminal.columns, terminal.rows, () => {}).lines;

    fullscreen.fullscreenBodyCache = undefined;
    fullscreen.fullscreenDockCache = undefined;
    buildBody.mockClear();
    buildDock.mockClear();
    const before = renderFrame().join("\n");
    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(buildDock).toHaveBeenCalledTimes(1);
    const beforeMarker = before.indexOf(CURSOR_MARKER);
    terminal.emit("\x1b[D");
    await flushRender();
    buildBody.mockClear();
    buildDock.mockClear();
    const after = renderFrame().join("\n");
    expect(buildBody).not.toHaveBeenCalled();
    expect(buildDock).not.toHaveBeenCalled();
    const afterMarker = after.indexOf(CURSOR_MARKER);

    expect(app.composer.editor.getCursor()).toEqual({ line: 0, col: 5 });
    expect(beforeMarker).toBeGreaterThanOrEqual(0);
    expect(afterMarker).toBeGreaterThanOrEqual(0);
    expect(afterMarker).not.toBe(beforeMarker);
    expect(after).not.toBe(before);
    await app.dispose();
    tui.stop();
  });

  it("keeps the dock fixed while the upstream viewport scrolls the transcript", async () => {
    const terminal = new FullscreenTerminal();
    const tui = new TuiAltScreen(terminal, true);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/fullscreen",
      settings: { ...DEFAULT_SETTINGS, tuiMode: "fullscreen", fullscreenScrollbar: "always" },
      attachments: attachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    tui.addChild(app);
    tui.setFocus(app);
    await app.start();
    (app as unknown as { messages: TranscriptMessage[] }).messages.push(...transcriptMessages(60));
    app.invalidate();
    tui.start();
    await flushRender();
    const fullscreen = app as unknown as {
      fullscreenLayout: Component;
      fullscreenScrollView: ScrollView;
      fullscreenBodyCache: unknown;
      fullscreenDockCache: unknown;
    };
    const buildBody = vi.spyOn(app as never, "buildRenderBody");
    const buildDock = vi.spyOn(app as never, "buildRenderDock");
    const renderFrame = () =>
      renderLayoutFrame(fullscreen.fullscreenLayout, terminal.columns, terminal.rows, () => {}).lines.map(stripAnsi);

    fullscreen.fullscreenBodyCache = undefined;
    fullscreen.fullscreenDockCache = undefined;
    buildBody.mockClear();
    buildDock.mockClear();
    renderFrame();
    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(buildDock).toHaveBeenCalledTimes(1);
    fullscreen.fullscreenScrollView.scrollToEnd();
    const bottom = renderFrame();
    const dock = bottom.slice(-4);
    expect(bottom).toHaveLength(terminal.rows);
    expect(bottom.join("\n")).toContain("Transcript row 59");

    fullscreen.fullscreenScrollView.scrollToStart();
    const top = renderFrame();
    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(buildDock).toHaveBeenCalledTimes(1);
    expect(top.slice(-4)).toEqual(dock);
    expect(top.join("\n")).toContain("Transcript row 0");
    expect(top.join("\n")).not.toContain("Transcript row 59");

    terminal.emit("\x1b[F");
    await flushRender();
    const tailTop = tui.viewportTop;
    terminal.emit("\x1b[5~");
    await flushRender();
    expect(tui.viewportTop).toBeLessThan(tailTop);
    expect(tui.isFollowingOutput).toBe(false);
    terminal.emit("\x1b[H");
    await flushRender();
    expect(tui.viewportTop).toBe(0);
    terminal.emit("\x1b[F");
    await flushRender();
    expect(tui.isFollowingOutput).toBe(true);
    const beforeWheel = tui.viewportTop;
    terminal.emit("\x1b[<64;10;10M");
    await flushRender();
    expect(tui.viewportTop).toBeLessThan(beforeWheel);
    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(buildDock).toHaveBeenCalledTimes(1);
    await app.dispose();
    tui.stop();
  });

  it("switches between fullscreen and regular renderers without replacing app state", async () => {
    const terminal = new FullscreenTerminal();
    const tui = new TuiAltScreen(terminal, true);
    const app = new VspiApp(tui, plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/tui-switch",
      settings: { ...DEFAULT_SETTINGS, tuiMode: "fullscreen" },
      attachments: attachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    tui.addChild(app);
    tui.setFocus(app);
    await app.start();
    tui.start();
    app.composer.setText("preserved draft");
    const switchMode = (mode: "fullscreen" | "regular") =>
      (app as unknown as { switchTuiMode(mode: "fullscreen" | "regular"): boolean }).switchTuiMode(mode);

    expect(switchMode("regular")).toBe(true);
    expect(app.getActiveTui().mode).toBe("regular");
    expect(app.getActiveTui().terminal).toBe(terminal);
    expect(stripAnsi(app.render(80).join("\n"))).toContain("preserved draft");

    expect(switchMode("fullscreen")).toBe(true);
    expect(app.getActiveTui().mode).toBe("fullscreen");
    expect(app.focused).toBe(true);
    expect(stripAnsi(app.getActiveTui().render(80).join("\n"))).toContain("preserved draft");
    await app.dispose();
    app.getActiveTui().stop();
  });
});
