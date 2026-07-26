import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { ExternalSessionPreview } from "../src/sessions/external-history.js";
import { plainTheme } from "./helpers.js";

describe("external history import UI", () => {
  it("opens from /import, confirms visible-history risk, and delegates the copy", async () => {
    const preview = importedPreview();
    const importExternalSession = vi.fn(async () => {});
    const backend = {
      kind: "pi",
      modelLabel: "Fixture",
      modelId: "fixture",
      supportsVision: false,
      start: vi.fn(async (events: ChatBackendEvents) => {
        events.onSessionReset?.({ id: "initial", reason: "startup" });
        events.onUsage(DEFAULT_USAGE);
      }),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      listExternalSessions: vi.fn(async () => [preview]),
      previewExternalSession: vi.fn(async () => preview),
      importExternalSession,
      dispose: vi.fn(async () => {}),
    } as unknown as ChatBackend;
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace",
      settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
      attachments: fakeAttachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();

    await app.runStartupCommand("/import codex");
    expect(app.render(80).join("\n")).toContain("Imported Codex thread");
    app.handleInput("\r");
    await flush();
    expect(app.render(80).join("\n")).toContain("10 条对话 · 2 条工具记录");
    app.handleInput("\r");
    await flush();
    app.handleInput("\r");
    await flush();

    expect(importExternalSession).toHaveBeenCalledWith("codex:thread", "f".repeat(64));
    await app.dispose();
  });
});

function importedPreview(): ExternalSessionPreview {
  return {
    id: "codex:thread",
    source: "codex",
    sourceId: "thread",
    title: "Imported Codex thread",
    cwd: "/workspace",
    updatedAt: "2026-07-26T12:00:00.000Z",
    items: [{ role: "user", kind: "message", text: "hello" }],
    messageCount: 10,
    toolCount: 2,
    estimatedTokens: 12_400,
    fingerprint: "f".repeat(64),
    snapshotBytes: 4_096,
    snapshotModifiedAt: "2026-07-26T12:00:00.000Z",
  };
}

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, columns: 80, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
