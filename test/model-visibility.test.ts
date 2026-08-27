import { describe, expect, it } from "vitest";
import { isVisibleRuntimeModel } from "../src/providers/model-visibility.js";

const visible = (provider: string, id: string, name = id) => isVisibleRuntimeModel({ provider, id, name });

describe("curated runtime model visibility", () => {
  it("keeps only the requested built-in model families and their variants", () => {
    expect(visible("openai", "gpt-5.4-pro")).toBe(true);
    expect(visible("openai-codex", "gpt-5.6-luna")).toBe(true);
    expect(visible("openai", "gpt-5.3-codex")).toBe(false);
    expect(visible("vsplab", "gpt-5.6-sol")).toBe(true);
    expect(visible("vsplab", "gpt-4o")).toBe(false);
    expect(visible("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(visible("anthropic", "claude-opus-4-8")).toBe(true);
    expect(visible("anthropic", "claude-fable-5")).toBe(true);
    expect(visible("anthropic", "claude-opus-4-5")).toBe(false);
    expect(visible("moonshotai", "kimi-k2.6")).toBe(true);
    expect(visible("kimi-coding", "kimi-for-coding-highspeed")).toBe(true);
    expect(visible("moonshotai", "kimi-k2.5")).toBe(false);
    expect(visible("xiaomi", "mimo-v2.5-pro-ultraspeed")).toBe(true);
    expect(visible("deepseek", "deepseek-v4-pro")).toBe(true);
    expect(visible("zai", "glm-5.2")).toBe(true);
    expect(visible("zai", "glm-5.3")).toBe(true);
    expect(visible("zai", "glm-5.3-flash")).toBe(true);
    expect(visible("zai-coding-cn", "GLM-5.3-highspeed")).toBe(true);
    expect(visible("qwen-token-plan", "qwen3.8-max-preview")).toBe(true);
    expect(visible("minimax", "MiniMax-M2.7-highspeed")).toBe(true);
  });

  it("applies each brand's family rules to the VSPLab composite catalog", () => {
    // GLM 家族：glm-5.1/5.2/5.3 可见，glm-5 / 4.x 不可见（与 zai 原生规则一致）。
    expect(visible("vsplab", "glm-5.3")).toBe(true);
    expect(visible("vsplab", "glm-5.3-flash")).toBe(true);
    expect(visible("vsplab", "glm-5.1")).toBe(true);
    expect(visible("vsplab", "glm-5")).toBe(false);
    expect(visible("vsplab", "glm-4.5-air")).toBe(false);
    // Kimi 家族：code / coding / k3 可见。
    expect(visible("vsplab", "kimi-for-coding")).toBe(true);
    expect(visible("vsplab", "k3")).toBe(true);
    expect(visible("vsplab", "kimi-k2.7-code")).toBe(true);
    // DeepSeek 家族：仅 v4 可见。
    expect(visible("vsplab", "deepseek-v4-pro")).toBe(true);
    expect(visible("vsplab", "deepseek-chat")).toBe(false);
    // Claude 家族：与 anthropic 原生规则一致。
    expect(visible("vsplab", "claude-sonnet-5")).toBe(true);
    expect(visible("vsplab", "claude-fable-5")).toBe(true);
    // GPT 家族：gpt-5.2 不在 curated 范围。
    expect(visible("vsplab", "gpt-5.4-mini")).toBe(true);
    expect(visible("vsplab", "gpt-5.2")).toBe(false);
  });

  it("hides unrelated built-ins while preserving user-defined providers", () => {
    expect(visible("google", "gemini-3-pro")).toBe(false);
    expect(visible("baseten", "any-model")).toBe(false);
    expect(visible("qwen-token-plan-individual", "qwen3.8-max-preview")).toBe(false);
    expect(visible("my-lab", "experimental-model")).toBe(true);
  });

  it("shows the complete configured OpenCode Go catalog without hardcoding model ids", () => {
    expect(visible("opencode-go", "gpt-5.6-luna")).toBe(true);
    expect(visible("opencode-go", "future-catalog-model")).toBe(true);
  });
});
