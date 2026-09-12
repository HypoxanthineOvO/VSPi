interface RecommendedModel {
	readonly label: string;
	readonly ids: readonly string[];
	readonly names?: readonly string[];
}

export const RECOMMENDED_MODELS: readonly RecommendedModel[] = [
	{ label: "GPT 6", ids: ["gpt-6", "gpt-6-astra"] },
	{ label: "GPT 5.6 Sol", ids: ["gpt-5.6-sol"] },
	{ label: "GPT 5.6 Luna", ids: ["gpt-5.6-luna"] },
	{ label: "Claude Fable 5.1", ids: ["claude-fable-5-1"] },
	{ label: "Claude Fable 5", ids: ["claude-fable-5"] },
	{ label: "Claude Opus 5", ids: ["claude-opus-5"] },
	{ label: "Kimi K3", ids: ["kimi-k3"] },
	{ label: "Kimi K2.8 Preview", ids: [], names: ["Kimi K2.8", "Kimi K2.8 Preview"] },
	{ label: "GLM 5.3", ids: ["glm-5.3"] },
	{ label: "GLM 5.3 Flash", ids: ["glm-5.3-flash"] },
	{ label: "DeepSeek V4.1 Flash", ids: ["deepseek-v4.1-flash"] },
	{ label: "DeepSeek V4 Pro", ids: ["deepseek-v4-pro"] },
	{ label: "MiniMax M3", ids: ["minimax-m3"] },
	{ label: "MiMo V2.5", ids: ["mimo-v2.5"] },
	{ label: "MiMo V2.5 Pro", ids: ["mimo-v2.5-pro"] },
	{ label: "Qwen 3.8 Max", ids: ["qwen3.8-max"] },
	{ label: "Qwen 3.8 Flash", ids: ["qwen3.8-flash"] },
	{ label: "Gemini 3.8 Flash", ids: ["gemini-3.8-flash"] },
	{ label: "Gemini 3.1 Pro", ids: ["gemini-3.1-pro", "gemini-3.1-pro-preview"] },
	{ label: "Hy4 Preview", ids: ["hy4-preview"] },
];

const recommendedIds = new Set(RECOMMENDED_MODELS.flatMap((model) => model.ids));
const pendingNames = new Set(RECOMMENDED_MODELS.flatMap((model) => model.names ?? []).map((name) => name.toLowerCase()));

export function isOfficialRecommendedModel(id: string, displayName?: string): boolean {
	const modelId = id.split("/").at(-1)?.toLowerCase() ?? "";
	return recommendedIds.has(modelId) || (displayName !== undefined && pendingNames.has(displayName.trim().toLowerCase()));
}
