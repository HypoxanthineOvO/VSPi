import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { formatProviderName } from "../src/domain/providers.js";
import type { ProviderOption } from "../src/domain/types.js";
import { BUILTIN_PROVIDERS, PROVIDER_PRIORITY } from "../src/providers/builtins.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

function provider(id: string, label: string): ProviderOption {
  return { id, label, protocol: "openai-responses", status: "未配置", detail: "0 个可用模型" };
}

describe("builtin providers", () => {
  it("ships VSPLab with openai-responses protocol and no credentials", () => {
    const vsplab = BUILTIN_PROVIDERS.find((item) => item.id === "vsplab");
    expect(vsplab).toBeDefined();
    expect(vsplab?.source).toBe("builtin");
    expect(vsplab?.protocol).toBe("openai-responses");
    expect(vsplab?.baseUrl).toBe("https://api.vsplab.cn/v1");
    expect(vsplab?.models.length).toBeGreaterThan(0);
    for (const model of vsplab?.models ?? []) {
      expect(model.input).toContain("text");
    }
    // 内置 catalog 绝不携带 credential 字段
    expect(JSON.stringify(BUILTIN_PROVIDERS)).not.toMatch(/"(api[-_]?key|secret|password|credential)"/i);
  });

  it("orders the provider panel by priority then label", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setProviders([
      provider("openrouter", "OpenRouter"),
      provider("openai", "OpenAI"),
      provider("vsplab", "VSPLab"),
      provider("anthropic", "Anthropic"),
      provider("deepseek", "DeepSeek"),
    ]);
    panel.open("providers");
    const rendered = panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    const order = ["VSPLab", "DeepSeek", "OpenAI", "Anthropic", "OpenRouter"].map((label) => rendered.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("maps builtin and partner provider ids to display names", () => {
    expect(formatProviderName("vsplab")).toBe("VSPLab");
    expect(formatProviderName("kimi-coding")).toBe("Kimi Coding");
    expect(formatProviderName("xiaomi")).toBe("Xiaomi");
    expect(formatProviderName("zai")).toBe("Zai");
  });

  it("keeps priority ids aligned with the pi catalog naming", () => {
    expect(PROVIDER_PRIORITY.slice(0, 2)).toEqual(["vsplab", "deepseek"]);
    expect(PROVIDER_PRIORITY).toContain("kimi-coding");
    expect(PROVIDER_PRIORITY).toContain("minimax");
  });
});
