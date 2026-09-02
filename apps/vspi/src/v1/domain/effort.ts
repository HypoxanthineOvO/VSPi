import type { EffortLevel } from "./types.js";

const LEGACY_EFFORTS: Record<string, EffortLevel> = {
	低: "low",
	中: "medium",
	高: "high",
};

const KNOWN_LABELS: Record<string, string> = {
	off: "Off",
	on: "On",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Xhigh",
	max: "Max",
};

const KNOWN_EFFORTS = new Set(Object.keys(KNOWN_LABELS));

export interface CatalogThinkingCapability {
	availability: "none" | "always" | "dynamic";
	can_disable: boolean;
	controls: readonly ("toggle" | "effort" | "budget")[];
	efforts?: readonly string[];
	provider_efforts?: Readonly<Record<string, readonly string[]>>;
	default_effort?: string;
}

export interface CatalogEffortCapability {
	options: EffortLevel[];
	defaultEffort: EffortLevel;
	canDisable: boolean;
	mutable: boolean;
}

export function normalizeCatalogEffort(value: unknown): EffortLevel | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	const legacy = LEGACY_EFFORTS[trimmed];
	if (legacy !== undefined) return legacy;
	const known = trimmed.toLowerCase();
	if (KNOWN_EFFORTS.has(known)) return known;
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCatalogEfforts(values: readonly string[] | undefined): EffortLevel[] {
	return [
		...new Set(
			(values ?? [])
				.map(normalizeCatalogEffort)
				.filter((value): value is EffortLevel => value !== undefined),
		),
	];
}

export function catalogEffortCapability(
	thinking: CatalogThinkingCapability | undefined,
	provider?: { identity?: string; type?: string },
): CatalogEffortCapability {
	if (thinking === undefined || thinking.availability === "none") {
		return {
			options: ["off"],
			defaultEffort: "off",
			canDisable: false,
			mutable: false,
		};
	}

	const canDisable =
		thinking.availability === "dynamic" && thinking.can_disable;
	const providerEfforts = thinking.provider_efforts;
	const matchedProviderEfforts =
		(provider?.identity === undefined
			? undefined
			: providerEfforts?.[provider.identity]) ??
		(provider?.type === undefined ? undefined : providerEfforts?.[provider.type]);
	const declaredEfforts = normalizeCatalogEfforts(matchedProviderEfforts ?? thinking.efforts);
	let options: EffortLevel[];
	if (thinking.controls.includes("effort") && declaredEfforts.length > 0) {
		options = declaredEfforts;
		if (canDisable && !options.includes("off")) options = ["off", ...options];
		if (!canDisable) options = options.filter((value) => value !== "off");
	} else {
		options = canDisable ? ["off", "on"] : ["on"];
	}
	if (options.length === 0) options = canDisable ? ["off", "on"] : ["on"];

	const declaredDefault = normalizeCatalogEffort(thinking.default_effort);
	const thinkingOptions = options.filter((value) => value !== "off");
	const defaultEffort =
		declaredDefault !== undefined && options.includes(declaredDefault)
			? declaredDefault
			: (thinkingOptions[Math.floor(thinkingOptions.length / 2)] ??
				(canDisable ? "off" : "on"));
	return {
		options,
		defaultEffort,
		canDisable,
		mutable: options.length > 1,
	};
}

export function normalizeEffortLevel(
	value: unknown,
	fallback: EffortLevel = "medium",
): EffortLevel {
	return normalizeCatalogEffort(value) ?? fallback;
}

export function effortLabel(level: EffortLevel): string {
	return KNOWN_LABELS[level] ?? level.replaceAll(/[\u0000-\u001F\u007F-\u009F]/gu, "");
}

export function resolveCatalogEffort(
	requested: unknown,
	capability: Pick<CatalogEffortCapability, "options" | "defaultEffort">,
): EffortLevel {
	const normalized = normalizeCatalogEffort(requested);
	if (normalized !== undefined && capability.options.includes(normalized)) {
		return normalized;
	}
	if (capability.options.includes(capability.defaultEffort)) {
		return capability.defaultEffort;
	}
	const thinking = capability.options.filter((value) => value !== "off");
	return (
		thinking[Math.floor(thinking.length / 2)] ??
		capability.options[0] ??
		"off"
	);
}
