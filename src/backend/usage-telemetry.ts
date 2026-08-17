import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { priceTokensCny, resolveOfficialCnySchedule } from "../domain/pricing.js";

interface AssistantUsageRecord {
  message: object;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  inputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  provider: string;
  model: string;
  timestamp: number | null;
}

export interface CacheTelemetry {
  reported: boolean;
  recentHitPercent: number | null;
  sessionHitPercent: number | null;
  missedTokens: number | null;
  missedCostUsd: number | null;
}

export function calculateCacheTelemetry(options: {
  session: AgentSession | undefined;
  latest: object | undefined;
  totals: { input: number; cacheRead: number; cacheWrite: number };
  catalogCacheReadRate(provider: string, model: string): number | undefined;
}): CacheTelemetry {
  const records = assistantUsageTimeline(options.session, options.latest);
  const reportedModelKeys = new Set(
    records
      .filter((record): record is AssistantUsageRecord => record !== null && record.cacheRead + record.cacheWrite > 0)
      .map(assistantUsageModelKey),
  );
  const reported = options.totals.cacheRead + options.totals.cacheWrite > 0 || reportedModelKeys.size > 0;
  if (!reported) {
    return {
      reported: false,
      recentHitPercent: null,
      sessionHitPercent: null,
      missedTokens: null,
      missedCostUsd: null,
    };
  }
  const latest = [...records].reverse().find((record): record is AssistantUsageRecord => record !== null);
  const latestReported = latest ? reportedModelKeys.has(assistantUsageModelKey(latest)) : false;
  const recentPrompt = latest ? latest.input + latest.cacheRead + latest.cacheWrite : 0;
  const reportedRecords = records.filter(
    (record): record is AssistantUsageRecord =>
      record !== null && reportedModelKeys.has(assistantUsageModelKey(record)),
  );
  const sessionCacheRead = reportedRecords.reduce((total, record) => total + record.cacheRead, 0);
  const sessionPrompt = reportedRecords.reduce(
    (total, record) => total + record.input + record.cacheRead + record.cacheWrite,
    0,
  );
  const effectiveSessionPrompt =
    sessionPrompt || options.totals.input + options.totals.cacheRead + options.totals.cacheWrite;
  const effectiveSessionCacheRead = sessionPrompt ? sessionCacheRead : options.totals.cacheRead;
  let previous: AssistantUsageRecord | undefined;
  let cacheObserved = false;
  let missedTokens = 0;
  let missedCostUsd = 0;
  let missedCostKnown = true;
  for (const record of records) {
    if (!record || !reportedModelKeys.has(assistantUsageModelKey(record))) {
      previous = undefined;
      continue;
    }
    const prompt = record.input + record.cacheRead + record.cacheWrite;
    if (previous && prompt > 0 && (record.cacheRead + record.cacheWrite > 0 || cacheObserved)) {
      const missed = Math.min(previous.input + previous.cacheRead + previous.cacheWrite, prompt) - record.cacheRead;
      if (missed > 1_024) {
        missedTokens += missed;
        const paidTokens = record.input + record.cacheWrite;
        const paidRate = paidTokens > 0 ? (record.inputCost + record.cacheWriteCost) / paidTokens : 0;
        const catalogReadRate = options.catalogCacheReadRate(record.provider, record.model);
        const readRate =
          record.cacheRead > 0
            ? record.cacheReadCost / record.cacheRead
            : typeof catalogReadRate === "number"
              ? catalogCacheRatePerToken(catalogReadRate)
              : undefined;
        if (readRate === undefined || !Number.isFinite(readRate)) missedCostKnown = false;
        else missedCostUsd += missed * Math.max(0, paidRate - readRate);
      }
    }
    cacheObserved ||= record.cacheRead + record.cacheWrite > 0;
    if (prompt > 0) previous = record;
  }
  return {
    reported: true,
    recentHitPercent:
      latestReported && recentPrompt > 0 && latest ? Math.round((latest.cacheRead / recentPrompt) * 100) : null,
    sessionHitPercent:
      effectiveSessionPrompt > 0 ? Math.round((effectiveSessionCacheRead / effectiveSessionPrompt) * 100) : null,
    missedTokens,
    missedCostUsd: missedCostKnown ? missedCostUsd : null,
  };
}

export function calculateOfficialCostCny(session: AgentSession | undefined, latest: object | undefined): number | null {
  let total = 0;
  let priced = false;
  for (const record of assistantUsageTimeline(session, latest)) {
    if (!record) continue;
    const tokenTotal = record.input + record.output + record.cacheRead + record.cacheWrite;
    if (tokenTotal === 0) continue;
    if (record.timestamp === null) return null;
    const schedule = resolveOfficialCnySchedule(record.provider, record.model, record.timestamp);
    if (!schedule) return null;
    total += priceTokensCny(schedule, {
      cacheRead: record.cacheRead,
      uncached: record.input,
      cacheWrite: record.cacheWrite,
      output: record.output,
    });
    priced = true;
  }
  return priced ? total : null;
}

function assistantUsageTimeline(
  session: AgentSession | undefined,
  latest: object | undefined,
): Array<AssistantUsageRecord | null> {
  if (!session) return [];
  const timeline: Array<AssistantUsageRecord | null> = [];
  const seen = new Set<object>();
  const branch = session.sessionManager?.getBranch?.();
  if (branch) {
    for (const entry of branch) {
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        timeline.push(null);
      } else if (entry.type === "message") {
        const record = assistantUsageRecord(entry.message);
        if (record) {
          timeline.push(record);
          seen.add(record.message);
        }
      }
    }
  } else {
    for (const message of session.messages) {
      const record = assistantUsageRecord(message);
      if (record) {
        timeline.push(record);
        seen.add(record.message);
      }
    }
  }
  if (latest && !seen.has(latest)) {
    const record = assistantUsageRecord(latest);
    if (record) timeline.push(record);
  }
  return timeline;
}

function assistantUsageRecord(message: unknown): AssistantUsageRecord | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return undefined;
  const usage = message.usage;
  const cost = isRecord(usage.cost) ? usage.cost : {};
  return {
    message,
    input: finiteNonNegative(usage.input),
    output: finiteNonNegative(usage.output),
    cacheRead: finiteNonNegative(usage.cacheRead),
    cacheWrite: finiteNonNegative(usage.cacheWrite),
    inputCost: finiteNonNegative(cost.input),
    cacheReadCost: finiteNonNegative(cost.cacheRead),
    cacheWriteCost: finiteNonNegative(cost.cacheWrite),
    provider: stringField(message, "provider"),
    model: stringField(message, "model"),
    timestamp:
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp < 1_000_000_000_000
          ? message.timestamp * 1_000
          : message.timestamp
        : null,
  };
}

function assistantUsageModelKey(record: AssistantUsageRecord): string {
  return `${record.provider}/${record.model}`;
}

function catalogCacheRatePerToken(perMillion: number): number {
  return perMillion / 1_000_000;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  return typeof fieldValue === "string" ? fieldValue : "";
}
