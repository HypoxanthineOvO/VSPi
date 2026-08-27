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
  it("ships the VSPLab composite catalog with per-family protocols and no credentials", () => {
    const vsplab = BUILTIN_PROVIDERS.find((item) => item.id === "vsplab");
    expect(vsplab).toBeDefined();
    expect(vsplab?.source).toBe("builtin");
    expect(vsplab?.protocol).toBe("openai-responses");
    expect(vsplab?.baseUrl).toBe("https://api.vsplab.cn/v1");
    // 继承已下沉到 per-model inheritFrom；provider 级不再整体挂 openai-codex。
    expect(vsplab?.inheritModelsFrom).toBeUndefined();

    expect(vsplab?.models.map((model) => model.id)).toEqual([
      // GLM
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.6",
      "glm-4.5",
      "glm-4.5-air",
      // Kimi
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3",
      "k3-256k",
      "kimi-k2.7-code",
      // DeepSeek
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      // GPT
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
      "gpt-5.2-pro",
      // Claude
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]);

    const byId = new Map(vsplab?.models.map((model) => [model.id, model]));
    // Kimi 家族走 chat completions；Claude 家族走 anthropic-messages 且 baseUrl 去掉 /v1。
    for (const id of ["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k", "kimi-k2.7-code"]) {
      expect(byId.get(id)?.api).toBe("openai-completions");
    }
    for (const id of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]) {
      expect(byId.get(id)?.api).toBe("anthropic-messages");
      expect(byId.get(id)?.baseUrl).toBe("https://api.vsplab.cn");
    }
    // GPT / DeepSeek / GLM 未声明 per-model api，随 provider 默认 openai-responses。
    for (const id of ["gpt-5.6-sol", "deepseek-v4-pro", "glm-5.3", "glm-5.3-flash"]) {
      expect(byId.get(id)?.api).toBeUndefined();
    }
    // 内置 catalog 绝不携带 credential 字段；GPT-5.6 显式选择 1.05M 长上下文。
    expect(JSON.stringify(BUILTIN_PROVIDERS)).not.toMatch(/"(api[-_]?key|secret|password|credential)"/i);
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(byId.get(id)?.contextWindow).toBe(1_050_000);
      expect(byId.get(id)?.maxTokens).toBe(128_000);
    }
  });

  it("registers every composite model and inherits shared metadata per family", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    registerBuiltinProviders(runtime, BUILTIN_PROVIDERS);

    const codexIds = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
    for (const id of codexIds) {
      const model = runtime.getModel("vsplab", id);
      expect(model, `vsplab/${id} must register`).toBeDefined();
      const expectedContextWindow = id.startsWith("gpt-5.6-") ? 1_050_000 : 272_000;
      expect(model?.contextWindow).toBe(expectedContextWindow);
      expect(model?.maxTokens).toBe(128_000);
      expect(model?.reasoning).toBe(true);
      expect(model?.input).toContain("text");
      expect(model?.input).toContain("image");
      const upstream = runtime.getModel("openai-codex", id);
      expect(model?.cost).toEqual(upstream?.cost);
      expect(model?.thinkingLevelMap).toEqual(upstream?.thinkingLevelMap);
    }
    const efforts = Object.fromEntries(
      codexIds.map((id) => [id, modelEffortLevels(runtime.getModel("vsplab", id) ?? {})]),
    );
    expect(efforts["gpt-5.4"]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
      expect(efforts[id]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    }

    // 国产模型家族：协议覆盖生效，共享规格按各家上游目录继承。
    const kimi = runtime.getModel("vsplab", "kimi-for-coding");
    expect(kimi?.api).toBe("openai-completions");
    expect(kimi?.contextWindow).toBe(runtime.getModel("kimi-coding", "kimi-for-coding")?.contextWindow);
    expect(runtime.getModel("vsplab", "k3-256k")?.contextWindow).toBe(
      runtime.getModel("kimi-coding", "k3-256k")?.contextWindow,
    );
    const glm = runtime.getModel("vsplab", "glm-5.3");
    expect(glm?.api).toBe("openai-responses");
    expect(glm?.cost).toEqual(runtime.getModel("zai", "glm-5.3")?.cost);
    const glmFlash = runtime.getModel("vsplab", "glm-5.3-flash");
    expect(glmFlash).toMatchObject({
      name: "GLM 5.3 Flash",
      api: "openai-responses",
      contextWindow: 200_000,
      maxTokens: 32_768,
      input: ["text", "image"],
    });
    const deepseek = runtime.getModel("vsplab", "deepseek-v4-pro");
    expect(deepseek?.contextWindow).toBe(runtime.getModel("deepseek", "deepseek-v4-pro")?.contextWindow);

    // Claude 家族走 anthropic-messages，baseUrl 去掉 /v1（SDK 自拼 /v1/messages）。
    const claude = runtime.getModel("vsplab", "claude-opus-5");
    expect(claude?.api).toBe("anthropic-messages");
    expect(claude?.baseUrl).toBe("https://api.vsplab.cn");
    expect(claude?.contextWindow).toBe(runtime.getModel("anthropic", "claude-opus-5")?.contextWindow);

    // 无上游条目的模型不继承也不手抄，保持运行时默认（fail-closed 的另一面：不猜规格）。
    for (const id of ["glm-5", "glm-4.5", "deepseek-chat", "gpt-5.2"]) {
      const model = runtime.getModel("vsplab", id);
      expect(model, `vsplab/${id} must register`).toBeDefined();
      expect(model?.contextWindow).toBe(128_000);
      expect(model?.maxTokens).toBe(8_192);
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
        models: [{ id: "gpt-not-in-codex", name: "Ghost", inheritFrom: "openai-codex" }],
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
