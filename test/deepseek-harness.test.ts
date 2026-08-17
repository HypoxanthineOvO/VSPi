import { describe, expect, it } from "vitest";
import {
  DeepSeekHarnessState,
  isDeepSeekSummaryRequest,
  matchDeepSeekHarnessModel,
  reanchorDeepSeekPrompt,
  rewriteDeepSeekBootstrapRequest,
  rewriteDeepSeekPromotedRequest,
} from "../src/deepseek/harness.js";
import { DEEPSEEK_HARNESS_PERSONA, DEEPSEEK_HARNESS_TOOLS } from "../src/deepseek/official.js";

describe("DeepSeek anchored-standard model matching", () => {
  it.each([
    [{ provider: "deepseek", id: "deepseek-v4-pro" }, "pro"],
    [{ provider: "deepseek", id: "v4-flash", name: "DeepSeek V4 Flash" }, "flash"],
    [{ provider: "openrouter", id: "deepseek/deepseek-v4-pro" }, "pro"],
    [{ provider: "relay", id: "vendor-model", name: "DeepSeek: V4 Flash" }, "flash"],
    [{ provider: "deepseek", id: "deepseek-v3.2" }, undefined],
    [{ provider: "other", id: "v4-pro" }, undefined],
  ])("classifies %j as %s", (model, expected) => {
    expect(matchDeepSeekHarnessModel(model)).toBe(expected);
  });
});

describe("DeepSeek anchored-standard state", () => {
  it("moves through inactive, bootstrap, promoted, model-switch, and compaction epochs", () => {
    const state = new DeepSeekHarnessState();

    expect(state.selectModel({ provider: "openai", id: "gpt-5.6" })).toEqual({
      phase: "inactive",
      family: null,
      epoch: 0,
      hasAssistant: false,
      hasTool: false,
    });
    expect(state.selectModel({ provider: "deepseek", id: "deepseek-v4-pro" })).toEqual({
      phase: "bootstrap",
      family: "pro",
      epoch: 1,
      hasAssistant: false,
      hasTool: false,
    });
    expect(state.noteAssistant()).toEqual({
      phase: "promoted",
      family: "pro",
      epoch: 1,
      hasAssistant: true,
      hasTool: false,
    });
    expect(state.selectModel({ provider: "deepseek", id: "deepseek-v4-flash" })).toEqual({
      phase: "bootstrap",
      family: "flash",
      epoch: 2,
      hasAssistant: false,
      hasTool: false,
    });
    expect(state.noteToolCall().phase).toBe("promoted");
    expect(state.compact()).toEqual({
      phase: "bootstrap",
      family: "flash",
      epoch: 3,
      hasAssistant: false,
      hasTool: false,
    });
  });

  it.each([
    ["either", "assistant", "promoted"],
    ["either", "tool", "promoted"],
    ["assistant-message", "assistant", "promoted"],
    ["assistant-message", "tool", "bootstrap"],
    ["tool-call", "assistant", "bootstrap"],
    ["tool-call", "tool", "promoted"],
  ] as const)("supports %s promotion after %s", (mode, signal, expected) => {
    const state = new DeepSeekHarnessState(mode);
    state.selectModel({ provider: "deepseek", id: "deepseek-v4-pro" });
    const snapshot = signal === "assistant" ? state.noteAssistant() : state.noteToolCall();
    expect(snapshot.phase).toBe(expected);
  });

  it("reconstructs only the current resume epoch", () => {
    const state = new DeepSeekHarnessState();
    expect(
      state.resume({ provider: "deepseek", id: "deepseek-v4-pro" }, [
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } },
        { type: "compaction" },
        { type: "message", message: { role: "user", content: "continue" } },
      ]),
    ).toEqual({
      phase: "bootstrap",
      family: "pro",
      epoch: 1,
      hasAssistant: false,
      hasTool: false,
    });

    expect(
      state.resume({ provider: "deepseek", id: "deepseek-v4-pro" }, [
        { type: "message", message: { role: "assistant", content: "old" } },
        { type: "model_change" },
        { type: "message", message: { role: "toolResult", content: "result" } },
      ]).phase,
    ).toBe("promoted");

    expect(
      state.resume({ provider: "deepseek", id: "deepseek-v4-pro" }, [
        { type: "message", message: { role: "assistant", content: "old branch" } },
        { type: "branch_summary" },
        { type: "message", message: { role: "user", content: "continue branch" } },
      ]),
    ).toEqual({
      phase: "bootstrap",
      family: "pro",
      epoch: 1,
      hasAssistant: false,
      hasTool: false,
    });
  });
});

describe("DeepSeek anchored-standard wire surface", () => {
  it("reanchors promoted Pi identity while preserving the assembled VSPi surface", () => {
    const assembled =
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nVSPi contract\n\n<project_context>AGENTS</project_context>\n\n<available_skills>skills</available_skills>";
    const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];
    const payload = { instructions: assembled, tools, input: [{ role: "user", content: "continue" }] };

    expect(reanchorDeepSeekPrompt(assembled)).toBe(
      `${DEEPSEEK_HARNESS_PERSONA}\n\nVSPi contract\n\n<project_context>AGENTS</project_context>\n\n<available_skills>skills</available_skills>`,
    );
    expect(rewriteDeepSeekPromotedRequest(payload)).toEqual({
      ...payload,
      instructions: reanchorDeepSeekPrompt(assembled),
    });
    expect((rewriteDeepSeekPromotedRequest(payload) as typeof payload).tools).toBe(tools);
  });
  it("uses the fixed upstream persona and exact two-tool Chat Completions surface", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "large VSPi prompt" },
        { role: "user", content: "fix it" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    };

    expect(rewriteDeepSeekBootstrapRequest(payload)).toEqual({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: DEEPSEEK_HARNESS_PERSONA },
        { role: "user", content: "fix it" },
      ],
      tools: DEEPSEEK_HARNESS_TOOLS.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    });
    expect(payload.messages[0]?.content).toBe("large VSPi prompt");
  });

  it("preserves Anthropic and named-parameter tool envelope shapes", () => {
    const anthropic = rewriteDeepSeekBootstrapRequest({
      system: [{ type: "text", text: "large prompt", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    });
    expect(anthropic).toEqual({
      system: [{ type: "text", text: DEEPSEEK_HARNESS_PERSONA, cache_control: { type: "ephemeral" } }],
      tools: DEEPSEEK_HARNESS_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    });

    const named = rewriteDeepSeekBootstrapRequest({
      instructions: "large prompt",
      tools: [{ name: "read", parameters: { type: "object" } }],
    });
    expect(named).toEqual({
      instructions: DEEPSEEK_HARNESS_PERSONA,
      tools: DEEPSEEK_HARNESS_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });
  });

  it("reanchors only the first Anthropic text block and preserves all block metadata", () => {
    const payload = {
      system: [
        { type: "text", text: "Pi identity", cache_control: { type: "ephemeral" } },
        { type: "text", text: "AGENTS + skills", cache_control: { type: "persistent" } },
        { type: "custom", value: { keep: true } },
      ],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    };

    expect(rewriteDeepSeekPromotedRequest(payload)).toEqual({
      ...payload,
      system: [
        {
          type: "text",
          text: `${DEEPSEEK_HARNESS_PERSONA}\n\nPi identity`,
          cache_control: { type: "ephemeral" },
        },
        payload.system[1],
        payload.system[2],
      ],
    });
  });

  it.each([
    {
      system: "You are a context summarization assistant.",
      messages: [{ role: "user", content: "summarize" }],
      tools: [],
    },
    {
      system: "normal",
      messages: [{ role: "user", content: "<conversation>history</conversation>" }],
      tools: [],
    },
    {
      system: "normal",
      messages: [{ role: "user", content: "<conversation>x<previous-summary>y" }],
      tools: [],
    },
  ])("does not rewrite compaction or branch-summary payloads", (payload) => {
    expect(isDeepSeekSummaryRequest(payload)).toBe(true);
    expect(rewriteDeepSeekBootstrapRequest(payload)).toBe(payload);
  });

  it("leaves inactive and promoted payload identity unchanged", () => {
    const payload = { system: "full", tools: [{ name: "read", parameters: {} }] };
    const inactive = new DeepSeekHarnessState();
    inactive.selectModel({ provider: "openai", id: "gpt-5.6" });
    expect(inactive.rewrite(payload)).toBe(payload);

    const promoted = new DeepSeekHarnessState();
    promoted.selectModel({ provider: "deepseek", id: "deepseek-v4-pro" });
    promoted.noteAssistant();
    expect(promoted.rewrite(payload)).toBe(payload);
  });
});
