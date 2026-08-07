import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StartupStatus, startUiAfterSplash } from "../src/app/startup.js";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { plainTheme } from "./helpers.js";

const PI_STATUS: StartupStatus = {
  model: "OpenAI / GPT-5.4",
  backend: "Pi",
  policy: "Standard",
  boundary: "Sandboxed",
  version: "9.8.7-test",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function plainOutput(chunks: string[]): string {
  return stripAnsi(chunks.join(""));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startup orchestration", () => {
  it("uses one single-line brand placeholder and one width-safe final status frame", async () => {
    const chunks: string[] = [];
    const startTui = vi.fn();
    await startUiAfterSplash({
      width: 80,
      theme: plainTheme({ reducedMotion: false }),
      write: (chunk) => chunks.push(chunk),
      startApp: () => PI_STATUS,
      startTui,
    });

    expect(chunks).toHaveLength(2);
    expect(stripAnsi(chunks[0] ?? "").split("\n")).toHaveLength(1);
    expect(chunks[1]).toContain("\u001b[2J\u001b[H");
    expect(chunks.some((chunk) => stripAnsi(chunk).includes(PI_STATUS.model))).toBe(false);
    for (const chunk of chunks) {
      for (const line of stripAnsi(chunk).split("\n"))
        expect(visibleWidth(line.replace("\r", ""))).toBeLessThanOrEqual(80);
    }
    expect(startTui).toHaveBeenCalledOnce();
    const surface = startTui.mock.calls[0]?.[0] as readonly string[];
    expect(stripAnsi(surface.join("\n"))).toContain(PI_STATUS.model);
    expect(surface.every((line) => visibleWidth(line) === 80)).toBe(true);
  });

  it.each([
    ["animated", false],
    ["reduced-motion", true],
  ] as const)(
    "starts app initialization immediately and commits its real status before TUI startup in %s mode",
    async (_mode, reducedMotion) => {
      vi.useFakeTimers();
      const theme = plainTheme({ reducedMotion });
      const chunks: string[] = [];
      const lifecycle: string[] = [];
      const appReady = deferred<StartupStatus>();
      let appResolved = false;
      let appWasResolvedAtTuiStart = false;
      let outputAtTuiStart = "";
      const startApp = vi.fn(async () => {
        lifecycle.push("app:start");
        const status = await appReady.promise;
        appResolved = true;
        lifecycle.push("app:resolved");
        return status;
      });
      const startTui = vi.fn((surface: readonly string[]) => {
        appWasResolvedAtTuiStart = appResolved;
        lifecycle.push("splash:final");
        outputAtTuiStart = `${plainOutput(chunks)}${stripAnsi(surface.join("\n"))}\n`;
        lifecycle.push("tui:start");
        chunks.push(`${surface.join("\n")}\n`);
        chunks.push("当前计划为空\n");
      });

      const startup = startUiAfterSplash({
        width: 80,
        theme,
        write: (chunk) => {
          chunks.push(chunk);
        },
        startApp,
        startTui,
      });

      const appStartedInInitialTurn = startApp.mock.calls.length;
      const initialOutput = plainOutput(chunks);
      expect(initialOutput).toContain("VSPi");
      expect(initialOutput).not.toContain(PI_STATUS.model);

      await vi.runAllTimersAsync();
      expect(startTui).not.toHaveBeenCalled();
      appReady.resolve(PI_STATUS);
      await startup;

      const output = plainOutput(chunks);
      expect.soft(appStartedInInitialTurn).toBe(1);
      expect.soft(startApp).toHaveBeenCalledTimes(1);
      expect.soft(startTui).toHaveBeenCalledTimes(1);
      expect.soft(appWasResolvedAtTuiStart).toBe(true);
      expect.soft(outputAtTuiStart).toContain(PI_STATUS.model);
      expect.soft(outputAtTuiStart.endsWith("\n")).toBe(true);
      expect.soft(output).toContain(PI_STATUS.model);
      expect.soft(output).toContain("Backend Pi");
      expect.soft(output).toContain("Policy Standard · Sandboxed");
      expect.soft(output).not.toMatch(/\bMode\b|\bAuto\b/);
      expect.soft(output).toContain(PI_STATUS.version);
      expect.soft(output.indexOf(PI_STATUS.model)).toBeLessThan(output.indexOf("当前计划为空"));
      expect.soft(lifecycle).toEqual(["app:start", "app:resolved", "splash:final", "tui:start"]);
    },
  );

  it("does not publish a final status or start the TUI while animated startup is unresolved", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const appReady = deferred<StartupStatus>();
    const startTui = vi.fn();
    const startup = startUiAfterSplash({
      width: 80,
      theme: plainTheme({ reducedMotion: false }),
      write: (chunk) => chunks.push(chunk),
      startApp: () => appReady.promise,
      startTui,
    });

    expect(plainOutput(chunks)).toContain("VSPi");
    await vi.runAllTimersAsync();
    expect(plainOutput(chunks)).not.toContain(PI_STATUS.model);
    expect(startTui).not.toHaveBeenCalled();

    appReady.resolve(PI_STATUS);
    await startup;
    expect(startTui).toHaveBeenCalledOnce();
    expect(stripAnsi((startTui.mock.calls[0]?.[0] as readonly string[]).join("\n"))).toContain(PI_STATUS.model);
  });

  it.each([
    ["backend", true],
    ["attachment", false],
  ] as const)("keeps %s initialization failure clean, single-shot, and TUI-free", async (phase, backendFails) => {
    vi.useFakeTimers();
    const failure = new Error(`${phase} startup failure sentinel`);
    const backendStart = vi.fn(async () => {
      if (backendFails) throw failure;
    });
    const backendDispose = vi.fn(async () => {});
    const attachmentStart = vi.fn(async () => {
      if (!backendFails) throw failure;
    });
    const attachmentDispose = vi.fn(async () => {});
    const backend = fakeBackend(backendStart, backendDispose);
    const attachments = {
      start: attachmentStart,
      dispose: attachmentDispose,
    } as unknown as AttachmentService;
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/startup-failure",
      settings: DEFAULT_SETTINGS,
      attachments,
      renderOnce: true,
      onExit: vi.fn(),
    });
    const startApp = vi.fn(async () => {
      await app.start();
      return PI_STATUS;
    });
    const startTui = vi.fn();

    const startup = (async () => {
      try {
        await startUiAfterSplash({
          width: 80,
          theme: plainTheme({ reducedMotion: false }),
          write: vi.fn(),
          startApp,
          startTui,
        });
      } finally {
        await app.dispose();
      }
    })();
    const rejection = expect(startup).rejects.toThrow(failure);
    await vi.runAllTimersAsync();
    await rejection;

    expect(startApp).toHaveBeenCalledOnce();
    expect(startTui).not.toHaveBeenCalled();
    expect(backendStart).toHaveBeenCalledOnce();
    expect(backendDispose).toHaveBeenCalledOnce();
    expect(attachmentStart).toHaveBeenCalledTimes(backendFails ? 0 : 1);
    expect(attachmentDispose).toHaveBeenCalledOnce();
  });

  it("aborts an active generation before disposing the backend on foreground exit", async () => {
    let events: Parameters<ChatBackend["start"]>[0] | undefined;
    const order: string[] = [];
    const backend = fakeBackend(
      vi.fn(async (next) => {
        events = next;
      }),
      vi.fn(async () => {
        order.push("dispose");
      }),
    );
    backend.cancel = vi.fn(async () => {
      order.push("cancel");
      return { queuedMessages: [] };
    });
    const attachments = {
      start: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AttachmentService;
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/graceful-exit",
      settings: DEFAULT_SETTINGS,
      attachments,
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();
    events?.onBusy(true);

    await app.dispose();

    expect(order).toEqual(["cancel", "dispose"]);
  });
});

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, setProgress: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeBackend(start: ChatBackend["start"], dispose: ChatBackend["dispose"]): ChatBackend {
  return {
    kind: "pi",
    modelLabel: PI_STATUS.model,
    modelId: "gpt-5.4",
    supportsVision: true,
    start,
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    dispose,
  };
}
