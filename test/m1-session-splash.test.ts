import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { VSPI_VERSION } from "../src/version.js";
import { plainTheme } from "./helpers.js";

const LOGO = [
  "██╗   ██╗███████╗██████╗ ██╗",
  "██║   ██║██╔════╝██╔══██╗██║",
  "██║   ██║███████╗██████╔╝██║",
  "╚██╗ ██╔╝╚════██║██╔═══╝ ██║",
  " ╚████╔╝ ███████║██║     ██║",
  "  ╚═══╝  ╚══════╝╚═╝     ╚═╝",
] as const;

interface RecordingTui {
  tui: TUI;
  writes: string[];
}

function recordingTui(): RecordingTui {
  const writes: string[] = [];
  const terminal = {
    columns: 80,
    rows: 24,
    setProgress: vi.fn(),
    write: vi.fn((chunk: string) => writes.push(chunk)),
  };
  return {
    tui: { terminal, requestRender: vi.fn() } as unknown as TUI,
    writes,
  };
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function backendWithOldTranscript(): ChatBackend & {
  send: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => {});
  const newSession = vi.fn(async () => {});
  return {
    kind: "fixture",
    modelLabel: "M1 Session Fixture",
    modelId: "m1-session-fixture",
    supportsVision: false,
    start: vi.fn(async (events: ChatBackendEvents) => {
      events.onMessage({ id: "old-message", role: "assistant", kind: "text", text: "OLD_TRANSCRIPT_SENTINEL" });
    }),
    send,
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession,
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("M1 new-session scrollback contract", () => {
  it.each(["/new", "/clear"] as const)(
    "%s clears the transcript and commits one complete truthful Splash before the next message",
    async (command) => {
      const { tui, writes } = recordingTui();
      const backend = backendWithOldTranscript();
      const app = new VspiApp(tui, plainTheme(), backend, {
        cwd: "/workspace/m1-session",
        settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
        attachments: fakeAttachments(),
        renderOnce: true,
        onExit: vi.fn(),
      });
      await app.start();
      try {
        expect(app.render(80).map(stripAnsi).join("\n")).toContain("OLD_TRANSCRIPT_SENTINEL");

        app.composer.setText(command);
        app.handleInput("\r");
        await flush();

        const cleared = app.render(80).map(stripAnsi).join("\n");
        const scrollback = stripAnsi(writes.join(""));
        expect(backend.newSession).toHaveBeenCalledOnce();
        expect(cleared).not.toContain("OLD_TRANSCRIPT_SENTINEL");
        expect(cleared).not.toContain("Plan");
        expect(cleared).not.toMatch(/Workflow|当前计划为空/);
        expect(cleared).toMatch(/╭─+╮[\s\S]*╰─+╯/);
        for (const line of LOGO) expect(scrollback).toContain(line);
        expect(scrollback).toContain("VSPi");
        expect(scrollback).toContain("M1 Session Fixture");
        expect(scrollback).toContain("Backend Fixture");
        expect(scrollback).toContain("Policy Standard");
        expect(scrollback).toContain("Host");
        expect(scrollback).toContain(`v${VSPI_VERSION}`);
        expect(scrollback).not.toMatch(/\bMode\b|\bAuto\b/);

        const committedSplash = writes.join("");
        app.composer.setText("first message after reset");
        app.handleInput("\r");
        await flush();

        expect(app.render(80).map(stripAnsi).join("\n")).toContain("first message after reset");
        expect(writes.join("")).toContain(committedSplash);
        for (const line of LOGO) expect(stripAnsi(writes.join(""))).toContain(line);
      } finally {
        await app.dispose();
      }
    },
  );
});
