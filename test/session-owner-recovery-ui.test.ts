import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { Question } from "../src/domain/types.js";
import type { SessionLeaseOwner } from "../src/sessions/lease.js";
import { stripAnsi } from "../src/ui/ansi.js";
import type { PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

const OWNER: SessionLeaseOwner = {
  schemaVersion: 2,
  pid: 4321,
  hostname: "localhost",
  startedAt: new Date(0).toISOString(),
  heartbeatAt: new Date(0).toISOString(),
  sessionPath: "/tmp/session.jsonl",
  socketPath: "/tmp/session.sock",
  token: "owner-token",
  processIdentity: { kind: "linux-proc", bootId: "boot", startTimeTicks: "12", uid: 1000 },
};

describe("unresponsive Session owner recovery UI", () => {
  it.each([
    ["terminate", "终止进程并接管", "terminate"],
    ["kill", "发送 SIGKILL 并接管", "kill"],
  ] as const)("renders the %s confirmation during a Session transition", async (phase, text, answer) => {
    let events: ChatBackendEvents | undefined;
    const requestRender = vi.fn();
    const backend = {
      kind: "pi",
      modelLabel: "Test",
      modelId: "model",
      modelProvider: "provider",
      supportsVision: false,
      start: vi.fn(async (captured: ChatBackendEvents) => {
        events = captured;
        captured.onSessionReset?.({ id: "session", reason: "startup" });
      }),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as ChatBackend;
    const app = new VspiApp(
      {
        mode: "regular",
        terminal: { rows: 24, columns: 80, setProgress: vi.fn(), write: vi.fn() },
        requestRender,
      } as unknown as TUI,
      plainTheme(),
      backend,
      {
        cwd: "/workspace/recovery-ui",
        settings: { ...DEFAULT_SETTINGS },
        attachments: { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } as unknown as AttachmentService,
        renderOnce: true,
        onExit: vi.fn(),
      },
    );
    await app.start();
    (app as unknown as { sessionTransition: boolean }).sessionTransition = true;

    const pending = events?.onSessionOwnerRecovery?.(OWNER, phase);
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.render(80).map(stripAnsi).join("\n")).toContain(text);
    expect(requestRender).toHaveBeenCalled();

    const question: Question = {
      id: `session-owner-${phase}`,
      title: "confirm",
      prompt: "confirm",
      kind: "singleChoice",
      options: [],
      answer,
    };
    await (app as unknown as { applyPanelEvent(event: PanelEvent): Promise<void> }).applyPanelEvent({
      type: "questions",
      questions: [question],
    });
    await expect(pending).resolves.toBe(answer);
    await app.dispose();
  });
});
