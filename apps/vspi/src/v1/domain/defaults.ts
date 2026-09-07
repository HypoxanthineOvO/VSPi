import type { AppSettings, UsageSnapshot } from "./types.js";

export const FX = {
	currency: "CNY",
	source: "C17 fixed USD/CNY estimate",
	asOf: "2026-08-17",
	fxRate: 6.8,
} as const;

export const DEFAULT_USAGE: UsageSnapshot = {
	contextTokens: 0,
	contextWindow: 0,
	contextPercent: 0,
	contextEstimated: false,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: null,
	cacheWriteTokens: null,
	recentCacheHitPercent: null,
	sessionCacheHitPercent: null,
	cacheMissTokens: null,
	cacheMissCostUsd: null,
	throughputNow: null,
	throughputAverage: null,
	costUsd: null,
	costEstimateKind: "unknown",
	officialCostCny: null,
	providerBilledCny: null,
	currency: "CNY",
	source: FX.source,
	asOf: FX.asOf,
	fxRate: FX.fxRate,
};

export const DEFAULT_SETTINGS: AppSettings = {
	scope: "project",
	theme: "Terminal",
	tuiMode: "regular",
	fullscreenScrollbar: "auto",
	mermaidRendering: "final",
	reducedMotion: false,
	workingStyle: 3,
	thinkingDisplay: "collapsed",
	thinkingTranslationEndpoint: "",
	wrapCode: false,
	collapseTools: true,
	summarizeSessionTitleOnExit: false,
};
