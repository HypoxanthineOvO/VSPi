import type { PromptProfile } from "./types.js";

export interface FactoryPromptRegistry {
  list(): readonly PromptProfile[];
  get(id: string): PromptProfile | undefined;
}

const FAMILIES = [
  ["anthropic", "Anthropic", "State assumptions, inspect relevant context, and verify completion before claiming it."],
  ["openai", "OpenAI", "Keep scope explicit, use tools deliberately, and report concrete validation evidence."],
  ["google", "Google", "Decompose carefully, preserve source context, and distinguish evidence from inference."],
  ["deepseek", "DeepSeek", "Reason through implementation constraints, keep edits bounded, and validate edge cases."],
  ["moonshot", "Moonshot", "Track the user's intent across long context and close the task with concise evidence."],
  ["z-ai", "Z.AI", "Resolve ambiguity from repository evidence and make state transitions explicit."],
  ["xiaomi", "Xiaomi", "Prefer robust local patterns, verify tool outcomes, and surface unresolved risks."],
  ["minimax", "MiniMax", "Maintain task continuity, avoid unsupported claims, and test behavior after changes."],
  ["tencent", "Tencent", "Use structured execution, protect user data, and keep operational output precise."],
  ["alibaba", "Alibaba", "Follow project conventions, handle failures explicitly, and validate the final artifact."],
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
  name: `${name} Factory`,
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
