import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp, type VspiAppOptions } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents, SendOptions, SessionHandoffResponse } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { Attachment, ModelOption, Question, SessionOption, TranscriptMessage } from "../src/domain/types.js";
import type { StoredPlan } from "../src/plans/types.js";
import { createInteractiveApprovalBroker } from "../src/policy/startup-runtime.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { matchesInteraction } from "../src/ui/interactions.js";
import type { PanelController, PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

type TestableApp = {
  submit(raw: string, options?: { skipPlanRoute?: boolean }): Promise<void>;
  applyPanelEvent(event: PanelEvent): Promise<void>;
  messages: TranscriptMessage[];
  busy: boolean;
  queueState: { steering: number; followUp: number };
  workingFrame: number;
  workspaceFocus: "composer" | "transcript" | "plan";
  panelFocused: boolean;
  panels: PanelController;
  planSnapshot?: StoredPlan;
  preview?: unknown;
  inspectIndex?: number;
  inspectNodeId?: string;
  inspectToolId?: string;
  inspectDepth: "node" | "tool";
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
  efforts: ["low", "medium", "high"],
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

describe("same-Session foreground handoff", () => {
  it("starts the waiting TUI before lease acquisition and initializes runtime controls only after readiness", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    let ready = false;
    const getModelOptions = vi.fn(async () => []);
    const backend = backendWith(ref, {
      isSessionReady: () => ready,
      getModelOptions,
      start: vi.fn(async (events: ChatBackendEvents) => {
        ref.events = events;
        events.onSessionWait?.(true);
      }),
    });
    const onExit = vi.fn();
    const app = await createApp(backend, fakeAttachments(), { onExit });
    try {
      expect(getModelOptions).not.toHaveBeenCalled();
      app.handleInput("x");
      expect(app.composer.getText()).toBe("");
      app.handleInput("\u0003");
      expect(onExit).toHaveBeenCalledOnce();

      ready = true;
      ref.events?.onSessionReset?.({ id: "acquired-session", reason: "resume" });
      ref.events?.onSessionReady?.();
      await flush();
      expect(getModelOptions).toHaveBeenCalledOnce();
    } finally {
      await app.dispose();
    }
  });

  it("moves an already-open Question off the old TUI and resolves its original Promise from the new TUI", async () => {
    const oldRef: { events?: ChatBackendEvents } = {};
    const oldApp = await createApp(backendWith(oldRef));
    let receiveResponse!: (value: SessionHandoffResponse) => void;
    const request = vi.fn(
      async () =>
        new Promise<SessionHandoffResponse>((resolvePromise) => {
          receiveResponse = resolvePromise;
        }),
    );
    const question: Question = {
      id: "handoff-question",
      title: "Continue",
      prompt: "Continue the active tool?",
      kind: "singleChoice",
      options: [{ id: "continue", label: "Continue" }],
    };
    const questions = [question];
    try {
      const original = oldRef.events?.onQuestion?.(questions);
      expect((oldApp as unknown as TestableApp).panels.kind).toBe("question");
      oldRef.events?.onHandoffPending?.({ request });
      await flush();
      expect(request).toHaveBeenCalledWith({ kind: "question", questions });
      expect((oldApp as unknown as TestableApp).panels.kind).not.toBe("question");
      oldApp.handleInput("x");
      expect(oldApp.composer.getText()).toBe("");

      receiveResponse({
        kind: "question",
        questions: [{ ...question, answer: "continue" }],
      });
      await expect(original).resolves.toEqual([{ ...question, answer: "continue" }]);
    } finally {
      await oldApp.dispose();
    }
  });

  it("shows relayed Question and Approval only on the waiting TUI", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const approvalBroker = createInteractiveApprovalBroker();
    const app = await createApp(backendWith(ref), fakeAttachments(), { approvalBroker });
    const testable = app as unknown as TestableApp;
    try {
      ref.events?.onSessionWait?.(true);
      const question = {
        id: "relayed-question",
        title: "Choose",
        prompt: "Pick one",
        kind: "singleChoice" as const,
        options: [{ id: "yes", label: "Yes" }],
      };
      const pendingQuestion = ref.events?.onHandoffInteraction?.({ kind: "question", questions: [question] });
      await flush();
      expect(testable.panels.kind).toBe("question");
      await testable.applyPanelEvent({ type: "questions", questions: [{ ...question, answer: "yes" }] });
      await expect(pendingQuestion).resolves.toEqual({
        kind: "question",
        questions: [{ ...question, answer: "yes" }],
      });

      const approvalRequest = {
        action: { kind: "file-write" as const, target: "/tmp/result" },
        category: "file-write" as const,
        policy: "Safe" as const,
        requiredPolicy: "Standard" as const,
      };
      const pendingApproval = ref.events?.onHandoffInteraction?.({ kind: "approval", request: approvalRequest });
      await flush();
      expect(testable.panels.kind).toBe("approval");
      await testable.applyPanelEvent({ type: "approval", response: { type: "allow-once" } });
      await expect(pendingApproval).resolves.toEqual({
        kind: "approval",
        response: { type: "allow-once" },
      });
    } finally {
      await app.dispose();
    }
  });

  it("routes an Approval created after handoff begins directly to the new TUI", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const approvalBroker = createInteractiveApprovalBroker();
    const app = await createApp(backendWith(ref), fakeAttachments(), { approvalBroker });
    const request = vi.fn(async () => ({ kind: "approval" as const, response: { type: "allow-once" as const } }));
    const approvalRequest = {
      action: { kind: "file-write" as const, target: "/tmp/result" },
      category: "file-write" as const,
      policy: "Safe" as const,
      requiredPolicy: "Standard" as const,
    };
    try {
      ref.events?.onHandoffPending?.({ request });
      const response = approvalBroker.request(approvalRequest);
      await expect(response).resolves.toEqual({ type: "allow-once" });
      expect(request).toHaveBeenCalledWith({ kind: "approval", request: approvalRequest });
      expect((app as unknown as TestableApp).panels.kind).not.toBe("approval");
    } finally {
      await app.dispose();
    }
  });

  it("restores the old Question panel if the new TUI disconnects before handoff completes", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const app = await createApp(backendWith(ref));
    const question: Question = {
      id: "retry-question",
      title: "Retry",
      prompt: "Answer locally after disconnect",
      kind: "singleChoice",
      options: [{ id: "continue", label: "Continue" }],
    };
    let rejectRelay!: (error: Error) => void;
    const request = vi.fn(
      async () =>
        new Promise<SessionHandoffResponse>((_resolvePromise, rejectPromise) => {
          rejectRelay = rejectPromise;
        }),
    );
    try {
      const original = ref.events?.onQuestion?.([question]);
      ref.events?.onHandoffPending?.({ request });
      await flush();
      rejectRelay(new Error("Session handoff channel closed"));
      ref.events?.onHandoffCancelled?.();
      await flush();
      expect((app as unknown as TestableApp).panels.kind).toBe("question");
      await (app as unknown as TestableApp).applyPanelEvent({
        type: "questions",
        questions: [{ ...question, answer: "continue" }],
      });
      await expect(original).resolves.toEqual([{ ...question, answer: "continue" }]);
    } finally {
      await app.dispose();
    }
  });
});

describe("busy submission guard", () => {
  it("uses Escape to cancel active generation without replacing the session, transcript, or current draft", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    let releaseSend: (() => void) | undefined;
    const cancel = vi.fn(async () => {});
    const send = vi.fn(async () => {
      ref.events?.onBusy(true);
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      ref.events?.onBusy(false);
    });
    const newSession = vi.fn(async () => {});
    const app = await createApp(backendWith(ref, { send, cancel, newSession }));
    const testable = app as unknown as TestableApp;
    try {
      const active = testable.submit("ESC_RESTORE");
      await flush();
      expect(testable.busy).toBe(true);
      ref.events?.onMessage({
        id: "partial",
        role: "assistant",
        kind: "text",
        text: "PARTIAL_OUTPUT",
        streaming: true,
      });
      app.composer.setText("UNSENT_DRAFT");
      app.handleInput("\u001b");
      await flush();
      expect(cancel).toHaveBeenCalledOnce();
      expect(newSession).not.toHaveBeenCalled();
      expect(app.composer.getText()).toBe("UNSENT_DRAFT");
      expect(testable.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", text: "ESC_RESTORE" }),
          expect.objectContaining({ id: "partial", text: "PARTIAL_OUTPUT" }),
        ]),
      );
      releaseSend?.();
      await active;
    } finally {
      releaseSend?.();
      await app.dispose();
    }
  });

  it("accepts Enter as steer and Alt+Enter as follow-up while a generation is busy", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    let releaseSend: (() => void) | undefined;
    const send = vi.fn(async (_text: string, options: SendOptions) => {
      if (send.mock.calls.length === 1) {
        ref.events?.onBusy(true);
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        ref.events?.onBusy(false);
        return { status: "completed" as const };
      }
      return {
        status: "queued" as const,
        delivery: options.behavior === "followUp" ? ("followUp" as const) : ("steer" as const),
      };
    });
    const app = await createApp(backendWith(ref, { send }));
    const testable = app as unknown as TestableApp;
    try {
      const first = testable.submit("FIRST");
      await flush();
      expect(testable.busy).toBe(true);

      app.composer.setText("SECOND_DRAFT");
      app.handleInput("\r");
      await flush();
      expect(app.composer.getText()).toBe("");
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[1]?.behavior).toBe("prompt");
      expect(testable.notice?.text).toContain("下一次模型调用前");
      expect(testable.messages.at(-1)).toMatchObject({ text: "SECOND_DRAFT", delivery: "steer" });
      ref.events?.onQueueUpdate?.({ steering: 1, followUp: 0 });
      const queued = app.render(100).map(stripAnsi).join("\n");
      expect(queued).toContain("SECOND_DRAFT");
      expect(queued).toContain("↪");
      expect(queued.indexOf("Working")).toBeLessThan(queued.indexOf("SECOND_DRAFT"));
      expect(queued).not.toMatch(/等待插入|等待当前任务完成/);

      app.composer.setText("THIRD_FOLLOW_UP");
      app.handleInput("\x1b\r");
      await flush();
      expect(app.composer.getText()).toBe("");
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]?.[1]?.behavior).toBe("followUp");
      expect(testable.messages.at(-1)).toMatchObject({ text: "THIRD_FOLLOW_UP", delivery: "followUp" });
      ref.events?.onQueueUpdate?.({ steering: 1, followUp: 1 });

      ref.events?.onQueueUpdate?.({ steering: 0, followUp: 1 });
      expect(
        testable.messages.find((message) => message.kind === "text" && message.text === "SECOND_DRAFT"),
      ).not.toHaveProperty("delivery");
      ref.events?.onQueueUpdate?.({ steering: 0, followUp: 0 });
      expect(
        testable.messages.find((message) => message.kind === "text" && message.text === "THIRD_FOLLOW_UP"),
      ).not.toHaveProperty("delivery");
      expect(app.render(100).map(stripAnsi).join("\n")).not.toMatch(/等待插入|等待当前任务完成/);

      releaseSend?.();
      await first;
      await flush();
      expect(testable.busy).toBe(false);
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

  it("interrupts the active run and immediately continues with native queued messages", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    let releaseSend: (() => void) | undefined;
    let releaseResumed: (() => void) | undefined;
    const send = vi.fn(async (_text: string, options: SendOptions) => {
      if (send.mock.calls.length === 1) {
        ref.events?.onBusy(true);
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        ref.events?.onBusy(false);
        return { status: "completed" as const };
      }
      if (send.mock.calls.length === 4) {
        ref.events?.onBusy(true);
        await new Promise<void>((resolve) => {
          releaseResumed = resolve;
        });
        ref.events?.onBusy(false);
        return { status: "completed" as const };
      }
      return {
        status: "queued" as const,
        delivery: options.behavior === "followUp" ? ("followUp" as const) : ("steer" as const),
      };
    });
    const cancel = vi.fn(async () => {
      releaseSend?.();
      ref.events?.onBusy(false);
      return { queuedMessages: ["QUEUED_CORRECTION", "QUEUED_FOLLOW_UP"] };
    });
    const app = await createApp(backendWith(ref, { send, cancel }));
    const testable = app as unknown as TestableApp;
    try {
      const active = testable.submit("PRIMARY_TASK");
      await flush();
      app.composer.setText("QUEUED_CORRECTION");
      app.handleInput("\r");
      await flush();
      app.composer.setText("QUEUED_FOLLOW_UP");
      app.handleInput("\x1b\r");
      await flush();
      app.composer.setText("CURRENT_DRAFT");

      app.handleInput("\u001b");
      await flush();
      expect(cancel).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(4);
      expect(send.mock.calls[3]?.[0]).toBe("QUEUED_CORRECTION\n\nQUEUED_FOLLOW_UP");
      expect(send.mock.calls[3]?.[1]?.behavior).toBe("prompt");
      expect(app.composer.getText()).toBe("CURRENT_DRAFT");
      expect(
        testable.messages.filter(
          (message) => message.kind === "text" && message.text === "QUEUED_CORRECTION\n\nQUEUED_FOLLOW_UP",
        ),
      ).toEqual([expect.not.objectContaining({ delivery: expect.anything() })]);
      expect(testable.messages.some((message) => message.kind === "text" && message.text === "QUEUED_CORRECTION")).toBe(
        false,
      );
      expect(testable.messages.some((message) => message.kind === "text" && message.text === "QUEUED_FOLLOW_UP")).toBe(
        false,
      );
      expect(testable.notice?.text).toContain("正在处理 2 条排队消息");
      await active;
      releaseResumed?.();
      await flush();
    } finally {
      releaseSend?.();
      releaseResumed?.();
      await app.dispose();
    }
  });

  it("animates a quiet Working row without duplicating native queue counts", async () => {
    vi.useFakeTimers();
    const ref: { events?: ChatBackendEvents } = {};
    const app = await createApp(backendWith(ref));
    const testable = app as unknown as TestableApp;
    try {
      ref.events?.onQueueUpdate?.({ steering: 2, followUp: 1 });
      ref.events?.onBusy(true);
      expect(testable.workingFrame).toBe(0);
      const firstFrame = app.render(120).map(stripAnsi).join("\n");
      expect(firstFrame).toContain("Working ⣾");
      expect(firstFrame).not.toMatch(/▌ Working|插入 2|后续 1|队列 3/);
      vi.advanceTimersByTime(240);
      expect(testable.workingFrame).toBe(1);
      expect(app.render(120).map(stripAnsi).join("\n")).toContain("Working ⣽");
    } finally {
      await app.dispose();
      vi.useRealTimers();
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
  it("exits the Question overlay before a later Escape can cancel generation", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const app = await createApp(backendWith(ref));
    const testable = app as unknown as TestableApp;
    try {
      const pending = ref.events?.onQuestion?.([{ id: "reason", title: "Reason", prompt: "Why?", kind: "freeText" }]);
      expect(testable.panels.kind).toBe("question");
      app.handleInput("draft reason");
      app.handleInput("\u001b");
      await expect(pending).rejects.toThrow(/cancel/i);
      expect(testable.panels.kind).toBe("plan");
    } finally {
      await app.dispose();
    }
  });

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

describe("tool approval overlay", () => {
  it("returns a structured denial when Escape closes the approval panel", async () => {
    const broker = createInteractiveApprovalBroker();
    const app = await createApp(backendWith({}), fakeAttachments(), { approvalBroker: broker });
    const testable = app as unknown as TestableApp;
    try {
      const pending = broker.request({
        action: { kind: "network", category: "ssh", target: "ssh build-host" },
        category: "ssh",
        policy: "Standard",
        requiredPolicy: "YOLO",
      });
      expect(testable.panels.kind).toBe("approval");
      app.handleInput("\u001b");
      await expect(pending).resolves.toEqual({ type: "deny", reason: "Approval cancelled by user" });
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

  it("cycles Composer, Transcript, and Plan while keeping two-level transcript selection stable", async () => {
    const ref: { events?: ChatBackendEvents } = {};
    const app = await createApp(backendWith(ref));
    const testable = app as unknown as TestableApp;
    try {
      ref.events?.onMessage({ id: "user", role: "user", kind: "text", text: "inspect" });
      ref.events?.onMessage({
        id: "thinking",
        role: "assistant",
        kind: "thinking",
        effort: "high",
        text: "reasoning",
        collapsed: true,
      });
      ref.events?.onMessage({
        id: "tool-1",
        role: "assistant",
        kind: "tool",
        groupId: "turn-1",
        name: "read",
        summary: "package.json",
        status: "success",
        output: "first output",
        expanded: false,
      });
      ref.events?.onMessage({
        id: "tool-2",
        role: "assistant",
        kind: "tool",
        groupId: "turn-1",
        name: "bash",
        summary: "npm test",
        status: "success",
        output: "second output",
        expanded: false,
      });
      ref.events?.onMessage({ id: "answer", role: "assistant", kind: "text", text: "done" });

      app.handleInput("\x1b[Z");
      expect(testable.workspaceFocus).toBe("transcript");
      expect(testable.inspectNodeId).toBe("answer");

      app.handleInput("\x1b[A");
      expect(testable.inspectNodeId).toBe("tool-group:turn-1");
      app.handleInput("\r");
      expect(testable.inspectDepth).toBe("tool");
      expect(testable.inspectToolId).toBe("tool-1");
      app.handleInput("\x1b[B");
      expect(testable.inspectToolId).toBe("tool-2");
      app.handleInput("\x1b[C");
      expect(testable.messages.find((message) => message.id === "tool-2")).toMatchObject({ expanded: true });
      expect(app.render(80).map(stripAnsi).join("\n")).toContain("second output");
      app.handleInput("\x1b[D");
      expect(testable.messages.find((message) => message.id === "tool-2")).toMatchObject({ expanded: false });
      expect(testable.inspectDepth).toBe("tool");
      app.handleInput("\x1b[D");
      expect(testable.inspectDepth).toBe("node");

      ref.events?.onMessage({ id: "later", role: "assistant", kind: "text", text: "later" });
      expect(testable.inspectNodeId).toBe("tool-group:turn-1");
      app.handleInput("\x1b[A");
      expect(testable.inspectNodeId).toBe("thinking");
      app.handleInput("\x1b[C");
      expect(testable.messages.find((message) => message.id === "thinking")).toMatchObject({ collapsed: false });
      app.handleInput("\x1b[D");
      expect(testable.messages.find((message) => message.id === "thinking")).toMatchObject({ collapsed: true });

      app.handleInput("\x1b[Z");
      expect(testable.workspaceFocus).toBe("plan");
      app.handleInput("\x1b[Z");
      expect(testable.workspaceFocus).toBe("composer");
    } finally {
      await app.dispose();
    }
  });

  it("skips an empty Transcript in the Shift+Tab focus cycle", async () => {
    const app = await createApp(backendWith({}));
    const testable = app as unknown as TestableApp;
    try {
      app.handleInput("\x1b[Z");
      expect(testable.workspaceFocus).toBe("plan");
      app.handleInput("\x1b[Z");
      expect(testable.workspaceFocus).toBe("composer");
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
      expect(testable.workspaceFocus).toBe("plan");
      const focusedHint = app
        .render(80)
        .map(stripAnsi)
        .find((line) => line.includes("Shift+Tab") || line.includes("↑↓"));
      expect(focusedHint).toContain("↑↓ 选择");
      expect(focusedHint).toContain("Enter 操作");

      app.handleInput("\x1b[Z");
      expect(testable.panelFocused).toBe(false);
      expect(testable.workspaceFocus).toBe("composer");
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
