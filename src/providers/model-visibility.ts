interface CatalogModel {
  id: string;
  name: string;
  provider: string;
}

const CURATED_PROVIDER_IDS = new Set([
  "anthropic",
  "deepseek",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "openai",
  "openai-codex",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
  "vsplab",
]);

const KNOWN_BUILTIN_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "ant-ling",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "mistral",
  "nvidia",
  "opencode",
  "opencode-go",
  "openrouter",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  ...CURATED_PROVIDER_IDS,
]);

function searchable(model: CatalogModel): string {
  return `${model.id} ${model.name}`.toLowerCase();
}

function matchesAnthropic(model: CatalogModel): boolean {
  const value = searchable(model);
  if (value.includes("haiku")) return /latest/i.test(value) || !/\d{8}/.test(value);
  if (value.includes("sonnet")) return /sonnet[- ](?:4[.-]6|5)(?:\D|$)/i.test(value);
  if (value.includes("opus")) return /opus[- ](?:4[.-](?:6|7|8)|5)(?:\D|$)/i.test(value);
  return /fable[- ]5(?:\D|$)/i.test(value);
}

function matchesCuratedFamily(model: CatalogModel): boolean {
  const value = searchable(model);
  if (model.provider === "openai" || model.provider === "openai-codex" || model.provider === "vsplab") {
    return /gpt[- ]5[.-](?:4|5|6)(?:\D|$)/i.test(value);
  }
  if (model.provider === "anthropic") return matchesAnthropic(model);
  if (model.provider === "kimi-coding" || model.provider.startsWith("moonshotai")) {
    return /(?:k2[.-](?:6|7)|\bcode\b|coding|\bk3\b)/i.test(value);
  }
  if (model.provider.startsWith("xiaomi")) return /mimo[- ]v?2[.-]5(?:\D|$)/i.test(value);
  if (model.provider === "deepseek") return /deepseek[- ]v4(?:\D|$)/i.test(value);
  if (model.provider === "zai" || model.provider === "zai-coding-cn") {
    return /glm[- ]5[.-](?:1|2)(?:\D|$)/i.test(value);
  }
  if (model.provider.startsWith("qwen-token-plan")) {
    return /qwen[- ]?(?:3[.-]8[- ]max[- ]preview|3[.-]7[- ](?:max|plus))(?:\D|$)/i.test(value);
  }
  if (model.provider.startsWith("minimax")) return /minimax[- ]m(?:2[.-]7|3)(?:\D|$)/i.test(value);
  return false;
}

/** VSPi's intentionally small model picker. Runtime auth/catalogs remain untouched. */
export function isVisibleRuntimeModel(model: CatalogModel): boolean {
  if (CURATED_PROVIDER_IDS.has(model.provider)) return matchesCuratedFamily(model);
  return !KNOWN_BUILTIN_PROVIDER_IDS.has(model.provider);
}
