const OFFICIAL_NAMES = new Map<string, string>([
  ["vsplab", "VSPLab"],
  ["kimicoding", "Kimi Coding"],
  ["xiaomi", "Xiaomi"],
  ["zai", "Zai"],
  ["openai", "OpenAI"],
  ["deepseek", "DeepSeek"],
  ["moonshot", "Moonshot"],
  ["moonshotai", "Moonshot AI"],
  ["anthropic", "Anthropic"],
  ["google", "Google"],
  ["groq", "Groq"],
  ["xai", "XAI"],
  ["openrouter", "OpenRouter"],
  ["mistralai", "Mistral AI"],
  ["azureopenai", "Azure OpenAI"],
  ["googlevertexai", "Google Vertex AI"],
  ["amazonbedrock", "Amazon Bedrock"],
  ["githubcopilot", "GitHub Copilot"],
  ["alibabacloud", "Alibaba Cloud"],
  ["zhipuai", "Zhipu AI"],
  ["togetherai", "Together AI"],
  ["minimax", "MiniMax"],
]);

function lookupOfficialName(value: string): string | undefined {
  return OFFICIAL_NAMES.get(value.toLowerCase().replaceAll(/[-_\s]+/g, ""));
}

export function formatProviderName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Unknown";
  const official = lookupOfficialName(trimmed);
  if (official) return official;

  return trimmed
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => lookupOfficialName(word) ?? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}
