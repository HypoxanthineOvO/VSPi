import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { plainTheme } from "./helpers.js";

interface EditorHistoryAccess {
  history: string[];
}

interface TestableApp {
  inspectIndex?: number;
}

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, setProgress: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function backendWithTranscript(): ChatBackend & {
  send: ReturnType<typeof vi.fn>;
  compact: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  switchSession: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => {});
  const compact = vi.fn(async () => {});
  const newSession = vi.fn(async () => {});
  const switchSession = vi.fn(async () => {});
  return {
    kind: "fixture",
    modelLabel: "Completion Fixture",
    modelId: "completion-fixture",
    supportsVision: false,
    start: vi.fn(async (events: ChatBackendEvents) => {
      events.onMessage({ id: "existing-message", role: "assistant", kind: "text", text: "existing" });
    }),
    send,
    cancel: vi.fn(async () => {}),
    compact,
    newSession,
    listSessions: vi.fn(async () => []),
    switchSession,
    dispose: vi.fn(async () => {}),
  };
}

async function createApp() {
  const backend = backendWithTranscript();
  const onExit = vi.fn();
  const app = new VspiApp(fakeTui(), plainTheme(), backend, {
    cwd: "/workspace/completion",
    settings: DEFAULT_SETTINGS,
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit,
  });
  await app.start();
  return { app, backend, onExit };
}

function history(app: VspiApp): string[] {
  return [...(app.composer.editor as unknown as EditorHistoryAccess).history];
}

describe("slash command Tab completion", () => {
  it.each([
    ["/ex", "/exit"],
    ["/qui", "/quit"],
  ] as const)("completes the unique matched token %s without execution or history writes", async (input, expected) => {
    const { app, backend, onExit } = await createApp();
    app.composer.editor.addToHistory("existing history");
    const before = history(app);
    app.composer.setText(input);

    app.handleInput("\t");

    expect(app.composer.getText()).toBe(expected);
    expect(history(app)).toEqual(before);
    expect(onExit).not.toHaveBeenCalled();
    expect(backend.send).not.toHaveBeenCalled();
    expect(backend.compact).not.toHaveBeenCalled();
    expect(backend.newSession).not.toHaveBeenCalled();
    expect(backend.switchSession).not.toHaveBeenCalled();
    await app.dispose();
  });

  it.each(["/s", "/ex now", "ordinary text"])("does not rewrite non-unique or ineligible input: %s", async (input) => {
    const { app, backend, onExit } = await createApp();
    app.composer.editor.addToHistory("existing history");
    const before = history(app);
    app.composer.setText(input);

    app.handleInput("\t");

    expect(app.composer.getText()).toBe(input);
    expect(history(app)).toEqual(before);
    expect(onExit).not.toHaveBeenCalled();
    expect(backend.send).not.toHaveBeenCalled();
    await app.dispose();
  });

  it("preserves empty-input Tab as the transcript Inspect fallback", async () => {
    const { app } = await createApp();
    expect(app.composer.getText()).toBe("");

    app.handleInput("\t");

    expect((app as unknown as TestableApp).inspectIndex).toBe(0);
    expect(app.composer.getText()).toBe("");
    await app.dispose();
  });
});
