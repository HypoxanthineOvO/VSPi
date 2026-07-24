import { describe, expect, it } from "vitest";
import { formatProviderName } from "../src/domain/providers.js";

describe("provider display names", () => {
  it.each([
    ["openai", "OpenAI"],
    ["deepseek", "DeepSeek"],
    ["moonshot", "Moonshot"],
    ["anthropic", "Anthropic"],
    ["google", "Google"],
    ["groq", "Groq"],
    ["xai", "XAI"],
  ] as const)("maps %s to %s", (provider, expected) => {
    expect(formatProviderName(provider)).toBe(expected);
  });

  it.each([
    ["acme-cloud", "Acme Cloud"],
    ["local_proxy", "Local Proxy"],
    ["example_edge-runtime", "Example Edge Runtime"],
  ] as const)("title-cases unknown provider id %s", (provider, expected) => {
    expect(formatProviderName(provider)).toBe(expected);
  });
});
