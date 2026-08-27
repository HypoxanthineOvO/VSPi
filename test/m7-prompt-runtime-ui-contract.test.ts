import { Key } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController, type PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

interface ModelIdentity {
  provider: string;
  model: string;
}

interface PromptOverlayResolution {
  profileId?: string;
  overlay?: string;
}

interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: unknown[];
  systemPrompt: string;
  systemPromptOptions: Record<string, unknown>;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
  message?: unknown;
}

type BeforeAgentStartHandler = (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>;

type PiExtensionFactory = (pi: { on(event: "before_agent_start", handler: BeforeAgentStartHandler): void }) => void;

async function runtimeModule() {
  const specifier = "../src/prompts/pi-prompt-profile-extension.js";
  return (await import(specifier)) as {
    VSPI_LANGUAGE_CONTRACT: string;
    createPromptProfileExtension(options: {
      resolve(identity: ModelIdentity): Promise<PromptOverlayResolution>;
      getModelIdentity(): ModelIdentity;
      getModelDisplayName?(): string | undefined;
      resolveEnvironment?(): { currentDate: string; timezone: string };
    }): PiExtensionFactory;
  };
}

function registerBeforeAgentStart(factory: PiExtensionFactory): BeforeAgentStartHandler {
  let handler: BeforeAgentStartHandler | undefined;
  factory({
    on(event, next) {
      if (event === "before_agent_start") handler = next;
    },
  });
  if (!handler) throw new Error("Prompt Profile extension did not register before_agent_start");
  return handler;
}

function beforeAgentStart(systemPrompt: string): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "user turn",
    systemPrompt,
    systemPromptOptions: { cwd: "/workspace" },
  };
}

describe("M7 Pi per-turn Prompt Profile overlay", () => {
  it("resolves against the current model on every turn and returns only a temporary system prompt replacement", async () => {
    const { createPromptProfileExtension, VSPI_LANGUAGE_CONTRACT } = await runtimeModule();
    let identity: ModelIdentity = { provider: "openai", model: "gpt-5" };
    const resolve = vi.fn(
      async (model: ModelIdentity): Promise<PromptOverlayResolution> => ({
        profileId: `${model.provider}-profile`,
        overlay: `Profile for ${model.provider}/${model.model}`,
      }),
    );
    const handler = registerBeforeAgentStart(
      createPromptProfileExtension({
        resolve,
        getModelIdentity: () => identity,
        getModelDisplayName: () => (identity.model === "gpt-5" ? "GPT-5" : "Claude Sonnet 4"),
        resolveEnvironment: () => ({ currentDate: "2026-08-27", timezone: "Asia/Shanghai" }),
      }),
    );

    const first = await handler(beforeAgentStart("Pi base turn one"));
    expect(first?.systemPrompt).toBe(
      `Pi base turn one\n\n${VSPI_LANGUAGE_CONTRACT}\n\n<environment_context>\n  <timezone>Asia/Shanghai</timezone>\n  <current_model>GPT-5</current_model>\n</environment_context>\n\nProfile for openai/gpt-5`,
    );
    expect(first).not.toHaveProperty("message");

    identity = { provider: "anthropic", model: "claude-sonnet-4" };
    const second = await handler(beforeAgentStart("Pi base turn two"));
    expect(second?.systemPrompt).toContain("Profile for anthropic/claude-sonnet-4");
    expect(second?.systemPrompt).toContain("<current_model>Claude Sonnet 4</current_model>");
    expect(resolve).toHaveBeenNthCalledWith(1, { provider: "openai", model: "gpt-5" });
    expect(resolve).toHaveBeenNthCalledWith(2, { provider: "anthropic", model: "claude-sonnet-4" });
  });

  it("always injects the built-in Chinese language contract and never manufactures a hidden/custom message", async () => {
    const { createPromptProfileExtension, VSPI_LANGUAGE_CONTRACT } = await runtimeModule();
    const handler = registerBeforeAgentStart(
      createPromptProfileExtension({
        resolve: async () => ({}),
        getModelIdentity: () => ({ provider: "openai", model: "gpt-5" }),
        resolveEnvironment: () => ({ currentDate: "2026-08-27", timezone: "Asia/Shanghai" }),
      }),
    );

    const result = await handler(beforeAgentStart("Original assembled Pi prompt"));
    expect(result?.systemPrompt).toContain(`Original assembled Pi prompt\n\n${VSPI_LANGUAGE_CONTRACT}`);
    expect(result?.systemPrompt).not.toContain("current_date");
    expect(result?.systemPrompt).toContain("<timezone>Asia/Shanghai</timezone>");
    expect(VSPI_LANGUAGE_CONTRACT).toMatch(/简体中文为主进行思考/);
    expect(VSPI_LANGUAGE_CONTRACT).toMatch(/不使用 emoji.*标题前缀/);
    expect(VSPI_LANGUAGE_CONTRACT).toMatch(/后续工作确实依赖用户回答[\s\S]*调用 question 工具/);
    expect(VSPI_LANGUAGE_CONTRACT).toMatch(/不得只在普通助手正文中提问后停下等待/);
    expect(VSPI_LANGUAGE_CONTRACT).toMatch(/权限与命令审批始终使用 Approval/);
    expect(result?.message).toBeUndefined();
  });

  it("does not swallow a resolution error or fall back to a stale overlay", async () => {
    const { createPromptProfileExtension } = await runtimeModule();
    let fail = false;
    const handler = registerBeforeAgentStart(
      createPromptProfileExtension({
        resolve: async () => {
          if (fail) throw new Error("profiles.session.rules[0].profileId is invalid");
          return { profileId: "valid", overlay: "VALID OVERLAY" };
        },
        getModelIdentity: () => ({ provider: "openai", model: "gpt-5" }),
      }),
    );
    expect(await handler(beforeAgentStart("Pi"))).toMatchObject({
      systemPrompt: expect.stringContaining("VALID OVERLAY"),
    });
    fail = true;
    await expect(handler(beforeAgentStart("Pi next"))).rejects.toThrow(/profiles\.session\.rules\[0\]\.profileId/);
  });
});

interface PromptPanelSnapshot {
  profiles: Array<{
    id: string;
    name: string;
    family: string;
    sourceType: "factory" | "user-fork" | "global" | "project" | "session";
    evaluationStatus: "unreviewed" | "reviewed" | "verified";
    active?: boolean;
  }>;
  rules: Array<{
    id: string;
    label: string;
    enabled: boolean;
  }>;
  resolved: { profileId?: string; scope: string; pinned: boolean; disabled: boolean };
  effectiveSegments: Array<{
    source: "pi-base" | "system" | "append" | "context" | "profile" | "plan";
    content: string;
  }>;
}

type PromptPanelEvent =
  | { type: "promptToggleRule"; ruleId: string; enabled: boolean }
  | { type: "promptPin"; profileId: string }
  | { type: "promptOff" }
  | { type: "promptFork"; profileId: string }
  | { type: "promptImport" }
  | { type: "promptExport"; profileId: string };

interface PromptPanelApi {
  open(kind: "prompt"): void;
  setPromptSnapshot(snapshot: PromptPanelSnapshot): void;
  render(
    width: number,
    rows: number,
    theme: ReturnType<typeof plainTheme>,
    usage: typeof DEFAULT_USAGE,
    focused: boolean,
  ): string[];
  handleInput(data: string): PanelEvent | PromptPanelEvent | undefined;
}

const PROMPT_SNAPSHOT: PromptPanelSnapshot = {
  profiles: [
    {
      id: "factory.openai",
      name: "OpenAI Factory",
      family: "openai",
      sourceType: "factory",
      evaluationStatus: "unreviewed",
      active: true,
    },
    {
      id: "my-openai",
      name: "My OpenAI",
      family: "openai",
      sourceType: "user-fork",
      evaluationStatus: "reviewed",
    },
  ],
  rules: [{ id: "openai-family", label: "OpenAI family", enabled: true }],
  resolved: { profileId: "factory.openai", scope: "factory", pinned: false, disabled: false },
  effectiveSegments: [
    { source: "pi-base", content: "Pi base" },
    { source: "system", content: "SYSTEM" },
    { source: "append", content: "APPEND" },
    { source: "context", content: "AGENTS" },
    { source: "profile", content: "Profile secret [REDACTED]" },
    { source: "plan", content: "Plan capsule" },
  ],
};

function promptPanel(): PromptPanelApi {
  return new PanelController(DEFAULT_SETTINGS) as unknown as PromptPanelApi;
}

describe("M7 Prompt Panel projection", () => {
  it("renders profile ownership, evaluation, active resolution, rules, and effective prompt provenance", () => {
    const panel = promptPanel();
    panel.setPromptSnapshot(PROMPT_SNAPSHOT);
    panel.open("prompt");
    const rendered = stripAnsi(panel.render(100, 28, plainTheme(), DEFAULT_USAGE, true).join("\n"));

    expect(rendered).toContain("Prompt Profile");
    expect(rendered).toContain("OpenAI Factory");
    expect(rendered).toMatch(/Factory|factory/);
    expect(rendered).toMatch(/未评测|unreviewed/);
    expect(rendered).toContain("OpenAI family");
    for (const source of ["Pi base", "SYSTEM", "APPEND", "context", "Profile", "Plan"]) {
      expect(rendered).toContain(source);
    }
    expect(rendered).not.toMatch(/PROFILE_SECRET_SENTINEL|sk-[A-Za-z0-9_-]{8,}/);
  });

  it("exposes keyboard actions for pin/off/fork and rule toggle without editing prompt files", () => {
    const pinPanel = promptPanel();
    pinPanel.setPromptSnapshot(PROMPT_SNAPSHOT);
    pinPanel.open("prompt");
    expect(pinPanel.handleInput(Key.enter)).toEqual({ type: "promptPin", profileId: "factory.openai" });

    const offPanel = promptPanel();
    offPanel.setPromptSnapshot(PROMPT_SNAPSHOT);
    offPanel.open("prompt");
    expect(offPanel.handleInput("o")).toEqual({ type: "promptOff" });

    const forkPanel = promptPanel();
    forkPanel.setPromptSnapshot(PROMPT_SNAPSHOT);
    forkPanel.open("prompt");
    expect(forkPanel.handleInput("f")).toEqual({ type: "promptFork", profileId: "factory.openai" });

    const rulePanel = promptPanel();
    rulePanel.setPromptSnapshot(PROMPT_SNAPSHOT);
    rulePanel.open("prompt");
    expect(rulePanel.handleInput("t")).toEqual({ type: "promptToggleRule", ruleId: "openai-family", enabled: false });
  });
});
