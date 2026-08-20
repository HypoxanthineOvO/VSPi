import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ContextUsage,
  type PromptOptions,
  SessionManager,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../src/backend/types.js";
import type { Attachment, EffortLevel, TranscriptMessage, UsageSnapshot } from "../src/domain/types.js";
import { PNG_1X1 } from "./helpers.js";

interface FakeSessionOptions {
  contextWindow?: number;
  contextUsage?: () => ContextUsage | undefined;
  sessionStats?: () => SessionStats;
  compact?: () => Promise<unknown>;
  thinkingLevels?: EffortLevel[];
  messages?: unknown[];
}

function sessionStats(input = 0, output = 0, cost = 0, cacheRead = 0, cacheWrite = 0): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "session-id",
    userMessages: 0,
    assistantMessages: input + output > 0 ? 1 : 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: input + output > 0 ? 1 : 0,
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    cost,
  };
}

function fakeSession(provider = "test", name = "Vision Model", options: FakeSessionOptions = {}) {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => {});
  const session = {
    model: {
      id: "vision-model",
      name,
      provider,
      input: ["text", "image"],
      contextWindow: options.contextWindow ?? 100_000,
    },
    messages: options.messages ?? [],
    sessionId: "session-id",
    thinkingLevel: "medium",
    isStreaming: false,
    subscribe(callback: (event: AgentSessionEvent) => void) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    setThinkingLevel: vi.fn(),
    getAvailableThinkingLevels: vi.fn(() => options.thinkingLevels ?? ["off", "low", "medium", "high"]),
    prompt,
    abort: vi.fn(async () => {}),
    compact: vi.fn(options.compact ?? (async () => ({}))),
    bindExtensions: vi.fn(async () => {}),
    getContextUsage: vi.fn(options.contextUsage ?? (() => ({ tokens: 0, contextWindow: 100_000, percent: 0 }))),
    getSessionStats: vi.fn(options.sessionStats ?? (() => sessionStats())),
    dispose: vi.fn(),
  } as unknown as AgentSession;
  return { session, prompt, emit: (event: AgentSessionEvent) => listener?.(event) };
}

describe("pi backend adapter", () => {
  it("projects configured OpenCode Go catalog models into the picker", async () => {
    const fake = fakeSession("opencode-go", "OpenCode Go Model");
    const models = [
      {
        id: "future-catalog-model",
        name: "Future Catalog Model",
        provider: "opencode-go",
        input: ["text"],
        contextWindow: 128_000,
      },
    ];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-opencode-go-")),
      sessionFactory: async () => ({ session: fake.session }),
      modelRuntime: {
        getAvailable: vi.fn(async () => models),
        getProviders: () => [{ id: "opencode-go", name: "OpenCode Go", getModels: () => models }],
        listCredentials: vi.fn(async () => [{ providerId: "opencode-go", type: "api_key" as const }]),
      },
    } as never);

    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });
    expect(fake.session.bindExtensions).toHaveBeenCalledWith(expect.objectContaining({ mode: "tui" }));

    await expect(backend.getModelOptions()).resolves.toEqual([
      expect.objectContaining({ id: "future-catalog-model", provider: "opencode-go" }),
    ]);
    await backend.dispose();
  });

  it("coalesces concurrent availability reads and refreshes after auth mutations", async () => {
    const fake = fakeSession("openai", "Catalog Model");
    const models = [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        input: ["text"],
        contextWindow: 128_000,
      },
    ];
    let resolveFirst!: (value: typeof models) => void;
    const firstAvailability = new Promise<typeof models>((resolve) => {
      resolveFirst = resolve;
    });
    let availabilityCalls = 0;
    const getAvailable = vi.fn((providerId?: string) => {
      if (providerId) return Promise.resolve(models);
      availabilityCalls += 1;
      return availabilityCalls === 1 ? firstAvailability : Promise.resolve(models);
    });
    const runtime = {
      getAvailable,
      getProviders: () => [
        {
          id: "openai",
          name: "OpenAI",
          getModels: () => models,
        },
      ],
      listCredentials: vi.fn(async () => []),
      login: vi.fn(async () => ({ type: "api_key" as const })),
      logout: vi.fn(async () => {}),
    };
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-catalog-coalesce-")),
      sessionFactory: async () => ({ session: fake.session }),
      modelRuntime: runtime,
    } as never);

    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    const modelOptions = backend.getModelOptions();
    const providerOptions = backend.getProviderOptions();
    expect(getAvailable).toHaveBeenCalledOnce();
    resolveFirst(models);
    await Promise.all([modelOptions, providerOptions]);
    expect(getAvailable).toHaveBeenCalledOnce();

    await backend.loginProvider("openai", "api_key", {
      prompt: vi.fn(async () => "key"),
      notify: vi.fn(),
    });
    expect(getAvailable).toHaveBeenCalledTimes(2);
    expect(getAvailable).toHaveBeenLastCalledWith("openai");
    await backend.logoutProvider("openai");
    expect(getAvailable).toHaveBeenCalledTimes(3);
    expect(getAvailable).toHaveBeenLastCalledWith("openai");

    const callsAfterAuth = getAvailable.mock.calls.length;
    await Promise.all([backend.getModelOptions(), backend.getProviderOptions()]);
    expect(getAvailable).toHaveBeenCalledTimes(callsAfterAuth + 1);
    expect(getAvailable).toHaveBeenLastCalledWith();
    await backend.dispose();
  });

  it("performs one network catalog refresh and reuses its availability snapshot", async () => {
    const fake = fakeSession("openai", "Catalog Model");
    const models = [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        input: ["text"],
        contextWindow: 128_000,
      },
    ];
    const getAvailable = vi.fn(async () => models);
    const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
    const runtime = {
      getAvailable,
      getAvailableSnapshot: vi.fn(() => models),
      refresh,
      getProviders: () => [{ id: "openai", name: "OpenAI", getModels: () => models }],
      listCredentials: vi.fn(async () => []),
    };
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-catalog-network-")),
      sessionFactory: async () => ({ session: fake.session }),
      modelRuntime: runtime,
    } as never);

    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: true, force: true, signal: expect.any(AbortSignal) });
    await expect(backend.getModelOptions()).resolves.toEqual([
      expect.objectContaining({ id: "gpt-5.4", provider: "openai" }),
    ]);
    await backend.getProviderOptions();
    expect(getAvailable).not.toHaveBeenCalled();
    await backend.dispose();
  });

  it("falls back to a local catalog refresh when remote refresh fails or times out", async () => {
    const makeBackend = async (mode: "failure" | "timeout") => {
      const fake = fakeSession("openai", "Catalog Model");
      const models = [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai",
          input: ["text"],
          contextWindow: 128_000,
        },
      ];
      let localReady = false;
      const getAvailableSnapshot = vi.fn(() => (localReady ? models : []));
      const refresh = vi.fn(({ allowNetwork, signal }: { allowNetwork?: boolean; signal?: AbortSignal }) => {
        if (allowNetwork) {
          if (mode === "failure") return Promise.reject(new Error("catalog unavailable"));
          return new Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        localReady = true;
        return Promise.resolve({ aborted: false, errors: new Map() });
      });
      const runtime = {
        getAvailable: vi.fn(async () => models),
        getAvailableSnapshot,
        refresh,
        getProviders: () => [{ id: "openai", name: "OpenAI", getModels: () => models }],
        listCredentials: vi.fn(async () => []),
      };
      const backend = new PiBackend({
        cwd: await mkdtemp(join(tmpdir(), `vspi-pi-catalog-${mode}-`)),
        sessionFactory: async () => ({ session: fake.session }),
        modelRuntime: runtime,
        modelCatalogRefreshTimeoutMs: 10,
      } as never);
      return { backend, refresh };
    };

    for (const mode of ["failure", "timeout"] as const) {
      const { backend, refresh } = await makeBackend(mode);
      await expect(
        backend.start({
          onMessage: vi.fn(),
          onMessageUpdate: vi.fn(),
          onBusy: vi.fn(),
          onUsage: vi.fn(),
          onNotice: vi.fn(),
        }),
      ).resolves.toBeUndefined();
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh.mock.calls[0]?.[0]).toMatchObject({ allowNetwork: true });
      expect(refresh.mock.calls[1]?.[0]).toMatchObject({ allowNetwork: false });
      await expect(backend.getModelOptions()).resolves.toEqual([
        expect.objectContaining({ id: "gpt-5.4", provider: "openai" }),
      ]);
      await backend.dispose();
    }
  });

  it("projects Pi authentication methods and delegates login/logout without handling secrets", async () => {
    const fake = fakeSession("kimi-coding", "Kimi K3");
    const models = [
      {
        id: "k3",
        name: "Kimi K3",
        provider: "kimi-coding",
        input: ["text"],
        contextWindow: 262_144,
      },
    ];
    const login = vi.fn(async () => ({ type: "oauth" }));
    const logout = vi.fn(async () => {});
    const modelRuntime = {
      getAvailable: vi.fn(async () => models),
      getProviders: () => [
        {
          id: "kimi-coding",
          name: "Kimi For Coding",
          auth: {
            oauth: { name: "Kimi Code (subscription)", loginLabel: "Sign in with Kimi Code" },
            apiKey: { name: "Kimi API key", login: () => undefined },
          },
          getModels: () => models,
        },
      ],
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      listCredentials: vi.fn(async () => [{ providerId: "kimi-coding", type: "oauth" as const }]),
      login,
      logout,
    };
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-auth-")),
      sessionFactory: async () => ({ session: fake.session }),
      modelRuntime,
    } as never);
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    await expect(backend.getProviderOptions()).resolves.toEqual([
      expect.objectContaining({
        id: "kimi-coding",
        storedCredential: "oauth",
        authMethods: [
          { type: "oauth", label: "Sign in with Kimi Code" },
          { type: "api_key", label: "Kimi API key" },
        ],
      }),
    ]);
    const interaction = { prompt: vi.fn(async (_prompt: unknown) => "answer"), notify: vi.fn((_event: unknown) => {}) };
    await backend.loginProvider("kimi-coding", "oauth", interaction as never);
    expect(login).toHaveBeenCalledWith(
      "kimi-coding",
      "oauth",
      expect.objectContaining({ prompt: expect.any(Function), notify: expect.any(Function) }),
    );
    const forwarded = (login.mock.calls as unknown as Array<[string, string, typeof interaction]>)[0]?.[2];
    expect(forwarded).toBeDefined();
    if (!forwarded) throw new Error("login interaction was not forwarded");
    const prompt = { type: "text", message: "Code" } as never;
    await expect(forwarded.prompt(prompt)).resolves.toBe("answer");
    expect(interaction.prompt).toHaveBeenCalledWith(prompt);
    const event = { type: "progress", message: "Waiting" } as const;
    forwarded.notify(event);
    expect(interaction.notify).toHaveBeenCalledWith(event);
    await backend.logoutProvider("kimi-coding");
    expect(logout).toHaveBeenCalledWith("kimi-coding");
    await backend.dispose();
  });

  it("uses the current model's native thinking levels for Effort", async () => {
    const fake = fakeSession("openai", "Extended Reasoning", {
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-effort-levels-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    await expect(backend.getEffortOptions()).resolves.toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    await backend.setEffort("max");
    expect(fake.session.setThinkingLevel).toHaveBeenCalledWith("max");
    await backend.dispose();
  });

  it("publishes current context from getContextUsage independently of cumulative session stats", async () => {
    let cumulative = sessionStats(90_000, 12_000, 3.25);
    const fake = fakeSession("openai", "Context Model", {
      contextUsage: () => ({ tokens: 50_176, contextWindow: 128_000, percent: 99 }),
      sessionStats: () => cumulative,
    });
    const usage: UsageSnapshot[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-context-")),
      sessionFactory: async () => ({ session: fake.session }),
    });

    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: (snapshot) => usage.push(snapshot),
      onNotice: vi.fn(),
    });
    expect(usage.at(-1)).toMatchObject({
      contextTokens: 50_176,
      contextWindow: 128_000,
      contextPercent: 39,
      inputTokens: 90_000,
      outputTokens: 12_000,
      costUsd: 3.25,
    });

    cumulative = sessionStats(190_000, 32_000, 8.5);
    fake.emit({ type: "agent_end" } as AgentSessionEvent);
    expect(usage.at(-1)).toMatchObject({
      contextTokens: 50_176,
      contextWindow: 128_000,
      contextPercent: 39,
      inputTokens: 190_000,
      outputTokens: 32_000,
      costUsd: 8.5,
    });
    expect(fake.session.getContextUsage).toHaveBeenCalled();
    expect(fake.session.getSessionStats).toHaveBeenCalled();
    await backend.dispose();
  });

  it("distinguishes unreported cache metrics from a reported zero-hit request", async () => {
    const usage = (input: number, cacheRead: number, cacheWrite: number, inputCost: number, readCost: number) => ({
      input,
      output: 100,
      cacheRead,
      cacheWrite,
      totalTokens: input + cacheRead + cacheWrite + 100,
      cost: {
        input: inputCost,
        output: 0.001,
        cacheRead: readCost,
        cacheWrite: 0,
        total: inputCost + readCost + 0.001,
      },
    });
    const messages = [
      {
        role: "assistant",
        provider: "test",
        model: "vision-model",
        content: [{ type: "text", text: "one" }],
        usage: usage(1_000, 8_000, 1_000, 0.001, 0.0016),
        stopReason: "stop",
        timestamp: 1,
      },
      {
        role: "assistant",
        provider: "test",
        model: "vision-model",
        content: [{ type: "text", text: "two" }],
        usage: usage(9_000, 0, 0, 0.009, 0),
        stopReason: "stop",
        timestamp: 2,
      },
    ];
    const fake = fakeSession("test", "Cache Model", {
      messages,
      sessionStats: () => sessionStats(10_000, 200, 0.0126, 8_000, 1_000),
    });
    const snapshots: UsageSnapshot[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-cache-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: (snapshot) => snapshots.push(snapshot),
      onNotice: vi.fn(),
    });

    expect(snapshots.at(-1)).toMatchObject({
      cacheReadTokens: 8_000,
      cacheWriteTokens: 1_000,
      recentCacheHitPercent: 0,
      sessionCacheHitPercent: 42,
      cacheMissTokens: 9_000,
    });
    expect(snapshots.at(-1)?.cacheMissCostUsd).toBeNull();

    messages.push({
      role: "assistant",
      provider: "uncached-provider",
      model: "other-model",
      content: [{ type: "text", text: "three" }],
      usage: usage(9_000, 0, 0, 0.009, 0),
      stopReason: "stop",
      timestamp: 3,
    });
    fake.emit({ type: "agent_end" } as AgentSessionEvent);
    expect(snapshots.at(-1)).toMatchObject({ recentCacheHitPercent: null, sessionCacheHitPercent: 42 });
    await backend.dispose();
  });

  it("publishes unknown current context after compaction without zeroing cumulative usage", async () => {
    let context: ContextUsage = { tokens: 50_176, contextWindow: 128_000, percent: 39.2 };
    const fake = fakeSession("openai", "Compaction Model", {
      contextUsage: () => context,
      sessionStats: () => sessionStats(250_000, 40_000, 9.75),
      compact: async () => {
        context = { tokens: null, contextWindow: 128_000, percent: null };
      },
    });
    const usage: UsageSnapshot[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-compact-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: (snapshot) => usage.push(snapshot),
      onNotice: vi.fn(),
    });

    await backend.compact();

    expect(usage.at(-1)).toMatchObject({
      contextTokens: null,
      contextWindow: 128_000,
      contextPercent: null,
      inputTokens: 250_000,
      outputTokens: 40_000,
      costUsd: 9.75,
    });
    await backend.dispose();
  });

  it("uses explicit zero context for an empty session without a configured context window", async () => {
    const fake = fakeSession("test", "Empty Model", {
      contextWindow: 0,
      contextUsage: () => undefined,
      sessionStats: () => sessionStats(),
    });
    const usage: UsageSnapshot[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-empty-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: (snapshot) => usage.push(snapshot),
      onNotice: vi.fn(),
    });

    expect(usage.at(-1)).toMatchObject({ contextTokens: 0, contextWindow: 0, contextPercent: 0 });
    await backend.dispose();
  });

  it("clears a compaction estimate before publishing a newly selected model window", async () => {
    let contextWindow = 128_000;
    const fake = fakeSession("deepseek", "Old Model", {
      contextUsage: () => ({ tokens: null, contextWindow, percent: null }),
    });
    const selected = {
      id: "new-model",
      name: "New Model",
      provider: "openai",
      input: ["text"],
      contextWindow: 272_000,
    };
    Object.assign(fake.session, {
      setModel: vi.fn(async (model: typeof selected) => {
        contextWindow = model.contextWindow;
        Object.assign(fake.session, { model });
      }),
    });
    const snapshots: UsageSnapshot[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-model-context-")),
      sessionFactory: async () => ({ session: fake.session }),
      modelRuntime: { getAvailable: vi.fn(async () => [selected]) },
    } as never);
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: (snapshot) => snapshots.push(snapshot),
      onNotice: vi.fn(),
    });
    fake.emit({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: { estimatedTokensAfter: 12_000 },
    } as AgentSessionEvent);
    expect(snapshots.at(-1)).toMatchObject({ contextTokens: 12_000, contextEstimated: true });

    await backend.selectModel("openai", "new-model");
    expect(snapshots.at(-1)).toMatchObject({
      contextTokens: null,
      contextWindow: 272_000,
      contextEstimated: false,
    });
    await backend.dispose();
  });

  it("publishes the newly selected session context and cumulative totals after switching", async () => {
    const first = fakeSession("openai", "First", {
      contextUsage: () => ({ tokens: 8_000, contextWindow: 128_000, percent: 6.25 }),
      sessionStats: () => sessionStats(10_000, 2_000, 0.5),
    });
    const second = fakeSession("deepseek", "Second", {
      contextUsage: () => ({ tokens: 50_176, contextWindow: 128_000, percent: 39.2 }),
      sessionStats: () => sessionStats(300_000, 60_000, 11.5),
    });
    const list = vi.spyOn(SessionManager, "list").mockResolvedValue([
      {
        id: "second-session",
        path: "/tmp/second-session.jsonl",
        cwd: "/workspace",
        name: "Second",
        firstMessage: "second",
        created: new Date(),
        modified: new Date(),
        messageCount: 1,
        allMessagesText: "second",
      },
    ]);
    const open = vi.spyOn(SessionManager, "open").mockReturnValue({} as SessionManager);
    let factoryCalls = 0;
    const usage: UsageSnapshot[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-switch-")),
      sessionFactory: async () => ({ session: factoryCalls++ === 0 ? first.session : second.session }),
    });

    try {
      await backend.start({
        onMessage: vi.fn(),
        onMessageUpdate: vi.fn(),
        onBusy: vi.fn(),
        onUsage: (snapshot) => usage.push(snapshot),
        onNotice: vi.fn(),
      });
      await backend.switchSession("second-session");

      expect(usage.at(-1)).toMatchObject({
        contextTokens: 50_176,
        contextWindow: 128_000,
        contextPercent: 39,
        inputTokens: 300_000,
        outputTokens: 60_000,
        costUsd: 11.5,
      });
    } finally {
      await backend.dispose();
      list.mockRestore();
      open.mockRestore();
    }
  });

  it("normalizes the Provider display name without changing the model name", async () => {
    const fake = fakeSession("openai", "Vision Model Exact");
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-label-")),
      sessionFactory: async () => ({ session: fake.session }),
    });

    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    expect(backend.modelLabel).toBe("OpenAI / Vision Model Exact");
    await backend.dispose();
  });

  it("sends real image content with an alias manifest and maps text stream events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-pi-backend-"));
    const imagePath = join(cwd, "image.png");
    await writeFile(imagePath, PNG_1X1);
    const fake = fakeSession();
    const backend = new PiBackend({
      cwd,
      sessionFactory: async () => ({ session: fake.session }),
    });
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
    await backend.start(events);
    const attachment: Attachment = {
      id: "attachment-id",
      alias: "登录页",
      mimeType: "image/png",
      width: 1,
      height: 1,
      size: PNG_1X1.length,
      path: imagePath,
      status: "ready",
    };
    await backend.send("检查图片", { attachments: [attachment], effort: "high", behavior: "prompt" });
    const [promptText, promptOptions] = fake.prompt.mock.calls[0] ?? [];
    expect(promptText).toContain("<attachment-manifest>");
    expect(promptText).toContain("登录页");
    expect(promptOptions?.images).toHaveLength(1);
    expect(promptOptions?.images?.[0]).toMatchObject({ type: "image", mimeType: "image/png" });

    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "完成" }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    fake.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
    } as AgentSessionEvent);
    fake.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成", partial },
    } as AgentSessionEvent);
    expect(messages.at(-1)).toMatchObject({ kind: "text", text: "完成", streaming: true });

    fake.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
    fake.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "token=top-secret-value" }] },
      isError: false,
    });
    expect(messages.at(-1)).toMatchObject({ kind: "tool", output: "token=[REDACTED]" });
  });

  it("marks live thinking as streaming until thinking_end", async () => {
    const fake = fakeSession();
    const messages: TranscriptMessage[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-thinking-stream-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start({
      onMessage: (message) => messages.push(message),
      onMessageUpdate: (id, patch) => {
        const index = messages.findIndex((message) => message.id === id);
        const current = messages[index];
        if (current) messages[index] = { ...current, ...patch } as TranscriptMessage;
      },
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    const partial = { role: "assistant", content: [{ type: "thinking", thinking: "正在分析" }] };
    fake.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial },
    } as AgentSessionEvent);
    expect(messages.at(-1)).toMatchObject({ kind: "thinking", text: "", streaming: true });

    fake.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "正在分析", partial },
    } as AgentSessionEvent);
    expect(messages.at(-1)).toMatchObject({ kind: "thinking", text: "正在分析", streaming: true });

    fake.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "分析完成", partial },
    } as AgentSessionEvent);
    expect(messages.at(-1)).toMatchObject({ kind: "thinking", text: "分析完成", streaming: false });
    await backend.dispose();
  });

  it("classifies tool-use text as intermediate and ordinary stop text as formal", async () => {
    const fake = fakeSession();
    const messages: TranscriptMessage[] = [];
    const onNotice = vi.fn();
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-presentation-")),
      sessionFactory: async () => ({ session: fake.session }),
    });
    await backend.start({
      onMessage: (message) => messages.push(message),
      onMessageUpdate: (id, patch) => {
        const index = messages.findIndex((message) => message.id === id);
        const current = messages[index];
        if (current) messages[index] = { ...current, ...patch } as TranscriptMessage;
      },
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice,
    });
    const emitResponse = (
      text: string,
      stopReason: "toolUse" | "stop" | "error" | "aborted",
      errorMessage?: string,
    ) => {
      const message = {
        role: "assistant" as const,
        provider: "test",
        model: "vision-model",
        content: [{ type: "text" as const, text }],
        usage: {
          input: 10,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 14,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
        timestamp: Date.now(),
      };
      fake.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
      } as AgentSessionEvent);
      fake.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
      } as AgentSessionEvent);
      fake.emit({ type: "message_end", message } as AgentSessionEvent);
    };

    fake.emit({ type: "agent_start" } as AgentSessionEvent);
    emitResponse("checking", "toolUse");
    emitResponse("done", "stop");
    emitResponse("failed", "error", 'upstream error, data: {"code":"provider_failure"}');
    emitResponse("cancelled", "aborted", "user cancelled");
    expect(messages.filter((message) => message.kind === "text")).toMatchObject([
      { text: "checking", presentation: "intermediate", streaming: false },
      { text: "done", presentation: "formal", streaming: false },
      { text: "failed", presentation: undefined, streaming: false },
      { text: "cancelled", presentation: undefined, streaming: false },
    ]);
    expect(messages.find((message) => message.kind === "error")).toMatchObject({
      kind: "error",
      summary: "请求失败",
      detail: 'upstream error, data:\n{\n  "code": "provider_failure"\n}',
      model: "vision-model",
      expanded: false,
    });
    expect(onNotice).not.toHaveBeenCalled();
    await backend.dispose();
  });

  it("restores provider failures as collapsed waterfall errors", async () => {
    const fake = fakeSession("test", "Vision Model", {
      messages: [
        {
          role: "assistant",
          provider: "test",
          model: "vision-model",
          content: [],
          stopReason: "error",
          errorMessage: 'upstream error, data: {"code":"restored_failure"}',
          timestamp: Date.now(),
        },
      ],
    });
    const messages: TranscriptMessage[] = [];
    const backend = new PiBackend({
      cwd: await mkdtemp(join(tmpdir(), "vspi-pi-restored-error-")),
      sessionFactory: async () => ({ session: fake.session }),
    });

    await backend.start({
      onMessage: (message) => messages.push(message),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: "error",
        summary: "请求失败",
        detail: 'upstream error, data:\n{\n  "code": "restored_failure"\n}',
        model: "vision-model",
        expanded: false,
      }),
    );
    await backend.dispose();
  });

  it("rejects a symlink attachment instead of sending followed outside bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-pi-attachment-symlink-"));
    const outside = join(cwd, "outside-private.txt");
    const attachmentPath = join(cwd, "swapped.png");
    await writeFile(outside, "PRIVATE_PI_ATTACHMENT_BYTES");
    await symlink(outside, attachmentPath);
    const fake = fakeSession();
    const backend = new PiBackend({ cwd, sessionFactory: async () => ({ session: fake.session }) });
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });
    const attachment: Attachment = {
      id: "swapped-attachment",
      alias: "已替换图片",
      mimeType: "image/png",
      width: 1,
      height: 1,
      size: PNG_1X1.length,
      path: attachmentPath,
      status: "ready",
    };

    await expect(
      backend.send("不得读取外部文件", { attachments: [attachment], effort: "medium", behavior: "prompt" }),
    ).rejects.toThrow();
    expect(fake.prompt).not.toHaveBeenCalled();
    await backend.dispose();
  });
});
