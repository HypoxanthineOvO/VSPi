import { mkdtemp } from "node:fs/promises";
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
  options: { sessionId?: string; configured?: boolean; prompt?: () => Promise<void> } = {},
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
    isStreaming: false,
    subscribe(callback: (event: AgentSessionEvent) => void) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    setThinkingLevel: vi.fn(),
    prompt: vi.fn(async (_text: string, _options?: PromptOptions) => options.prompt?.()),
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
        expect.objectContaining({ role: "assistant", kind: "thinking", text: "RESTORED_THINKING_SENTINEL" }),
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

  it.each([
    ["fallback", true],
    ["missing", false],
  ] as const)("fails closed for a %s default model and disposes the unusable runtime", async (_case, fallback) => {
    const fake = fakePiSession([], { configured: fallback });
    const recorder = eventRecorder();
    const reset = vi.fn();
    recorder.events.onSessionReset = reset;
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-m2-setup-error-")),
      sessionFactory: async () => ({
        session: fake.session,
        ...(fallback ? { modelFallbackMessage: "saved default no longer exists" } : {}),
      }),
    });

    await expect(backend.start(recorder.events)).rejects.toThrow(
      fallback ? /默认模型不可用.*Provider.*默认模型配置/ : /没有可用模型.*Provider.*不会自动进入 Fixture/,
    );
    expect(reset).not.toHaveBeenCalled();
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
      backend.send("must not reach disposed session", { attachments: [], effort: "中", behavior: "prompt" }),
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
      backend.send("runtime must remain failed closed", { attachments: [], effort: "中", behavior: "prompt" }),
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
