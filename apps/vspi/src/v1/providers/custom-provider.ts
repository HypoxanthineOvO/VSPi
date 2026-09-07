import { createHash } from "node:crypto";

import type { ProviderAuthInteraction } from "../backend/types.js";

export type CustomProviderProtocol =
	| "openai"
	| "openai_responses"
	| "anthropic"
	| "google-genai";

export interface DiscoveredModel {
	id: string;
	name: string;
}

export function customProviderId(name: string, baseUrl: string): string {
	const slug = name
		.normalize("NFKD")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, 32);
	const identity = createHash("sha256")
		.update(`${name}\n${baseUrl}`)
		.digest("hex")
		.slice(0, 8);
	return slug ? `custom-${slug}-${identity}` : `custom-${identity}`;
}

export async function discoverProviderModels(
	baseUrl: string,
	protocol: CustomProviderProtocol,
	apiKey: string,
	interaction: ProviderAuthInteraction,
	options: { fetch?: typeof fetch } = {},
): Promise<DiscoveredModel[]> {
	try {
		const endpoint = modelListEndpoint(baseUrl);
		const response = await (options.fetch ?? fetch)(endpoint, {
			headers: discoveryHeaders(protocol, apiKey),
			redirect: "error",
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
		const body = (await response.json()) as unknown;
		const models = modelEntries(body)
			.map(modelFromEntry)
			.filter((model): model is DiscoveredModel => model !== undefined)
			.slice(0, 200);
		if (models.length === 0) throw new Error("接口没有返回可识别的模型 ID");
		return models;
	} catch (error) {
		interaction.notify({
			type: "info",
			message: `未能自动读取模型列表：${error instanceof Error ? error.message : "未知错误"}`,
		});
		const manual = await interaction.prompt({
			type: "text",
			message: "请输入至少一个模型 ID，多个可用逗号分隔",
			placeholder: "model-id",
			signal: interaction.signal,
		});
		return modelsFromManualInput(manual);
	}
}

export function modelsFromManualInput(value: string): DiscoveredModel[] {
	const ids = [
		...new Set(
			value
				.split(/[，,\s]+/u)
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
	if (ids.length === 0) throw new Error("自定义 Provider 至少需要一个模型 ID");
	return ids.map((id) => ({ id, name: id }));
}

function modelListEndpoint(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new Error("Base URL 只支持 HTTP(S)");
	if (url.username || url.password) throw new Error("Base URL 不能包含账号或密码");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return new URL("models", url).href;
}

function discoveryHeaders(
	protocol: CustomProviderProtocol,
	apiKey: string,
): Record<string, string> {
	if (protocol === "anthropic") {
		return {
			Accept: "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": apiKey,
		};
	}
	if (protocol === "google-genai") {
		return { Accept: "application/json", "x-goog-api-key": apiKey };
	}
	return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}

function modelEntries(value: unknown): Record<string, unknown>[] {
	if (!isRecord(value)) return [];
	const candidates = Array.isArray(value.data)
		? value.data
		: Array.isArray(value.models)
			? value.models
			: [];
	return candidates.filter(isRecord);
}

function modelFromEntry(value: Record<string, unknown>): DiscoveredModel | undefined {
	const rawId =
		typeof value.id === "string"
			? value.id
			: typeof value.name === "string"
				? value.name
				: undefined;
	const id = rawId?.replace(/^models\//u, "").trim();
	if (!id) return undefined;
	const rawName = value.display_name ?? value.displayName ?? value.name;
	const name =
		typeof rawName === "string"
			? rawName.replace(/^models\//u, "").trim() || id
			: id;
	return { id, name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
