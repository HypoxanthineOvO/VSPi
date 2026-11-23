export type ProviderQuotaMode =
	| "off"
	| "auto"
	| "newapi-token"
	| "newapi-account"
	| "cpa";

export type ProviderQuotaApiProfile = "v8" | "v0-compat" | "account" | "token";

export type ProviderQuotaRegion = "cn" | "global";

export interface ProviderQuotaConfig {
	mode?: ProviderQuotaMode;
	apiProfile?: ProviderQuotaApiProfile;
	managementUrl?: string;
	managementKey?: string;
	managementKeyEnv?: string;
	managementKeyRef?: string;
	userId?: string;
	billingMultiplier?: number;
	region?: ProviderQuotaRegion;
	accountFilter?: string[];
}

export type QuotaReadingStatus =
	| "ok"
	| "stale"
	| "auth_error"
	| "network_error"
	| "unconfigured";

export type QuotaErrorReason =
	| "auth_expired"
	| "forbidden"
	| "rate_limited"
	| "timeout"
	| "schema_mismatch"
	| "unsupported"
	| "disabled"
	| "no_credential"
	| "account_unmatched";

export type QuotaCategory = "subscription" | "cpa" | "balance";

export interface QuotaWindowItem {
	id: string;
	label: string;
	remainingPercent: number;
	resetsInMs?: number;
	resetAt?: number;
	modelIds?: string[];
	stale?: boolean;
}

export interface QuotaBalanceItem {
	id: string;
	label?: string;
	currency: string;
	amount: number;
	limit?: number;
	multiplier?: number;
	equivalentAmount?: number;
	unlimited?: boolean;
	stale?: boolean;
}

export interface ProviderQuotaItem {
	id: string;
	providerId: string;
	providerLabel?: string;
	accountLabel?: string;
	upstream?: string;
	category: QuotaCategory;
	status: QuotaReadingStatus;
	errorReason?: QuotaErrorReason;
	errorMessage?: string;
	windows: QuotaWindowItem[];
	balances: QuotaBalanceItem[];
	updatedAt: number | null;
	checkedAt: number;
	stale: boolean;
	freshUntil?: number;
	staleUntil?: number;
}

export interface QuotaQueryOptions {
	providerId?: string;
	includeDisabled?: boolean;
}

export interface QuotaRefreshOptions {
	providerId?: string;
}

export interface QuotaSnapshotResponse {
	items: ProviderQuotaItem[];
	now: number;
	revision: number;
	cooldownRemainingMs?: number;
}

export type ProviderConnectivityCategory =
	| "ok"
	| "config_error"
	| "auth_error"
	| "network_error"
	| "timeout"
	| "protocol_error"
	| "unknown_error";

export type ProviderConnectivityProbeKind =
	| "models"
	| "balance"
	| "account"
	| "offline";

export interface ProviderConnectivityTestResult {
	ok: boolean;
	providerId: string;
	category: ProviderConnectivityCategory;
	durationMs: number;
	httpStatus?: number;
	modelCount?: number;
	probeKind?: ProviderConnectivityProbeKind;
	diagnostic: string;
}

export type WireProtocol =
	| "openai"
	| "openai_responses"
	| "anthropic"
	| "google-genai";

export interface ProviderModelOverridePatch {
	protocol?: WireProtocol;
	maxContextSize?: number;
	displayName?: string;
}

export interface BuiltinModelMetadataView {
	readonly canonical: {
		readonly id: string;
		readonly company: string;
		readonly displayName: string;
	};
	readonly modelId: string;
	readonly displayName: string;
	readonly maxContextSize: number;
	readonly maxOutputSize?: number;
	readonly capabilities: readonly string[];
	readonly thinking: {
		readonly availability?: "none" | "always" | "dynamic";
		readonly canDisable?: boolean;
		readonly controls?: readonly ("toggle" | "effort" | "budget")[];
		readonly efforts?: readonly string[];
		readonly providerEfforts?: Readonly<Record<string, readonly string[]>>;
		readonly defaultEffort?: string;
	};
	readonly defaultProtocol?: WireProtocol;
	readonly pricing?: {
		readonly inputUsdPerMillion: number;
		readonly outputUsdPerMillion: number;
		readonly cacheReadUsdPerMillion?: number;
		readonly cacheWriteUsdPerMillion?: number;
		readonly contextTiers?: readonly {
			readonly contextTokensAbove: number;
			readonly inputUsdPerMillion: number;
			readonly outputUsdPerMillion: number;
		}[];
	};
	readonly pricingSource?: "official" | "provider";
	readonly supportEfforts?: readonly string[];
	readonly defaultEffort?: string;
	readonly effortMapping?: Readonly<Record<string, string | null>>;
	readonly effortProfileRevision?: number;
	readonly adaptiveThinking?: boolean;
	readonly source: "pi-catalog" | "vsplab-catalog" | "effort-profile";
}

export type LookupBuiltinModelMetadataView = (
	modelId: string,
	options?: {
		readonly providerType?: string;
		readonly protocol?: WireProtocol;
		readonly allowRelayFallback?: boolean;
	},
) => BuiltinModelMetadataView | undefined;
