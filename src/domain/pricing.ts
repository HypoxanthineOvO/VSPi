export type PriceProvenance = "officialCny" | "catalogEstimateCny";

export interface TokenPriceSchedule {
  id: string;
  provider: string;
  model: string;
  currency: "CNY";
  provenance: PriceProvenance;
  source: string;
  sourceVersion: string;
  effectiveAt: string;
  cacheRead: number;
  uncached: number;
  cacheWrite: number;
  output: number;
  contextWindow: number;
}

const schedule = (value: TokenPriceSchedule): Readonly<TokenPriceSchedule> => Object.freeze(value);

export const PRICE_SCHEDULES = Object.freeze({
  deepseekFlashOld: schedule({
    id: "deepseek-v4-flash-old",
    provider: "DeepSeek",
    model: "V4 Flash",
    currency: "CNY",
    provenance: "officialCny",
    source: "DeepSeek official V4 preview announcement image v4-price.png",
    sourceVersion: "2026-04-24",
    effectiveAt: "2026-04-24T00:00:00+08:00",
    cacheRead: 0.2,
    uncached: 1,
    cacheWrite: 1,
    output: 2,
    contextWindow: 1_048_576,
  }),
  deepseekProOld: schedule({
    id: "deepseek-v4-pro-old",
    provider: "DeepSeek",
    model: "V4 Pro",
    currency: "CNY",
    provenance: "officialCny",
    source: "DeepSeek official V4 preview announcement image v4-price.png",
    sourceVersion: "2026-04-24",
    effectiveAt: "2026-04-24T00:00:00+08:00",
    cacheRead: 1,
    uncached: 12,
    cacheWrite: 12,
    output: 24,
    contextWindow: 1_048_576,
  }),
  deepseekFlashIdle: schedule({
    id: "deepseek-v4-flash-idle",
    provider: "DeepSeek",
    model: "V4 Flash (idle)",
    currency: "CNY",
    provenance: "officialCny",
    source: "DeepSeek official V4 260813 Chinese pricing announcement",
    sourceVersion: "2026-08-13",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 0.05,
    uncached: 1.5,
    cacheWrite: 1.5,
    output: 4.5,
    contextWindow: 1_048_576,
  }),
  deepseekFlashPeak: schedule({
    id: "deepseek-v4-flash-peak",
    provider: "DeepSeek",
    model: "V4 Flash (peak)",
    currency: "CNY",
    provenance: "officialCny",
    source: "DeepSeek official V4 260813 Chinese pricing announcement",
    sourceVersion: "2026-08-13",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 0.1,
    uncached: 3,
    cacheWrite: 3,
    output: 9,
    contextWindow: 1_048_576,
  }),
  deepseekProIdle: schedule({
    id: "deepseek-v4-pro-idle",
    provider: "DeepSeek",
    model: "V4 Pro (idle)",
    currency: "CNY",
    provenance: "officialCny",
    source: "DeepSeek official V4 260813 Chinese pricing announcement",
    sourceVersion: "2026-08-13",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 0.15,
    uncached: 4.5,
    cacheWrite: 4.5,
    output: 13.5,
    contextWindow: 1_048_576,
  }),
  deepseekProPeak: schedule({
    id: "deepseek-v4-pro-peak",
    provider: "DeepSeek",
    model: "V4 Pro (peak)",
    currency: "CNY",
    provenance: "officialCny",
    source: "DeepSeek official V4 260813 Chinese pricing announcement",
    sourceVersion: "2026-08-13",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 0.3,
    uncached: 9,
    cacheWrite: 9,
    output: 27,
    contextWindow: 1_048_576,
  }),
  kimiK3: schedule({
    id: "kimi-k3",
    provider: "Kimi",
    model: "K3",
    currency: "CNY",
    provenance: "officialCny",
    source: "Kimi official pricing page",
    sourceVersion: "2026-08-17 snapshot",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 2,
    uncached: 20,
    cacheWrite: 20,
    output: 100,
    contextWindow: 1_048_576,
  }),
  glm52: schedule({
    id: "glm-5.2",
    provider: "OpenCode Go",
    model: "GLM 5.2",
    currency: "CNY",
    provenance: "catalogEstimateCny",
    source: "OpenCode Go models.dev USD catalog converted at USD/CNY 6.80",
    sourceVersion: "sst/models.dev@de7194b4ec",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 1.768,
    uncached: 9.52,
    cacheWrite: 9.52,
    output: 29.92,
    contextWindow: 1_048_576,
  }),
  luna56: schedule({
    id: "gpt-5.6-luna",
    provider: "VSPLab catalog",
    model: "GPT-5.6 Luna",
    currency: "CNY",
    provenance: "catalogEstimateCny",
    source: "Pi 0.84.2 openai-codex USD catalog converted at USD/CNY 6.80",
    sourceVersion: "0.84.2 / 2026-08-17 snapshot",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 0.136,
    uncached: 1.36,
    cacheWrite: 1.7,
    output: 8.16,
    contextWindow: 272_000,
  }),
  terra56: schedule({
    id: "gpt-5.6-terra",
    provider: "VSPLab catalog",
    model: "GPT-5.6 Terra",
    currency: "CNY",
    provenance: "catalogEstimateCny",
    source: "Pi 0.84.3 openai-codex USD catalog converted at USD/CNY 6.80",
    sourceVersion: "0.84.3 / 2026-08-28 snapshot",
    effectiveAt: "2026-08-28T00:00:00+08:00",
    cacheRead: 1.36,
    uncached: 13.6,
    cacheWrite: 17,
    output: 81.6,
    contextWindow: 272_000,
  }),
  sol56: schedule({
    id: "gpt-5.6-sol",
    provider: "VSPLab catalog",
    model: "GPT-5.6 Sol",
    currency: "CNY",
    provenance: "catalogEstimateCny",
    source: "Pi 0.84.2 openai-codex USD catalog converted at USD/CNY 6.80",
    sourceVersion: "0.84.2 / 2026-08-17 snapshot",
    effectiveAt: "2026-08-17T00:00:00+08:00",
    cacheRead: 3.4,
    uncached: 34,
    cacheWrite: 42.5,
    output: 204,
    contextWindow: 272_000,
  }),
});

const NEW_DEEPSEEK_PRICING_AT = Date.parse("2026-08-17T00:00:00+08:00");

export function resolveOfficialCnySchedule(
  provider: string,
  model: string,
  timestamp: number,
): Readonly<TokenPriceSchedule> | undefined {
  const key = `${provider}/${model}`.toLowerCase();
  // VSPLab 复合目录里 Kimi 家族模型 id 不带 "kimi" 前缀（如 vsplab/k3），用 /k3 前缀兜底命中官方牌价。
  if (key.includes("kimi") || key.includes("/k3")) {
    return key.includes("k3") ? PRICE_SCHEDULES.kimiK3 : undefined;
  }
  if (!key.includes("deepseek")) return undefined;
  const family = key.includes("flash") ? "flash" : key.includes("pro") ? "pro" : undefined;
  if (!family) return undefined;
  if (timestamp < NEW_DEEPSEEK_PRICING_AT)
    return family === "flash" ? PRICE_SCHEDULES.deepseekFlashOld : PRICE_SCHEDULES.deepseekProOld;
  const chinaHour = new Date(timestamp + 8 * 60 * 60 * 1_000).getUTCHours();
  const peak = (chinaHour >= 9 && chinaHour < 12) || (chinaHour >= 14 && chinaHour < 18);
  if (family === "flash") return peak ? PRICE_SCHEDULES.deepseekFlashPeak : PRICE_SCHEDULES.deepseekFlashIdle;
  return peak ? PRICE_SCHEDULES.deepseekProPeak : PRICE_SCHEDULES.deepseekProIdle;
}

export function resolveKnownCnySchedule(
  provider: string,
  model: string,
  timestamp: number,
): Readonly<TokenPriceSchedule> | undefined {
  const official = resolveOfficialCnySchedule(provider, model, timestamp);
  if (official) return official;

  const id = normalizeModelPriceId(model);
  if (id === "glm-5.2") return PRICE_SCHEDULES.glm52;
  if (id === "gpt-5.6-luna") return PRICE_SCHEDULES.luna56;
  if (id === "gpt-5.6-terra") return PRICE_SCHEDULES.terra56;
  if (id === "gpt-5.6-sol") return PRICE_SCHEDULES.sol56;
  return undefined;
}

function normalizeModelPriceId(model: string): string {
  return model
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "")
    .replace(/-+/g, "-");
}

export function priceTokensCny(
  schedule: Readonly<TokenPriceSchedule>,
  tokens: { cacheRead: number; uncached: number; cacheWrite: number; output: number },
): number {
  return (
    (tokens.cacheRead * schedule.cacheRead +
      tokens.uncached * schedule.uncached +
      tokens.cacheWrite * schedule.cacheWrite +
      tokens.output * schedule.output) /
    1_000_000
  );
}

export function catalogSnapshotIsStale(asOf: string, now: number, maxAgeDays = 30): boolean {
  const timestamp = Date.parse(asOf);
  return !Number.isFinite(timestamp) || now - timestamp > maxAgeDays * 24 * 60 * 60 * 1_000;
}
