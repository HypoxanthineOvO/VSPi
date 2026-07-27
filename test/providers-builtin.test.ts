import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { modelEffortLevels } from "../src/domain/effort.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { formatProviderName } from "../src/domain/providers.js";
import type { ProviderOption } from "../src/domain/types.js";
import { BUILTIN_PROVIDERS, PROVIDER_PRIORITY } from "../src/providers/builtins.js";
import { registerBuiltinProviders } from "../src/providers/runtime-registration.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

function provider(id: string, label: string): ProviderOption {
  return { id, label, protocol: "openai-responses", status: "未配置", detail: "0 个可用模型" };
}

describe("builtin providers", () => {
  it("ships VSPLab with openai-responses protocol, upstream inheritance and no credentials", () => {
    const vsplab = BUILTIN_PROVIDERS.find((item) => item.id === "vsplab");
    expect(vsplab).toBeDefined();
    expect(vsplab?.source).toBe("builtin");
    expect(vsplab?.protocol).toBe("openai-responses");
    expect(vsplab?.baseUrl).toBe("https://api.vsplab.cn/v1");
    expect(vsplab?.inheritModelsFrom).toBe("openai-codex");
    expect(vsplab?.models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
    ]);
    // 内置 catalog 绝不携带 credential 字段，也不再手抄上游维护的规格
    expect(JSON.stringify(BUILTIN_PROVIDERS)).not.toMatch(/"(api[-_]?key|secret|password|credential)"/i);
    expect(JSON.stringify(vsplab?.models)).not.toContain("1050000");
  });

  it("inherits the Pi openai-codex catalog at registration and guards the Codex 272K ceiling", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    registerBuiltinProviders(runtime, BUILTIN_PROVIDERS);

    const ids = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"];
    for (const id of ids) {
      const model = runtime.getModel("vsplab", id);
      expect(model, `vsplab/${id} must register`).toBeDefined();
      expect(model?.contextWindow).toBe(272_000);
      expect(model?.maxTokens).toBe(128_000);
      expect(model?.reasoning).toBe(true);
      expect(model?.input).toContain("text");
      expect(model?.input).toContain("image");
      const upstream = runtime.getModel("openai-codex", id);
      expect(model?.cost).toEqual(upstream?.cost);
      expect(model?.thinkingLevelMap).toEqual(upstream?.thinkingLevelMap);
    }
    const efforts = Object.fromEntries(ids.map((id) => [id, modelEffortLevels(runtime.getModel("vsplab", id) ?? {})]));
    expect(efforts["gpt-5.4"]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(efforts["gpt-5.5"]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
      expect(efforts[id]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("fails closed instead of guessing a context window when the upstream catalog entry is missing", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    const vsplab = BUILTIN_PROVIDERS.find((provider) => provider.id === "vsplab");
    expect(vsplab).toBeDefined();
    if (!vsplab) return;
    const broken = [
      {
        ...vsplab,
        models: [{ id: "gpt-not-in-codex", name: "Ghost" }],
      },
    ];
    expect(() => registerBuiltinProviders(runtime, broken)).toThrow(/openai-codex.*missing|missing.*openai-codex/i);
    expect(runtime.getModel("vsplab", "gpt-not-in-codex")).toBeUndefined();
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
    expect(formatProviderName("openai-codex")).toBe("OpenAI Codex");
    expect(formatProviderName("azure-openai-responses")).toBe("Azure OpenAI");
  });

  it("keeps priority ids aligned with the pi catalog naming", () => {
    expect(PROVIDER_PRIORITY.slice(0, 2)).toEqual(["vsplab", "deepseek"]);
    expect(PROVIDER_PRIORITY).toContain("kimi-coding");
    expect(PROVIDER_PRIORITY).toContain("minimax");
  });
});
