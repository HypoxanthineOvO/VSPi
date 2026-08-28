import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type PromptOptions,
  SessionManager,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveBackend } from "../src/backend/adaptive-backend.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../src/backend/types.js";
import type { TranscriptMessage } from "../src/domain/types.js";
import { createExecutionPolicyService } from "../src/policy/execution-policy.js";
import type { SessionHandoffChannel } from "../src/sessions/lease.js";

function emptyStats(sessionId = "session-id"): SessionStats {
  return {
    sessionFile: undefined,
    sessionId,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function fakePiSession(
  messages: unknown[],
  options: {
    sessionId?: string;
    configured?: boolean;
    prompt?: () => Promise<void>;
    isStreaming?: boolean;
    clearQueue?: () => { steering: string[]; followUp: string[] };
    savedModel?: { provider: string; modelId: string };
    availableByProvider?: Record<string, Array<{ id: string; name: string; provider: string; input: string[] }>>;
    setModelError?: Error;
  } = {},
) {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const sessionId = options.sessionId ?? "m2-restored-session";
  const session = {
    model:
      options.configured === false
        ? undefined
        : {
            id: "m2-model",
            name: "M2 Model",
            provider: "anthropic",
            input: ["text"],
            contextWindow: 200_000,
          },
    messages,
    sessionId,
    thinkingLevel: "high",
    ...(options.savedModel
      ? {
          sessionManager: {
            buildSessionContext: () => ({ model: options.savedModel }),
            getEntries: () => [],
            getBranch: () => [],
          },
          modelRuntime: {
            getAvailable: vi.fn(async (provider?: string) => options.availableByProvider?.[provider ?? ""] ?? []),
          },
        }
      : {}),
    isStreaming: options.isStreaming ?? false,
    subscribe(callback: (event: AgentSessionEvent) => void) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    setThinkingLevel: vi.fn(),
    setModel: vi.fn(async (_model: unknown) => {
      if (options.setModelError) throw options.setModelError;
    }),
    prompt: vi.fn(async (_text: string, _options?: PromptOptions) => options.prompt?.()),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    clearQueue: vi.fn(options.clearQueue ?? (() => ({ steering: [], followUp: [] }))),
    abort: vi.fn(async () => {}),
    compact: vi.fn(async () => ({})),
    getContextUsage: vi.fn(() => ({ tokens: 512, contextWindow: 200_000, percent: 0.256 })),
    getSessionStats: vi.fn(() => emptyStats(sessionId)),
    dispose: vi.fn(),
  } as unknown as AgentSession;
  return { session, emit: (event: AgentSessionEvent) => listener?.(event) };
}

function eventRecorder() {
  const messages: TranscriptMessage[] = [];
  const events: ChatBackendEvents = {
    onMessage: (message) => messages.push(message),
    onMessageUpdate: (id, patch) => {
      const index = messages.findIndex((message) => message.id === id);
      const current = messages[index];
      if (current) messages[index] = { ...current, ...patch } as TranscriptMessage;
    },
    onBusy: vi.fn(),
    onQueueUpdate: vi.fn(),
    onUsage: vi.fn(),
    onNotice: vi.fn(),
  };
  return { events, messages };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("M2 truthful backend selection", () => {
  it("propagates a real Pi setup failure and never starts Fixture in the default path", async () => {
    const setupFailure = new Error("No configured model is available");
    const piStart = vi.spyOn(PiBackend.prototype, "start").mockRejectedValue(setupFailure);
    const fixtureStart = vi.spyOn(FixtureBackend.prototype, "start").mockResolvedValue();
    const backend = new AdaptiveBackend(await mkdtemp(join(tmpdir(), "vspi-m2-no-model-")));

    await expect(backend.start(eventRecorder().events)).rejects.toBe(setupFailure);
    expect(piStart).toHaveBeenCalledOnce();
    expect(fixtureStart).not.toHaveBeenCalled();
    expect(backend.kind).toBe("pi");
  });

  it("uses Offline Fixture only when the caller explicitly requests the fixture entry", async () => {
    const piStart = vi.spyOn(PiBackend.prototype, "start").mockRejectedValue(new Error("Pi must not start"));
    const fixtureStart = vi.spyOn(FixtureBackend.prototype, "start").mockResolvedValue();
    const backend = new AdaptiveBackend(await mkdtemp(join(tmpdir(), "vspi-m2-fixture-")), "fixture");

    await expect(backend.start(eventRecorder().events)).resolves.toBeUndefined();
    expect(backend.kind).toBe("fixture");
    expect(fixtureStart).toHaveBeenCalledOnce();
    expect(piStart).not.toHaveBeenCalled();
  });
});

describe("M2 Pi history hydration", () => {
  it("persists the Session Policy and restores it before publishing a resumed reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m2-policy-resume-"));
    const cwd = join(root, "project");
    const sessionDir = join(root, "sessions");
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({ role: "user", content: "POLICY_RESUME_SENTINEL", timestamp: 1 });

    const firstPolicy = createExecutionPolicyService({ workspace: cwd, policy: "Standard" });
    const firstBackend = new PiBackend({
      cwd,
      sessionDir,
      continueRecent: true,
      executionPolicy: firstPolicy,
      sessionFactory: async (restored) => {
        const fake = fakePiSession(restored.buildSessionContext().messages, {
          sessionId: restored.getSessionId(),
        }).session;
        return { session: Object.assign(fake, { sessionManager: restored }) };
      },
    });
    await firstBackend.start(eventRecorder().events);
    await firstBackend.setPolicy("Auto");
    expect(firstPolicy.snapshot().policy).toBe("Auto");
    await firstBackend.dispose();

    const resumedPolicy = createExecutionPolicyService({ workspace: cwd, policy: "Standard" });
    const observedAtReset: string[] = [];
    const resumedEvents = eventRecorder().events;
    resumedEvents.onSessionReset = () => observedAtReset.push(resumedPolicy.snapshot().policy);
    const resumedBackend = new PiBackend({
      cwd,
      sessionDir,
      continueRecent: true,
      executionPolicy: resumedPolicy,
      sessionFactory: async (restored) => {
        const fake = fakePiSession(restored.buildSessionContext().messages, {
          sessionId: restored.getSessionId(),
        }).session;
        return { session: Object.assign(fake, { sessionManager: restored }) };
      },
    });
    await resumedBackend.start(resumedEvents);

    expect(observedAtReset).toEqual(["Auto"]);
    expect(resumedPolicy.snapshot().policy).toBe("Auto");
    await resumedBackend.dispose();

    const recoveryPolicy = createExecutionPolicyService({ workspace: cwd, policy: "Standard", recovery: true });
    const recoveryBackend = new PiBackend({
      cwd,
      sessionDir,
      continueRecent: true,
      recovery: true,
      executionPolicy: recoveryPolicy,
      sessionFactory: async (restored) => {
        const fake = fakePiSession(restored.buildSessionContext().messages, {
          sessionId: restored.getSessionId(),
        }).session;
        return { session: Object.assign(fake, { sessionManager: restored }) };
      },
    });
    await recoveryBackend.start(eventRecorder().events);
    expect(recoveryPolicy.snapshot().policy).toBe("Standard");
    await recoveryBackend.dispose();
  });

  it("keeps an Auto switch effective when optional Session recovery metadata cannot be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m2-policy-runtime-"));
    const cwd = join(root, "project");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(sessionDir);
    const policy = createExecutionPolicyService({ workspace: cwd, policy: "Standard" });
    let activeManager: SessionManager | undefined;
    const recorded = eventRecorder();
    const backend = new PiBackend({
      cwd,
      sessionDir,
      executionPolicy: policy,
      sessionFactory: async (manager) => {
        activeManager = manager;
        const fake = fakePiSession(manager.buildSessionContext().messages, {
          sessionId: manager.getSessionId(),
        }).session;
        return { session: Object.assign(fake, { sessionManager: manager }) };
      },
    });
    await backend.start(recorded.events);
    if (!activeManager) throw new Error("test SessionManager was not captured");
    (activeManager as unknown as { fileEntries: unknown[] }).fileEntries = [];

    const snapshot = await backend.setPolicy("Auto");

    expect(snapshot).toMatchObject({ policy: "Auto", persistenceWarning: expect.stringContaining("未保存") });
    expect(policy.snapshot().policy).toBe("Auto");
    await backend.dispose();
  });

  it("restores the selected Session Policy when Resume switches away from a fresh Standard session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m2-policy-picker-"));
    const cwd = join(root, "project");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(sessionDir);
    const target = SessionManager.create(cwd, sessionDir);
    target.appendMessage({ role: "user", content: "POLICY_PICKER_SENTINEL", timestamp: 1 });
    target.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m2-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    target.appendCustomEntry("vspi.execution-policy", { version: 1, policy: "Auto" });

    const policy = createExecutionPolicyService({ workspace: cwd, policy: "Standard" });
    const observedAtReset: Array<{ id: string; policy: string }> = [];
    const events = eventRecorder().events;
    events.onSessionReset = (session) => observedAtReset.push({ id: session.id, policy: policy.snapshot().policy });
    const backend = new PiBackend({
      cwd,
      sessionDir,
      executionPolicy: policy,
      sessionFactory: async (manager) => {
        const fake = fakePiSession(manager.buildSessionContext().messages, {
          sessionId: manager.getSessionId(),
        }).session;
        return { session: Object.assign(fake, { sessionManager: manager }) };
      },
    });

    await backend.start(events);
    expect(policy.snapshot().policy).toBe("Standard");
    await backend.switchSession(target.getSessionId());

    expect(policy.snapshot().policy).toBe("Auto");
    expect(observedAtReset.at(-1)).toEqual({ id: target.getSessionId(), policy: "Auto" });
    await backend.dispose();
  });

  it("marks an interrupted resumed turn without retrying the final user message", async () => {
    const interrupted = {
      role: "user",
      content: [{ type: "text", text: "LAST_UNFINISHED_REQUEST" }],
      timestamp: Date.now(),
    };
    const fake = fakePiSession([interrupted]);
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-interrupted-resume-")),
      continueRecent: true,
      sessionFactory: async () => ({ session: fake.session }),
    });

    await backend.start(recorder.events);

    expect(recorder.messages).toEqual([
      expect.objectContaining({ kind: "text", role: "user", text: "LAST_UNFINISHED_REQUEST" }),
      expect.objectContaining({ kind: "session", text: expect.stringContaining("未自动重试") }),
    ]);
    expect(fake.session.prompt).not.toHaveBeenCalled();
    await backend.dispose();
  });

  it("hydrates the restored transcript before start resolves and does not duplicate it on later events", async () => {
    const priorUser = {
      role: "user",
      content: [{ type: "text", text: "RESTORED_USER_SENTINEL" }],
      timestamp: 1,
    };
    const priorAssistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "RESTORED_THINKING_SENTINEL" },
        { type: "text", text: "RESTORED_ASSISTANT_SENTINEL" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m2-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    };
    const fake = fakePiSession([priorUser, priorAssistant]);
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-hydrate-")),
      sessionFactory: async () => ({ session: fake.session }),
    });

    await backend.start(recorder.events);

    expect(recorder.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", kind: "text", text: "RESTORED_USER_SENTINEL" }),
        expect.objectContaining({
          role: "assistant",
          kind: "thinking",
          text: "RESTORED_THINKING_SENTINEL",
          streaming: false,
        }),
        expect.objectContaining({ role: "assistant", kind: "text", text: "RESTORED_ASSISTANT_SENTINEL" }),
      ]),
    );
    const hydratedCount = recorder.messages.length;

    fake.emit({ type: "message_end", message: priorAssistant } as AgentSessionEvent);
    expect(recorder.messages).toHaveLength(hydratedCount);
    expect(
      recorder.messages.filter((message) => message.kind === "text" && message.text === "RESTORED_ASSISTANT_SENTINEL"),
    ).toHaveLength(1);
    await backend.dispose();
  });

  it("uses AgentSessionRuntime as the single native replacement owner", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../src/backend/pi-runtime-backend.ts", import.meta.url), "utf8"),
    );

    expect(source).toMatch(/createAgentSessionRuntime\s*,/);
    expect(source).toMatch(/return createAgentSessionRuntime\(factory,/);
    expect(source).toMatch(/runtime\.newSession\s*\(/);
    expect(source).toMatch(/runtime\.switchSession\s*\(/);
    expect(source).toMatch(/runtime\.fork\s*\(/);
  });

  it("delegates busy messages to Pi steer and followUp without replacing the active generation", async () => {
    const fake = fakePiSession([], { isStreaming: true });
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-native-queue-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start(eventRecorder().events);

    await expect(
      backend.send("在下一次调用前修正", { attachments: [], effort: "high", behavior: "prompt" }),
    ).resolves.toEqual({ status: "queued", delivery: "steer" });
    expect(fake.session.steer).toHaveBeenCalledWith("在下一次调用前修正", []);

    await expect(
      backend.send("完成后总结", { attachments: [], effort: "high", behavior: "followUp" }),
    ).resolves.toEqual({ status: "queued", delivery: "followUp" });
    expect(fake.session.followUp).toHaveBeenCalledWith("完成后总结", []);
    expect(fake.session.prompt).not.toHaveBeenCalled();
    await backend.dispose();
  });

  it("keeps Working active across agent boundaries until the generation and native queues are both idle", async () => {
    let releasePrompt: (() => void) | undefined;
    const fake = fakePiSession([], {
      prompt: () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
        }),
    });
    const recorder = eventRecorder();
    const busy = vi.mocked(recorder.events.onBusy);
    const queue = vi.mocked(recorder.events.onQueueUpdate as NonNullable<ChatBackendEvents["onQueueUpdate"]>);
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-working-continuity-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start(recorder.events);

    const pending = backend.send("长任务", { attachments: [], effort: "high", behavior: "prompt" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(busy).toHaveBeenLastCalledWith(true);
    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    fake.emit({ type: "queue_update", steering: ["修正"], followUp: ["总结"] } as AgentSessionEvent);
    fake.emit({ type: "agent_end" } as AgentSessionEvent);
    expect(busy).toHaveBeenLastCalledWith(true);
    expect(queue).toHaveBeenLastCalledWith({ steering: 1, followUp: 1 });

    releasePrompt?.();
    await pending;
    expect(busy).toHaveBeenLastCalledWith(true);
    fake.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    expect(busy).toHaveBeenLastCalledWith(false);
    await backend.dispose();
  });

  it("keeps a retrying generation busy, reports recovery, and becomes idle only after the final agent end", async () => {
    const fake = fakePiSession([]);
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-auto-retry-success-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start(recorder.events);

    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    fake.emit({ type: "agent_end", messages: [], willRetry: true } as AgentSessionEvent);
    expect(recorder.events.onBusy).toHaveBeenLastCalledWith(true);
    fake.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "503: stream_read_error",
    } as AgentSessionEvent);
    expect(recorder.events.onNotice).toHaveBeenLastCalledWith("请求暂时失败，2 秒后自动重试（1/3）", "warning");
    fake.emit({ type: "auto_retry_end", success: true, attempt: 1 } as AgentSessionEvent);
    expect(recorder.events.onNotice).toHaveBeenLastCalledWith("请求已在第 1 次重试后恢复", "success");
    expect(recorder.events.onBusy).toHaveBeenLastCalledWith(true);
    fake.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
    expect(recorder.events.onBusy).toHaveBeenLastCalledWith(false);

    await backend.dispose();
  });

  it("releases busy state and reports the final error when automatic retries are exhausted", async () => {
    const fake = fakePiSession([]);
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-auto-retry-failure-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start(recorder.events);

    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    fake.emit({ type: "agent_end", messages: [], willRetry: true } as AgentSessionEvent);
    fake.emit({
      type: "auto_retry_start",
      attempt: 3,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: "503: upstream_error: Upstream request failed",
    } as AgentSessionEvent);
    fake.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
    expect(recorder.events.onBusy).toHaveBeenLastCalledWith(false);
    fake.emit({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "503: upstream_error: Upstream request failed",
    } as AgentSessionEvent);
    expect(recorder.events.onNotice).toHaveBeenLastCalledWith("自动重试 3 次后仍然失败", "error");

    await backend.dispose();
  });

  it("defers Session takeover until the active generation reaches idle without aborting it", async () => {
    let releasePrompt: (() => void) | undefined;
    const fake = fakePiSession([], {
      prompt: () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
        }),
    });
    const recorder = eventRecorder();
    const onTakeover = vi.fn();
    recorder.events.onTakeover = onTakeover;
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-deferred-handoff-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start(recorder.events);

    const pending = backend.send("不要中断的任务", { attachments: [], effort: "high", behavior: "prompt" });
    await new Promise((resolve) => setImmediate(resolve));
    const channel: SessionHandoffChannel = {
      closed: new Promise(() => {}),
      successor: {
        schemaVersion: 1,
        pid: process.pid,
        hostname: "test",
        startedAt: new Date().toISOString(),
        sessionPath: "/tmp/test-session.jsonl",
        socketPath: "/tmp/test-session.sock",
        token: "successor",
      },
      request: vi.fn(async () => ({})),
      project: vi.fn(),
      setCommandHandler: vi.fn(),
    };
    (
      backend as unknown as {
        requestDeferredHandoff(channel: SessionHandoffChannel): void;
      }
    ).requestDeferredHandoff(channel);

    expect(fake.session.abort).not.toHaveBeenCalled();
    expect(onTakeover).not.toHaveBeenCalled();
    await expect(
      backend.send("接管后不应进入旧 runtime", { attachments: [], effort: "high", behavior: "prompt" }),
    ).rejects.toThrow("Session 正在交接");

    releasePrompt?.();
    await pending;
    expect(fake.session.abort).not.toHaveBeenCalled();
    expect(onTakeover).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it("maps one streamed assistant block to one transcript row across repeated deltas and message_end", async () => {
    const fake = fakePiSession([]);
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-stream-dedup-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "STREAM_FINAL_SENTINEL" }],
    };
    await backend.start(recorder.events);

    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
    } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "STREAM_", partial },
    } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "FINAL_SENTINEL", partial },
    } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: partial } as AgentSessionEvent);

    expect(recorder.messages).toEqual([
      expect.objectContaining({ kind: "text", text: "STREAM_FINAL_SENTINEL", streaming: false }),
    ]);
    await backend.dispose();
  });

  it("keeps tool calls between separate assistant blocks with the same content index", async () => {
    const fake = fakePiSession([]);
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-waterfall-order-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    const beforeTool = { role: "assistant", content: [{ type: "text", text: "先检查目录。" }] };
    const afterTool = { role: "assistant", content: [{ type: "text", text: "目录检查完成。" }] };
    await backend.start(recorder.events);

    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    for (const partial of [beforeTool, afterTool]) {
      if (partial === afterTool) {
        fake.emit({
          type: "tool_execution_start",
          toolCallId: "waterfall-ls",
          toolName: "ls",
          args: { path: "src" },
        } as AgentSessionEvent);
        fake.emit({
          type: "tool_execution_end",
          toolCallId: "waterfall-ls",
          toolName: "ls",
          result: { content: [{ type: "text", text: "app\nui" }] },
          isError: false,
        } as unknown as AgentSessionEvent);
      }
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
      } as AgentSessionEvent);
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partial.content[0]?.text, partial },
      } as AgentSessionEvent);
      fake.emit({ type: "message_end", message: partial } as AgentSessionEvent);
    }

    expect(recorder.messages.map((message) => message.kind)).toEqual(["text", "tool", "text"]);
    expect(recorder.messages.map((message) => message.id)).toEqual([
      expect.stringContaining("pi-text-"),
      expect.stringContaining("pi-tool-"),
      expect.stringContaining("pi-text-"),
    ]);
    expect(new Set(recorder.messages.map((message) => message.id)).size).toBe(3);
    expect(recorder.messages[0]).toMatchObject({ kind: "text", text: "先检查目录。", streaming: false });
    expect(recorder.messages[1]).toMatchObject({
      kind: "tool",
      name: "ls",
      summary: "src",
      status: "success",
    });
    expect(recorder.messages[2]).toMatchObject({ kind: "text", text: "目录检查完成。", streaming: false });
    await backend.dispose();
  });

  it("fails closed for a missing default model and disposes the unusable runtime", async () => {
    const fake = fakePiSession([], { configured: false });
    const recorder = eventRecorder();
    const reset = vi.fn();
    recorder.events.onSessionReset = reset;
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-setup-error-")),
      sessionFactory: async () => ({ session: fake.session }),
    });

    await expect(backend.start(recorder.events)).rejects.toThrow(/没有可用模型.*Provider.*不会自动进入 Fixture/);
    expect(reset).not.toHaveBeenCalled();
    expect(fake.session.dispose).toHaveBeenCalledOnce();
  });

  it("automatically persists the upstream fallback and exposes one resolved marker", async () => {
    const fake = fakePiSession([], { configured: true });
    const recorder = eventRecorder();
    const reset = vi.fn();
    recorder.events.onSessionReset = reset;
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-model-fallback-open-")),
      sessionFactory: async () => ({
        session: fake.session,
        modelFallbackMessage: "Could not restore model deepseek/deepseek-v4-flash",
      }),
    });

    await backend.start(recorder.events);

    expect(reset).toHaveBeenCalledOnce();
    expect(fake.session.dispose).not.toHaveBeenCalled();
    expect(fake.session.setModel).toHaveBeenCalledOnce();
    expect(fake.session.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", id: "m2-model" }),
    );
    expect(backend.consumeResolvedModelFallback()).toBe(false);
    expect(backend.consumeResolvedModelFallback()).toBe(false);
    expect(recorder.events.onNotice).toHaveBeenCalledWith(
      "模型 原会话模型 不可用，已自动改用 anthropic/m2-model",
      "warning",
    );
    await backend.dispose();
  });

  it("prefers the first available model from the session's previous provider", async () => {
    const sameProvider = {
      id: "deepseek-current",
      name: "DeepSeek Current",
      provider: "deepseek",
      input: ["text"],
    };
    const fake = fakePiSession([], {
      configured: true,
      savedModel: { provider: "deepseek", modelId: "deepseek-removed" },
      availableByProvider: { deepseek: [sameProvider] },
    });
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-model-fallback-provider-")),
      sessionFactory: async () => ({
        session: fake.session,
        modelFallbackMessage: "Could not restore model deepseek/deepseek-v4-flash",
      }),
    });
    await backend.start(recorder.events);

    expect(fake.session.setModel).toHaveBeenCalledOnce();
    expect(fake.session.setModel).toHaveBeenCalledWith(sameProvider);
    expect(backend.consumeResolvedModelFallback()).toBe(true);
    expect(recorder.events.onNotice).toHaveBeenCalledWith(
      "模型 deepseek/deepseek-removed 不可用，已自动改用 deepseek/deepseek-current",
      "warning",
    );
    await backend.dispose();
  });

  it("keeps the upstream fallback when the previous provider was removed", async () => {
    const fake = fakePiSession([], {
      configured: true,
      savedModel: { provider: "removed-provider", modelId: "removed-model" },
    });
    (fake.session.modelRuntime as unknown as { getAvailable: ReturnType<typeof vi.fn> }).getAvailable.mockRejectedValue(
      new Error("Unknown provider"),
    );
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-model-fallback-removed-provider-")),
      sessionFactory: async () => ({
        session: fake.session,
        modelFallbackMessage: "Could not restore model removed-provider/removed-model",
      }),
    });

    await backend.start(recorder.events);

    expect(fake.session.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", id: "m2-model" }),
    );
    await backend.dispose();
  });

  it("fails closed when persisting the automatic fallback fails", async () => {
    const fake = fakePiSession([], { configured: true, setModelError: new Error("append failed") });
    const recorder = eventRecorder();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-model-fallback-persist-error-")),
      sessionFactory: async () => ({
        session: fake.session,
        modelFallbackMessage: "Could not restore model deepseek/deepseek-v4-flash",
      }),
    });
    await expect(backend.start(recorder.events)).rejects.toThrow("append failed");
    expect(fake.session.dispose).toHaveBeenCalledOnce();
  });

  it("fails a broken replacement without publishing a false reset or accepting another prompt", async () => {
    const first = fakePiSession([]);
    const recorder = eventRecorder();
    const reset = vi.fn();
    recorder.events.onSessionReset = reset;
    const list = vi.spyOn(SessionManager, "list").mockResolvedValue([
      {
        id: "broken-target",
        path: "/tmp/broken-target.jsonl",
        cwd: "/workspace",
        created: new Date(),
        modified: new Date(),
        messageCount: 1,
        firstMessage: "broken",
        allMessagesText: "broken",
      },
    ]);
    vi.spyOn(SessionManager, "open").mockReturnValue({} as SessionManager);
    const primaryError = new Error("replacement factory failure sentinel");
    let calls = 0;
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-replacement-failure-")),
      sessionFactory: async () => {
        if (calls++ === 0) return { session: first.session };
        throw primaryError;
      },
    });
    await backend.start(recorder.events);
    expect(reset).toHaveBeenCalledTimes(1);

    await expect(backend.switchSession("broken-target")).rejects.toBe(primaryError);
    expect(reset).toHaveBeenCalledTimes(1);
    await expect(
      backend.send("must not reach disposed session", { attachments: [], effort: "medium", behavior: "prompt" }),
    ).rejects.toThrow(/session 尚未启动/);
    expect(first.session.prompt).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
  });

  it("preserves the primary replacement error and never disposes the invalidated session twice", async () => {
    const first = fakePiSession([]);
    let disposeCalls = 0;
    vi.spyOn(first.session, "dispose").mockImplementation(() => {
      disposeCalls += 1;
      if (disposeCalls > 1) throw new Error("secondary duplicate dispose sentinel");
    });
    const primaryError = new Error("primary replacement failure sentinel");
    vi.spyOn(SessionManager, "list").mockResolvedValue([
      {
        id: "double-dispose-target",
        path: "/tmp/double-dispose-target.jsonl",
        cwd: "/workspace",
        created: new Date(),
        modified: new Date(),
        messageCount: 1,
        firstMessage: "target",
        allMessagesText: "target",
      },
    ]);
    vi.spyOn(SessionManager, "open").mockReturnValue({} as SessionManager);
    let calls = 0;
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-double-dispose-")),
      sessionFactory: async () => {
        if (calls++ === 0) return { session: first.session };
        throw primaryError;
      },
    });
    await backend.start(eventRecorder().events);

    await expect(backend.switchSession("double-dispose-target")).rejects.toBe(primaryError);
    expect(disposeCalls).toBe(1);
    await expect(
      backend.send("runtime must remain failed closed", { attachments: [], effort: "medium", behavior: "prompt" }),
    ).rejects.toThrow(/session 尚未启动/);
  });

  it("always publishes idle after abort rejects", async () => {
    const fake = fakePiSession([]);
    const abortError = new Error("abort failure sentinel");
    vi.spyOn(fake.session, "abort").mockRejectedValue(abortError);
    const recorder = eventRecorder();
    const busy = vi.mocked(recorder.events.onBusy);
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-abort-reject-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start(recorder.events);
    fake.emit({ type: "agent_start" } as AgentSessionEvent);

    await expect(backend.cancel()).rejects.toBe(abortError);
    expect(busy).toHaveBeenLastCalledWith(false);
    await backend.dispose();
  });

  it("quarantines late retry, text, and tool events after a successful abort until the next send", async () => {
    let firstPrompt = true;
    let releaseFirstPrompt: (() => void) | undefined;
    const fake = fakePiSession([], {
      prompt: () => {
        if (!firstPrompt) return Promise.resolve();
        firstPrompt = false;
        return new Promise<void>((resolve) => {
          releaseFirstPrompt = resolve;
        });
      },
    });
    vi.spyOn(fake.session, "abort").mockImplementation(async () => {
      releaseFirstPrompt?.();
    });
    const recorder = eventRecorder();
    const busy = vi.mocked(recorder.events.onBusy);
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-abort-late-events-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start(recorder.events);

    const first = backend.send("cancel me", { attachments: [], effort: "high", behavior: "prompt" });
    await new Promise((resolve) => setImmediate(resolve));
    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    const activePartial = { role: "assistant", content: [{ type: "text", text: "PARTIAL_BEFORE_CANCEL" }] };
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: activePartial },
    } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "PARTIAL_BEFORE_CANCEL",
        partial: activePartial,
      },
    } as AgentSessionEvent);
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "active-tool",
      toolName: "bash",
      args: { command: "npm test" },
    } as AgentSessionEvent);
    await backend.cancel();
    await expect(first).resolves.toEqual({ status: "cancelled" });
    expect(recorder.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: "PARTIAL_BEFORE_CANCEL", streaming: false }),
        expect.objectContaining({ kind: "tool", name: "bash", status: "cancelled" }),
      ]),
    );
    const messagesAfterCancel = recorder.messages.length;

    const stalePartial = {
      role: "assistant",
      content: [{ type: "text", text: "LATE_CANCELLED_TEXT" }],
    };
    fake.emit({ type: "agent_end", willRetry: true } as unknown as AgentSessionEvent);
    fake.emit({ type: "agent_start", retry: true } as unknown as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: stalePartial },
    } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "LATE_CANCELLED_TEXT",
        partial: stalePartial,
      },
    } as AgentSessionEvent);
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "late-tool",
      toolName: "bash",
      args: { command: "touch LATE_CANCELLED_TOOL" },
    } as AgentSessionEvent);
    expect(recorder.messages).toHaveLength(messagesAfterCancel);
    expect(busy).toHaveBeenLastCalledWith(false);

    await backend.send("next turn", { attachments: [], effort: "high", behavior: "prompt" });
    const nextPartial = { role: "assistant", content: [{ type: "text", text: "NEXT_TURN_OK" }] };
    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: nextPartial },
    } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "NEXT_TURN_OK", partial: nextPartial },
    } as AgentSessionEvent);
    expect(recorder.messages).toHaveLength(messagesAfterCancel + 1);
    await backend.dispose();
  });

  it("quarantines retry events after abort rejection until a new Session binding succeeds", async () => {
    const first = fakePiSession([]);
    const second = fakePiSession([], { sessionId: "replacement-after-abort" });
    const abortError = new Error("abort retry isolation sentinel");
    vi.spyOn(first.session, "abort").mockRejectedValue(abortError);
    let factoryCalls = 0;
    const recorder = eventRecorder();
    const busy = vi.mocked(recorder.events.onBusy);
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-abort-retry-isolation-")),
      sessionFactory: async () => ({ session: factoryCalls++ === 0 ? first.session : second.session }),
    });
    await backend.start(recorder.events);
    first.emit({ type: "agent_start" } as AgentSessionEvent);
    expect(busy).toHaveBeenLastCalledWith(true);
    await expect(backend.cancel()).rejects.toBe(abortError);
    expect(busy).toHaveBeenLastCalledWith(false);
    const callsAfterCancel = busy.mock.calls.length;
    const transcriptAfterCancel = recorder.messages.length;

    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "RETRY_DELTA_MUST_BE_QUARANTINED" }],
    };
    first.emit({ type: "agent_end", willRetry: true, retryDelayMs: 1 } as unknown as AgentSessionEvent);
    first.emit({ type: "agent_start", retry: true } as unknown as AgentSessionEvent);
    first.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
    } as AgentSessionEvent);
    first.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "RETRY_DELTA_MUST_BE_QUARANTINED",
        partial,
      },
    } as AgentSessionEvent);
    first.emit({
      type: "tool_execution_start",
      toolCallId: "retry-tool-must-be-quarantined",
      toolName: "read",
      args: {},
    } as AgentSessionEvent);

    expect.soft(busy.mock.calls.slice(callsAfterCancel).some(([value]) => value === true)).toBe(false);
    expect.soft(busy).toHaveBeenLastCalledWith(false);
    expect.soft(recorder.messages).toHaveLength(transcriptAfterCancel);

    await backend.newSession({ defaults: false, continuePlan: false });
    second.emit({ type: "agent_start" } as AgentSessionEvent);
    expect(busy).toHaveBeenLastCalledWith(true);
    await backend.dispose();
  });

  it("forks a completed current branch at a valid native position and hydrates the new session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m2-native-fork-"));
    const cwd = join(root, "project");
    const sessionDir = join(root, "sessions");
    const source = SessionManager.create(cwd, sessionDir);
    const userId = source.appendMessage({ role: "user", content: "FORK_USER_SENTINEL", timestamp: 1 });
    const assistantId = source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "FORK_ASSISTANT_SENTINEL" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m2-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const sourcePath = source.getSessionFile();
    if (!sourcePath) throw new Error("fork source was not persisted");
    expect(source.getLeafId()).toBe(assistantId);

    const initial = fakePiSession([]);
    const recorder = eventRecorder();
    const resets: Array<{ id: string; reason: string }> = [];
    recorder.events.onSessionReset = (reset) => resets.push(reset);
    const backend = new PiBackend({
      cwd,
      sessionFactory: async () => ({ session: initial.session }),
    });
    await backend.start(recorder.events);

    let active = initial.session;
    const fork = vi.fn(
      async (entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean }> => {
        const validCloneAtLeaf = entryId === assistantId && options?.position === "at";
        const validForkBeforeUser =
          entryId === userId && (options?.position === undefined || options.position === "before");
        if (!validCloneAtLeaf && !validForkBeforeUser) throw new Error("Invalid entry ID for forking");
        const forkManager = SessionManager.open(sourcePath, sessionDir);
        const branchPath = forkManager.createBranchedSession(validCloneAtLeaf ? assistantId : userId);
        if (!branchPath) throw new Error("native fork did not create a session file");
        const branch = SessionManager.open(branchPath, sessionDir);
        active = fakePiSession(branch.buildSessionContext().messages, { sessionId: branch.getSessionId() }).session;
        return { cancelled: false };
      },
    );
    const runtime = {
      get session() {
        return active;
      },
      modelFallbackMessage: undefined,
      newSession: vi.fn(async () => ({ cancelled: false })),
      switchSession: vi.fn(async () => {
        active = fakePiSession(source.buildSessionContext().messages, { sessionId: source.getSessionId() }).session;
        return { cancelled: false };
      }),
      fork,
      dispose: vi.fn(async () => {}),
    };
    (backend as unknown as { runtime: typeof runtime }).runtime = runtime;
    vi.spyOn(SessionManager, "list").mockResolvedValue([
      {
        id: "source-session",
        path: sourcePath,
        cwd,
        created: new Date(),
        modified: new Date(),
        messageCount: 2,
        firstMessage: "FORK_USER_SENTINEL",
        allMessagesText: "FORK_USER_SENTINEL FORK_ASSISTANT_SENTINEL",
      },
    ]);

    await expect(backend.forkSession("source-session")).resolves.toBeUndefined();
    expect(fork).toHaveBeenCalledOnce();
    const [entryId, options] = fork.mock.calls[0] ?? [];
    expect(
      (entryId === assistantId && options?.position === "at") ||
        (entryId === userId && (options?.position === undefined || options.position === "before")),
    ).toBe(true);
    expect(resets.at(-1)).toMatchObject({ reason: "fork" });
    expect(resets.at(-1)?.id).not.toBe(source.getSessionId());
    expect(recorder.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", kind: "text", text: "FORK_USER_SENTINEL" }),
        expect.objectContaining({ role: "assistant", kind: "text", text: "FORK_ASSISTANT_SENTINEL" }),
      ]),
    );
    await backend.dispose();
  });

  it("restores the same persisted session identity and history after backend restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m2-restart-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m2-restart-project-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
    const manager = SessionManager.create(cwd);
    manager.appendMessage({ role: "user", content: "RESTART_HISTORY_SENTINEL", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "RESTART_ASSISTANT_SENTINEL" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m2-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const expectedId = manager.getSessionId();

    const starts: Array<{ id: string; messages: TranscriptMessage[] }> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recorder = eventRecorder();
      const resetIds: string[] = [];
      recorder.events.onSessionReset = ({ id }) => resetIds.push(id);
      const backend = new PiBackend({
        cwd,
        continueRecent: true,
        sessionFactory: async (restored) => ({
          session: fakePiSession(restored.buildSessionContext().messages, {
            sessionId: restored.getSessionId(),
          }).session,
        }),
      });
      await backend.start(recorder.events);
      starts.push({ id: resetIds[0] ?? "", messages: [...recorder.messages] });
      await backend.dispose();
    }

    expect(starts.map((start) => start.id)).toEqual([expectedId, expectedId]);
    for (const start of starts) {
      expect(start.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", kind: "text", text: "RESTART_HISTORY_SENTINEL" }),
          expect.objectContaining({ role: "assistant", kind: "text", text: "RESTART_ASSISTANT_SENTINEL" }),
        ]),
      );
    }
  });
});
