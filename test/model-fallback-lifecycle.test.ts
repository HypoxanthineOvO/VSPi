import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { Question, SessionOption } from "../src/domain/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import type { PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

type SessionReason = "startup" | "new" | "resume" | "fork";

type TestableApp = {
  applyPanelEvent(event: PanelEvent): Promise<void>;
};

const FALLBACK_NOTICE = {
  message: "Could not restore model deepseek/deepseek-v4-flash",
  provider: "anthropic",
  modelId: "glm-5.3",
};

function fakeTui(): TUI {
  return {
    mode: "regular",
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

function fallbackBackend(options: { pendingOnStart?: boolean } = {}) {
  let events:
    | (ChatBackendEvents & { onSessionReset?: (session: { id: string; reason: SessionReason }) => void })
    | undefined;
  const pending = { value: options.pendingOnStart === true ? { ...FALLBACK_NOTICE } : undefined };
  const confirmModelFallback = vi.fn(async () => {
    pending.value = undefined;
  });
  const discardPendingModelFallback = vi.fn(() => {
    pending.value = undefined;
  });
  const rendersDuringSwitch: string[] = [];
  const switchSession = vi.fn(async (id: string) => {
    if (id === "older") {
      pending.value = { ...FALLBACK_NOTICE };
      rendersDuringSwitch.push("during-switch");
    }
    events?.onSessionReset?.({ id, reason: "resume" });
    events?.onUsage({ ...DEFAULT_USAGE, inputTokens: 3, outputTokens: 5 });
  });
  const newSession = vi.fn(async () => {
    pending.value = undefined;
    events?.onSessionReset?.({ id: "fresh", reason: "new" });
  });
  const backend = {
    kind: "pi",
    modelLabel: "Anthropic / GLM",
    modelId: FALLBACK_NOTICE.modelId,
    modelProvider: FALLBACK_NOTICE.provider,
    supportsVision: true,
    start: vi.fn(async (captured: ChatBackendEvents) => {
      events = captured;
      captured.onSessionReset?.({ id: "startup-session", reason: "startup" });
    }),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession,
    listSessions: vi.fn(async () => []),
    switchSession,
    getPendingModelFallback: () => (pending.value ? { ...pending.value } : undefined),
    confirmModelFallback,
    discardPendingModelFallback,
    dispose: vi.fn(async () => {}),
  } as unknown as ChatBackend;
  return { backend, switchSession, newSession, confirmModelFallback, discardPendingModelFallback, rendersDuringSwitch };
}

async function createApp(backend: ChatBackend): Promise<VspiApp> {
  const app = new VspiApp(fakeTui(), plainTheme(), backend, {
    cwd: "/workspace/model-fallback",
    settings: { ...DEFAULT_SETTINGS },
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  return app;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function rendered(app: VspiApp): string {
  return app.render(80).map(stripAnsi).join("\n");
}

function answer(kind: "continue" | "cancel"): PanelEvent {
  const question: Question = {
    id: "session-model-fallback",
    title: "会话模型已回退",
    prompt: "prompt",
    kind: "singleChoice",
    options: [],
    answer: kind,
  };
  return { type: "questions", questions: [question] };
}

describe("session model fallback lifecycle", () => {
  it("asks only after the TUI is ready on first continue and persists the accepted fallback", async () => {
    const harness = fallbackBackend({ pendingOnStart: true });
    const app = await createApp(harness.backend);
    const testable = app as unknown as TestableApp;

    // Startup finished with the fallback pending; nothing asked inside start().
    expect(harness.confirmModelFallback).not.toHaveBeenCalled();
    expect(rendered(app)).not.toContain("会话模型已回退");

    const asking = app.handleStartupModelFallback();
    await flush();
    expect(rendered(app)).toContain("会话模型已回退");

    await testable.applyPanelEvent(answer("continue"));
    await asking;

    expect(harness.confirmModelFallback).toHaveBeenCalledOnce();
    expect(harness.newSession).not.toHaveBeenCalled();
    expect(rendered(app)).not.toContain("会话模型已回退");
    await app.dispose();
  });

  it("asks after the Sessions switch transition finished and reverts to the previous session on cancel", async () => {
    const harness = fallbackBackend();
    const app = await createApp(harness.backend);
    const testable = app as unknown as TestableApp;
    const session: SessionOption = { id: "older", label: "较早会话", relativeTime: "8 分钟前", branchDepth: 0 };

    const switching = testable.applyPanelEvent({ type: "session", session });
    await flush();

    // The question is rendered only once the transition completed; during the
    // switch the panel must stay hidden (sessionTransition suppresses render).
    expect(harness.rendersDuringSwitch).toEqual(["during-switch"]);
    expect(rendered(app)).toContain("会话模型已回退");

    await testable.applyPanelEvent(answer("cancel"));
    await switching;

    expect(harness.switchSession.mock.calls.map((call) => call[0])).toEqual(["older", "startup-session"]);
    expect(harness.discardPendingModelFallback).toHaveBeenCalledOnce();
    expect(harness.confirmModelFallback).not.toHaveBeenCalled();
    expect(rendered(app)).not.toContain("会话模型已回退");
    await app.dispose();
  });

  it("falls back to a fresh session when a startup continue is cancelled", async () => {
    const harness = fallbackBackend({ pendingOnStart: true });
    const app = await createApp(harness.backend);
    const testable = app as unknown as TestableApp;

    const asking = app.handleStartupModelFallback();
    await flush();
    await testable.applyPanelEvent(answer("cancel"));
    await asking;

    expect(harness.newSession).toHaveBeenCalledOnce();
    expect(harness.switchSession).not.toHaveBeenCalled();
    expect(harness.discardPendingModelFallback).toHaveBeenCalledOnce();
    await app.dispose();
  });

  it("keeps the session usable without blocking when the question cannot be shown", async () => {
    const harness = fallbackBackend({ pendingOnStart: true });
    const app = await createApp(harness.backend);

    // Simulate an occupied question channel: another question is already active.
    const occupied = app as unknown as { pendingQuestion: unknown };
    occupied.pendingQuestion = {};
    await app.handleStartupModelFallback();
    occupied.pendingQuestion = undefined;

    expect(harness.confirmModelFallback).not.toHaveBeenCalled();
    expect(harness.newSession).not.toHaveBeenCalled();
    expect(rendered(app)).toContain("会话模型已回退到 anthropic/glm-5.3");
    await app.dispose();
  });
});
