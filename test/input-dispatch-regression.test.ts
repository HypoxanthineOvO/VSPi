import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp, type VspiAppOptions } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents, SendOptions } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { Attachment, ModelOption, Question, SessionOption, TranscriptMessage } from "../src/domain/types.js";
import type { StoredPlan } from "../src/plans/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { matchesInteraction } from "../src/ui/interactions.js";
import type { PanelController, PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

type TestableApp = {
  submit(raw: string, options?: { skipPlanRoute?: boolean }): Promise<void>;
  applyPanelEvent(event: PanelEvent): Promise<void>;
  messages: TranscriptMessage[];
  busy: boolean;
  panelFocused: boolean;
  panels: PanelController;
  planSnapshot?: StoredPlan;
  preview?: unknown;
  inspectIndex?: number;
  renameAttachmentId?: string;
  renameInput: string;
  notice?: { text: string; tone: string };
};

const ATTACHMENT: Attachment = {
  id: "image-1",
  alias: "截图",
  mimeType: "image/png",
  width: 1440,
  height: 900,
  size: 120_000,
  path: "/tmp/image.png",
  status: "ready",
};

const PLAN: StoredPlan = {
  id: "plan-1",
  revision: 1,
  semanticHash: "a".repeat(64),
  archived: false,
  title: "Release",
  goal: "Ship the input milestone",
  challenges: [],
  items: [{ id: "work", title: "Work item", status: "pending" }],
  blockers: [],
};

const ROUTE_QUESTIONS: Question[] = [
  {
    id: "task-scope",
    title: "任务归属",
    prompt: "这个多步骤任务与当前 Plan 明显无关，要新建 Plan 还是仅聊天处理？",
    kind: "singleChoice",
    options: [{ id: "chat-only", label: "仅聊天" }],
  },
];

const MODEL: ModelOption = {
  id: "model-x",
  provider: "openai",
  brand: "openai",
  label: "Model X",
  vision: false,
  efforts: ["低", "中", "高"],
  price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
};

const SESSION: SessionOption = { id: "session-b", label: "Session B", relativeTime: "刚刚", branchDepth: 0 };

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, columns: 80, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(overrides: Record<string, unknown> = {}): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AttachmentService;
}

function backendWith(ref: { events?: ChatBackendEvents }, overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    kind: "fixture",
    modelLabel: "Test Model",
    modelId: "test-model",
    supportsVision: true,
    start: vi.fn(async (events: ChatBackendEvents) => {
      ref.events = events;
    }),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
}

async function createApp(
  backend: ChatBackend,
  attachments: AttachmentService = fakeAttachments(),
  extra: Partial<VspiAppOptions> = {},
): Promise<VspiApp> {
  const app = new VspiApp(fakeTui(), plainTheme(), backend, {
    cwd: "/workspace/input-dispatch",
    settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
    attachments,
    renderOnce: true,
    onExit: vi.fn(),
    ...extra,
  });
  await app.start();
  return app;
}

async function createPlanApp(route: ReturnType<typeof vi.fn>, overrides: Partial<ChatBackend> = {}): Promise<VspiApp> {
  const backend = backendWith({}, { getPlanBinding: () => ({ planId: PLAN.id }), ...overrides });
  return createApp(backend, fakeAttachments(), {
    planBackend: {
      read: vi.fn(async () => structuredClone(PLAN)),
      update: vi.fn(async () => structuredClone(PLAN)),
    },
    planTaskRouter: { route },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("busy submission guard", () => {
  it("keeps the draft and blocks Enter and Alt+Enter while a generation is busy", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    let releaseSend: (() => void) | undefined;
    const send = vi.fn(async (_text: string, _options: SendOptions) => {
      ref.events?.onBusy(true);
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      ref.events?.onBusy(false);
    });
    const app = await createApp(backendWith(ref, { send }));
    const testable = app as unknown as TestableApp;
    try {
      const first = testable.submit("FIRST");
      await flush();
      expect(testable.busy).toBe(true);

      app.composer.setText("SECOND_DRAFT");
      app.handleInput("\r");
      expect(app.composer.getText()).toBe("SECOND_DRAFT");
      expect(send).toHaveBeenCalledTimes(1);
      expect(testable.notice?.text).toContain("生成中");

      app.handleInput("\x1b\r");
      expect(app.composer.getText()).toBe("SECOND_DRAFT");
      expect(send).toHaveBeenCalledTimes(1);

      releaseSend?.();
      await first;
      await flush();
      expect(testable.busy).toBe(false);

      app.handleInput("\r");
      await flush();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0]).toBe("SECOND_DRAFT");
      expect(send.mock.calls[1]?.[1]?.behavior).toBe("prompt");
      releaseSend?.();
      await flush();
    } finally {
      releaseSend?.();
      await app.dispose();
    }
  });

  it("does not leak a stale followUp behavior from swallowed Alt+Enter presses", async () => {
    const send = vi.fn(async (_text: string, _options: SendOptions) => {});
    const app = await createApp(backendWith({}, { send }));
    try {
      app.handleInput("\x1b\r");
      expect(send).not.toHaveBeenCalled();

      app.composer.setText("普通消息");
      app.handleInput("\r");
      await flush();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[1]?.behavior).toBe("prompt");

      app.composer.setText("跟进消息");
      app.handleInput("\x1b\r");
      await flush();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[1]?.behavior).toBe("followUp");

      app.composer.setText("再次普通");
      app.handleInput("\r");
      await flush();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]?.[1]?.behavior).toBe("prompt");
    } finally {
      await app.dispose();
    }
  });
});

describe("attachment preview capture", () => {
  it("captures all input except Escape while the preview is open", async () => {
    const previewComponent = { render: () => ["PREVIEW"], invalidate: () => {} };
    const attachments = fakeAttachments({ preview: vi.fn(async () => previewComponent) });
    const send = vi.fn(async (_text: string, _options: SendOptions) => {});
    const app = await createApp(backendWith({}, { send }), attachments);
    const testable = app as unknown as TestableApp;
    try {
      app.composer.addAttachment(ATTACHMENT);
      app.handleInput("\x1b[D");
      app.handleInput("\x1b[D");
      app.handleInput("\x1bOR");
      await flush();
      expect(testable.preview).toBeDefined();

      const before = app.composer.getText();
      app.handleInput("a");
      app.handleInput("\r");
      app.handleInput("\t");
      expect(app.composer.getText()).toBe(before);
      expect(send).not.toHaveBeenCalled();
      expect(testable.inspectIndex).toBeUndefined();
      expect(testable.notice?.text).toContain("Esc");

      app.handleInput("\x1b");
      expect(testable.preview).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });
});

describe("command panel close", () => {
  it("keeps a slash draft with real content and only clears a bare slash", async () => {
    const app = await createApp(backendWith({}));
    const testable = app as unknown as TestableApp;
    try {
      for (const character of "/compact custom 保留这段指令") app.handleInput(character);
      expect(testable.panels.kind).toBe("commands");

      app.handleInput("\x1b");
      await flush();
      expect(app.composer.getText()).toBe("/compact custom 保留这段指令");
      expect(testable.panels.kind).toBe("plan");

      app.handleInput("\x1b");
      await flush();
      expect(app.composer.getText()).toBe("/compact custom 保留这段指令");

      app.composer.setText("");
      app.handleInput("/");
      expect(testable.panels.kind).toBe("commands");
      app.handleInput("\x1b");
      await flush();
      expect(app.composer.getText()).toBe("");
      expect(testable.panels.kind).toBe("plan");
    } finally {
      await app.dispose();
    }
  });
});

describe("Plan router question", () => {
  it("resumes the routed submission after the question is answered", async () => {
    const route = vi.fn(async () => ({ kind: "question" as const, questions: ROUTE_QUESTIONS }));
    const send = vi.fn(async (_text: string, _options: SendOptions) => {});
    const app = await createPlanApp(route, { send });
    const testable = app as unknown as TestableApp;
    try {
      await flush();
      expect(testable.planSnapshot?.id).toBe(PLAN.id);

      await testable.submit("设计并实现一个完全无关的计费系统");
      expect(route).toHaveBeenCalledOnce();
      expect(testable.panels.kind).toBe("question");
      expect(send).not.toHaveBeenCalled();

      const answered = ROUTE_QUESTIONS[0];
      if (!answered) throw new Error("route question fixture is missing");
      await testable.applyPanelEvent({ type: "questions", questions: [{ ...answered, answer: "chat-only" }] });
      await flush();
      expect(testable.panels.kind).toBe("plan");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBe("设计并实现一个完全无关的计费系统");
    } finally {
      await app.dispose();
    }
  });

  it("restores the draft when the routed question is cancelled", async () => {
    const route = vi.fn(async () => ({ kind: "question" as const, questions: ROUTE_QUESTIONS }));
    const app = await createPlanApp(route);
    const testable = app as unknown as TestableApp;
    try {
      await flush();
      await testable.submit("设计并实现一个完全无关的计费系统");
      expect(testable.panels.kind).toBe("question");

      app.handleInput("\x1b");
      await flush();
      expect(app.composer.getText()).toBe("设计并实现一个完全无关的计费系统");
      expect(testable.panels.kind).toBe("plan");
    } finally {
      await app.dispose();
    }
  });
});

describe("session switch race guard", () => {
  it("drops stale old-session events until the new session resets", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const switchSession = vi.fn(async (id: string) => {
      ref.events?.onMessage({ id: "late", role: "assistant", kind: "text", text: "LATE_STALE" });
      ref.events?.onBusy(true);
      ref.events?.onUsage({
        contextTokens: 1,
        contextWindow: 1,
        contextPercent: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 1,
        currency: "CNY",
        source: "stale",
        asOf: "now",
        fxRate: 1,
      });
      ref.events?.onSessionReset?.({ id, reason: "resume" });
      ref.events?.onMessage({ id: "restored", role: "assistant", kind: "text", text: "RESTORED_OK" });
    });
    const app = await createApp(backendWith(ref, { switchSession }));
    const testable = app as unknown as TestableApp;
    try {
      ref.events?.onMessage({ id: "old", role: "assistant", kind: "text", text: "OLD_OK" });
      await testable.applyPanelEvent({ type: "session", session: SESSION });
      await flush();
      expect(testable.messages.map((message) => message.id)).toEqual(["restored"]);
      expect(testable.busy).toBe(false);
    } finally {
      await app.dispose();
    }
  });

  it("resumes normal event flow after a failed session switch", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const switchSession = vi.fn(async () => {
      throw new Error("switch failed sentinel");
    });
    const app = await createApp(backendWith(ref, { switchSession }));
    const testable = app as unknown as TestableApp;
    try {
      await testable.applyPanelEvent({ type: "session", session: SESSION });
      expect(testable.notice?.tone).toBe("error");

      ref.events?.onMessage({ id: "after", role: "assistant", kind: "text", text: "AFTER_FAIL" });
      expect(testable.messages.some((message) => message.id === "after")).toBe(true);
    } finally {
      await app.dispose();
    }
  });
});

describe("busy model switching gate", () => {
  it("rejects model panel selection while a generation is busy", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const selectModel = vi.fn();
    const app = await createApp(backendWith(ref, { selectModel }));
    const testable = app as unknown as TestableApp;
    try {
      ref.events?.onBusy(true);
      await testable.applyPanelEvent({ type: "model", model: MODEL });
      expect(selectModel).not.toHaveBeenCalled();
      expect(testable.notice?.tone).toBe("warning");
      expect(testable.notice?.text).toContain("生成中");
      ref.events?.onBusy(false);
    } finally {
      await app.dispose();
    }
  });
});

describe("rename and inspect Ctrl+C semantics", () => {
  it("caps rename input at 200 characters and lets Ctrl+C exit when idle", async () => {
    const onExit = vi.fn();
    const app = await createApp(backendWith({}), fakeAttachments(), { onExit });
    const testable = app as unknown as TestableApp;
    try {
      testable.renameAttachmentId = ATTACHMENT.id;
      testable.renameInput = "";
      app.handleInput("x".repeat(300));
      expect(Array.from(testable.renameInput)).toHaveLength(200);

      app.handleInput("\x03");
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      await app.dispose();
    }
  });

  it("lets Ctrl+C exit from Inspect instead of swallowing it", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const onExit = vi.fn();
    const app = await createApp(backendWith(ref), fakeAttachments(), { onExit });
    const testable = app as unknown as TestableApp;
    try {
      ref.events?.onMessage({ id: "m1", role: "assistant", kind: "text", text: "hello" });
      app.handleInput("\t");
      expect(testable.inspectIndex).toBe(0);

      app.handleInput("\x03");
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      await app.dispose();
    }
  });

  it("notices instead of dead-keying Tab on an empty transcript", async () => {
    const app = await createApp(backendWith({}));
    const testable = app as unknown as TestableApp;
    try {
      app.handleInput("\t");
      expect(testable.inspectIndex).toBeUndefined();
      expect(testable.notice?.text).toContain("暂无消息");
    } finally {
      await app.dispose();
    }
  });
});

describe("Plan focus and hints", () => {
  it("keeps Plan focus after /plan and aligns the hint with the focus state", async () => {
    const route = vi.fn(async () => ({ kind: "current-plan" as const }));
    const app = await createPlanApp(route);
    const testable = app as unknown as TestableApp;
    try {
      await flush();
      await testable.submit("/plan");
      expect(testable.panelFocused).toBe(true);
      const focusedHint = app
        .render(80)
        .map(stripAnsi)
        .find((line) => line.includes("Shift+Tab") || line.includes("↑↓"));
      expect(focusedHint).toContain("↑↓ 选择");
      expect(focusedHint).toContain("Enter 操作");

      app.handleInput("\x1b[Z");
      expect(testable.panelFocused).toBe(false);
      const unfocusedHint = app
        .render(80)
        .map(stripAnsi)
        .find((line) => line.includes("Shift+Tab") || line.includes("↑↓"));
      expect(unfocusedHint).toContain("Shift+Tab");
      expect(unfocusedHint).not.toContain("↑↓");
      expect(unfocusedHint).not.toContain("Enter 操作");
    } finally {
      await app.dispose();
    }
  });
});

describe("Kitty CSI-u printable decoding", () => {
  it("matches Kitty CSI-u printable input in the interaction registry", () => {
    expect(
      matchesInteraction("panel", "providers", "editProvider", "\x1b[97u", {
        providerEditing: true,
        providerField: 0,
      }),
    ).toBe(true);
    expect(matchesInteraction("panel", "models", "editModelSearch", "\x1b[97u")).toBe(true);
    expect(matchesInteraction("composer", "rename", "editRename", "\x1b[97u")).toBe(true);
    expect(matchesInteraction("composer", "rename", "editRename", "\x1b[13u")).toBe(false);
  });
});
