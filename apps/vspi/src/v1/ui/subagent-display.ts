export function formatSubagentProfile(profile: string): string {
	if (profile.length === 0) return profile;
	return `${profile.charAt(0).toUpperCase()}${profile.slice(1)}`;
}

export function formatSubagentModel(model: string): string {
	const source = model.split("/").at(-1) ?? model;
	const words = source.split(/[\s_-]+/u).filter(Boolean);
	return words.map((word, index) => formatModelWord(word, index)).join(" ");
}

export function formatSubagentProviderModel(
	provider: string,
	model: string,
): string {
	const providerLabels: Readonly<Record<string, string>> = {
		openai: "OpenAI",
		deepseek: "DeepSeek",
		anthropic: "Anthropic",
	};
	const providerLabel =
		providerLabels[provider.toLowerCase()] ?? formatSubagentModel(provider);
	return `${providerLabel} / ${formatSubagentModel(model)}`;
}

function formatModelWord(word: string, index: number): string {
	if (index === 0 && /^[a-z]{2,4}$/u.test(word)) return word.toUpperCase();
	if (/^v\d+(?:\.\d+)?$/iu.test(word)) return `V${word.slice(1)}`;
	if (/^\d+(?:\.\d+)*$/u.test(word)) return word;
	return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}
