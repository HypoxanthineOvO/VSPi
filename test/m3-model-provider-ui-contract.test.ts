import type { AgentSession, AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

function stats(): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "m3-session",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function fakeSession() {
  let model = {
    id: "old-model",
    name: "Old Model",
    provider: "openai",
    input: ["text"] as ("text" | "image")[],
    contextWindow: 32_000,
  };
  const setModel = vi.fn(async (next: typeof model) => {
    if (next.id === "broken-model") throw new Error("model switch failure sentinel");
    model = next;
  });
  const setThinkingLevel = vi.fn();
  const session = {
    get model() {
      return model;
    },
    messages: [],
    sessionId: "m3-session",
    thinkingLevel: "medium",
    isStreaming: false,
    subscribe: vi.fn((_listener: (event: AgentSessionEvent) => void) => () => {}),
    setModel,
    setThinkingLevel,
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    compact: vi.fn(async () => ({})),
    getContextUsage: vi.fn(() => ({ tokens: 1000, contextWindow: model.contextWindow, percent: 1 })),
    getSessionStats: vi.fn(stats),
    dispose: vi.fn(),
  } as unknown as AgentSession;
  return { session, setModel, setThinkingLevel };
}

describe("M3 real ModelRuntime and Pi Session mutation", () => {
  it("lists available runtime models, atomically selects one, and persists real effort", async () => {
    const fake = fakeSession();
    const models = [
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        provider: "anthropic",
        input: ["text", "image"],
        contextWindow: 200_000,
      },
      { id: "broken-model", name: "Broken Model", provider: "google", input: ["text"], contextWindow: 64_000 },
    ];
    const modelRuntime = { getAvailable: vi.fn(async () => models) };
    const backend = new PiBackend({
      cwd: "/tmp/m3-model-runtime",
      sessionFactory: async () => ({ session: fake.session }),
      modelRuntime,
    } as never) as PiBackend & {
      getModelOptions(): Promise<Array<{ id: string; provider: string }>>;
      selectModel(
        provider: string,
        id: string,
      ): Promise<{ modelId: string; vision: boolean; contextWindow: number; profileModelId: string }>;
      setEffort(level: "low" | "medium" | "high"): Promise<void>;
    };
    await backend.start({
      onMessage: vi.fn(),
      onMessageUpdate: vi.fn(),
      onBusy: vi.fn(),
      onUsage: vi.fn(),
      onNotice: vi.fn(),
    });

    expect(await backend.getModelOptions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "claude-sonnet-5" })]),
    );
    expect(await backend.selectModel("anthropic", "claude-sonnet-5")).toMatchObject({
      modelId: "claude-sonnet-5",
      vision: true,
      contextWindow: 200_000,
      profileModelId: "claude-sonnet-5",
    });
    expect(fake.setModel).toHaveBeenCalledOnce();
    await backend.setEffort("high");
    expect(fake.setThinkingLevel).toHaveBeenLastCalledWith("high");

    await expect(backend.selectModel("google", "broken-model")).rejects.toThrow("model switch failure sentinel");
    expect(backend.modelId).toBe("claude-sonnet-5");
    expect(backend.supportsVision).toBe(true);
    await backend.dispose();
  });
});

describe("M3 Provider and Model 80x24 interaction contract", () => {
  it("opens a Provider action menu on Enter and reserves Ctrl+S for editing save", () => {
    const panel = new PanelController(DEFAULT_SETTINGS) as PanelController & {
      setProviders(providers: unknown[]): void;
    };
    panel.setProviders([
      { id: "openai", label: "OpenAI", protocol: "Responses", status: "已配置", detail: "Global ⋅ stored" },
    ]);
    panel.open("providers");
    const action = panel.handleInput("\r") as { type?: string; actions?: string[] } | undefined;
    expect(action).toMatchObject({ type: "providerActions" });
    expect(action?.actions).toEqual(expect.arrayContaining(["check-config", "test-connection", "edit"]));

    const beforeSave = panel.handleInput("\r");
    expect(beforeSave?.type).not.toBe("notice");
    expect(panel.handleInput("\u0013")).toMatchObject({ type: "providerSave" });
  });

  it("renders injected runtime models with list left, details right, and price only for a single model", () => {
    const panel = new PanelController(DEFAULT_SETTINGS) as PanelController & {
      setModels(models: unknown[], groups: unknown[]): void;
    };
    panel.setModels(
      [
        {
          id: "runtime-model",
          brand: "Anthropic",
          label: "Runtime Model",
          vision: true,
          efforts: ["low", "medium", "high"],
          price: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
        },
      ],
      [
        {
          id: "runtime-group",
          label: "Runtime Group",
          roles: [{ role: "默认", modelId: "runtime-model", effort: "medium" }],
        },
      ],
    );
    panel.open("models");
    const model = panel.render(80, 18, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(model).toContain("Runtime Model");
    expect(model).toMatch(/Provider.*Anthropic|Anthropic.*Provider/s);
    expect(model).toContain("输入 ¥");
    panel.handleInput("\t");
    const group = panel.render(80, 18, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(group).toContain("Runtime Group");
    expect(group).not.toContain("¥");
  });
});
