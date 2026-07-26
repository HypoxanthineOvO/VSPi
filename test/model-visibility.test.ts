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
    expect(visible("qwen-token-plan", "qwen3.8-max-preview")).toBe(true);
    expect(visible("minimax", "MiniMax-M2.7-highspeed")).toBe(true);
  });

  it("hides unrelated built-ins while preserving user-defined providers", () => {
    expect(visible("google", "gemini-3-pro")).toBe(false);
    expect(visible("my-lab", "experimental-model")).toBe(true);
  });
});
