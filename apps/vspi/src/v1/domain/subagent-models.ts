import type { SubagentModelEdit, SubagentModelPreferences } from "../backend/types.js";

export function subagentModelPreferences(section: Record<string, unknown> | undefined): SubagentModelPreferences {
	const defaultModel = typeof section?.["defaultModel"] === "string" ? section["defaultModel"]
		: typeof section?.["model"] === "string" ? section["model"] : undefined;
	const raw = section?.["models"];
	const models = raw && typeof raw === "object" && !Array.isArray(raw)
		? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
		: defaultModel ? { [defaultModel]: "" } : {};
	return { models, defaultModel, force: section?.["force"] === true ? true : undefined };
}

export function editSubagentModels(current: SubagentModelPreferences, edit: SubagentModelEdit): SubagentModelPreferences {
	const models = { ...current.models };
	if (edit.action === "toggle" && Object.hasOwn(models, edit.model)) delete models[edit.model];
	else models[edit.model] = edit.action === "purpose" ? edit.purpose.trim() : models[edit.model] ?? "";
	const defaultModel = edit.action === "default" ? edit.model
		: current.defaultModel && Object.hasOwn(models, current.defaultModel) ? current.defaultModel : Object.keys(models)[0];
	return { models, defaultModel };
}
