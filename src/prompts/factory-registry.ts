import type { PromptProfile } from "./types.js";

export interface FactoryPromptRegistry {
  list(): readonly PromptProfile[];
  get(id: string): PromptProfile | undefined;
}

const FAMILIES = [
  ["anthropic", "Anthropic", "先明确假设，检查相关上下文，验证完成后再宣称完成。"],
  ["openai", "OpenAI", "明确任务边界，审慎使用工具，报告具体的验证证据。"],
  ["google", "Google", "细致拆解问题，保留来源上下文，区分证据与推断。"],
  ["deepseek", "DeepSeek", "推演实现约束，控制修改范围，验证边界情况。"],
  ["moonshot", "Moonshot", "在长上下文中持续跟踪用户意图，用简洁的证据收尾任务。"],
  ["z-ai", "Z.AI", "从仓库证据中消除歧义，显式说明状态变化。"],
  ["xiaomi", "Xiaomi", "优先采用稳健的本地模式，验证工具结果，主动暴露未解决的风险。"],
  ["minimax", "MiniMax", "保持任务连续性，不做无依据的断言，改动后测试行为。"],
  ["tencent", "Tencent", "结构化执行，保护用户数据，保持运维输出精确。"],
  ["alibaba", "Alibaba", "遵循项目约定，显式处理失败，验证最终产物。"],
] as const;

const OFFICIAL_SOURCES: Record<string, { sourceUrl: string; ref: string; licensePolicy: string }> = {
  anthropic: {
    sourceUrl: "https://github.com/anthropics/claude-code",
    ref: "2982f951552e94f38cd972764ae94c1d90c41da3",
    licensePolicy: "repository-license",
  },
  openai: {
    sourceUrl: "https://github.com/openai/codex",
    ref: "81da9deb065d7adb283816b19b40f89bcc484276",
    licensePolicy: "repository-license",
  },
  google: {
    sourceUrl: "https://github.com/google-gemini/gemini-cli",
    ref: "69b51f8fa2af0abf717daaba4dca1c627023d82d",
    licensePolicy: "repository-license",
  },
  deepseek: {
    sourceUrl: "https://github.com/deepseek-ai/DeepSeek-V3",
    ref: "9b4e9788e4a3a731f7567338ed15d3ec549ce03b",
    licensePolicy: "repository-license",
  },
  moonshot: {
    sourceUrl: "https://github.com/MoonshotAI/kimi-cli",
    ref: "4a550effdfcb29a25a5d325bf935296cc50cd417",
    licensePolicy: "repository-license",
  },
  "z-ai": {
    sourceUrl: "https://github.com/zai-org/GLM-4.5",
    ref: "170f20b2c10659008fdbc909d478bc2a75bc3627",
    licensePolicy: "repository-license",
  },
  xiaomi: {
    sourceUrl: "https://github.com/XiaomiMiMo/MiMo-V2-Flash",
    ref: "b4eaae40d3728657ff7f0f9397dcce3c9ab3d3b7",
    licensePolicy: "repository-license",
  },
  minimax: {
    sourceUrl: "https://github.com/MiniMax-AI/MiniMax-M2",
    ref: "2e575efec12773cdc5d811341089512452bfb468",
    licensePolicy: "repository-license",
  },
  tencent: {
    sourceUrl: "https://github.com/Tencent-Hunyuan/Hunyuan-A13B",
    ref: "2798f3c8b6a69e0ce93950b0d2417203cf950fa0",
    licensePolicy: "repository-license",
  },
  alibaba: {
    sourceUrl: "https://github.com/QwenLM/qwen-code",
    ref: "2a97c55ac8d42c9673690dea8ebf1ad7a1aebcec",
    licensePolicy: "repository-license",
  },
};

const FACTORIES: PromptProfile[] = FAMILIES.map(([family, name, profile]) => ({
  id: `factory-${family}`,
  name: `${name} 出厂`,
  family,
  sourceType: "factory",
  evaluationStatus: "unreviewed",
  segments: { profile },
  immutable: true,
  origin: officialSource(family),
}));

export function createFactoryPromptRegistry(
  options: { entries?: PromptProfile[]; contentOverrides?: Partial<Record<string, string>> } = {},
): FactoryPromptRegistry {
  const factories = (options.entries ?? FACTORIES).map((profile) => ({
    ...structuredClone(profile),
    segments: {
      profile: options.contentOverrides?.[profile.family] ?? profile.segments.profile,
    },
  }));
  return {
    list: () => factories.map(cloneFrozen),
    get: (id) => {
      const profile = factories.find((item) => item.id === id);
      return profile ? cloneFrozen(profile) : undefined;
    },
  };
}

function cloneFrozen(profile: PromptProfile): PromptProfile {
  const clone = structuredClone(profile);
  Object.freeze(clone.segments);
  if (clone.origin) Object.freeze(clone.origin);
  return Object.freeze(clone);
}

function officialSource(family: string): NonNullable<PromptProfile["origin"]> {
  const source = OFFICIAL_SOURCES[family];
  if (!source) throw new Error(`Factory source metadata missing for ${family}`);
  return structuredClone(source);
}
