import { PRICE_SCHEDULES, priceTokensCny, type TokenPriceSchedule } from "./pricing.js";

export interface CacheSimulationScenario {
  id: "short" | "medium" | "long" | "ultralong";
  label: string;
  initialPromptTokens: number;
  appendedPromptTokens: number;
}

export interface CacheSimulationTurn {
  turn: number;
  event: "cold-start" | "ordinary" | "state-change" | "review-boundary";
  promptTokens: number;
  stablePrefixTokens: number;
  cacheRead: number;
  uncached: number;
  cacheWrite: number;
  output: number;
  repeatedBilledTokens: number;
}

export interface CacheSimulationTrace {
  scenario: CacheSimulationScenario;
  before: CacheSimulationTurn[];
  after: CacheSimulationTurn[];
}

export interface CacheSimulationCost {
  schedule: Readonly<TokenPriceSchedule>;
  applicable: boolean;
  beforeCny: number | null;
  afterCny: number | null;
  savedCny: number | null;
  savedRatio: number | null;
}

export interface CacheHitRateComparison {
  before: { allTurns: number; warmTurns: number; latestTurn: number };
  after: { allTurns: number; warmTurns: number; latestTurn: number };
}

export const CACHE_SIMULATION_SCENARIOS: readonly CacheSimulationScenario[] = Object.freeze([
  { id: "short", label: "短约 4K", initialPromptTokens: 4_096, appendedPromptTokens: 128 },
  { id: "medium", label: "中约 32K", initialPromptTokens: 32_768, appendedPromptTokens: 512 },
  { id: "long", label: "长约 256K", initialPromptTokens: 262_144, appendedPromptTokens: 1_024 },
  { id: "ultralong", label: "超长约 512K", initialPromptTokens: 524_288, appendedPromptTokens: 2_048 },
]);

const OUTPUT_TOKENS_PER_TURN = 512;
const STABLE_PREFIX_BEFORE_DYNAMIC_CAPSULE = 2_048;
const RESET_TURNS = new Set([3, 5]);

export function simulateCacheTrace(scenario: CacheSimulationScenario): CacheSimulationTrace {
  const promptTokens = Array.from(
    { length: 6 },
    (_, index) => scenario.initialPromptTokens + index * scenario.appendedPromptTokens,
  );
  const build = (optimized: boolean): CacheSimulationTurn[] =>
    promptTokens.map((prompt, index) => {
      const turn = index + 1;
      const previousPrompt = promptTokens[index - 1] ?? 0;
      const reset = RESET_TURNS.has(turn);
      const stablePrefixTokens =
        turn === 1 ? 0 : optimized || !reset ? previousPrompt : STABLE_PREFIX_BEFORE_DYNAMIC_CAPSULE;
      return {
        turn,
        event: turn === 1 ? "cold-start" : turn === 3 ? "state-change" : turn === 5 ? "review-boundary" : "ordinary",
        promptTokens: prompt,
        stablePrefixTokens,
        cacheRead: stablePrefixTokens,
        uncached: prompt - stablePrefixTokens,
        cacheWrite: 0,
        output: OUTPUT_TOKENS_PER_TURN,
        repeatedBilledTokens: turn === 1 ? 0 : Math.max(0, previousPrompt - stablePrefixTokens),
      };
    });
  return { scenario, before: build(false), after: build(true) };
}

export function summarizeCacheTurns(turns: readonly CacheSimulationTurn[]) {
  const totals = turns.reduce(
    (sum, turn) => ({
      promptTokens: sum.promptTokens + turn.promptTokens,
      cacheRead: sum.cacheRead + turn.cacheRead,
      uncached: sum.uncached + turn.uncached,
      cacheWrite: sum.cacheWrite + turn.cacheWrite,
      output: sum.output + turn.output,
      repeatedBilledTokens: sum.repeatedBilledTokens + turn.repeatedBilledTokens,
    }),
    { promptTokens: 0, cacheRead: 0, uncached: 0, cacheWrite: 0, output: 0, repeatedBilledTokens: 0 },
  );
  return { ...totals, cacheHitRate: totals.cacheRead / totals.promptTokens };
}

export function compareCacheHitRates(trace: CacheSimulationTrace): CacheHitRateComparison {
  const rates = (turns: readonly CacheSimulationTurn[]) => {
    const latest = turns.at(-1);
    if (!latest) throw new Error("Cache simulation trace must contain at least one turn");
    return {
      allTurns: summarizeCacheTurns(turns).cacheHitRate,
      warmTurns: summarizeCacheTurns(turns.slice(1)).cacheHitRate,
      latestTurn: latest.cacheRead / latest.promptTokens,
    };
  };
  return { before: rates(trace.before), after: rates(trace.after) };
}

export function priceCacheTrace(
  trace: CacheSimulationTrace,
  schedule: Readonly<TokenPriceSchedule>,
): CacheSimulationCost {
  const maxTokens = trace.after.at(-1)?.promptTokens ?? 0;
  if (maxTokens + OUTPUT_TOKENS_PER_TURN > schedule.contextWindow)
    return { schedule, applicable: false, beforeCny: null, afterCny: null, savedCny: null, savedRatio: null };
  const price = (turns: readonly CacheSimulationTurn[]) =>
    turns.reduce(
      (total, turn) =>
        total +
        priceTokensCny(schedule, {
          cacheRead: turn.cacheRead,
          uncached: turn.uncached,
          cacheWrite: turn.cacheWrite,
          output: turn.output,
        }),
      0,
    );
  const beforeCny = price(trace.before);
  const afterCny = price(trace.after);
  return {
    schedule,
    applicable: true,
    beforeCny,
    afterCny,
    savedCny: beforeCny - afterCny,
    savedRatio: beforeCny > 0 ? (beforeCny - afterCny) / beforeCny : 0,
  };
}

const formatInteger = (value: number) => value.toLocaleString("en-US");
const formatRate = (value: number) => `${(value * 100).toFixed(2)}%`;
const formatCny = (value: number | null) => (value === null ? "N/A" : `¥${value.toFixed(4)}`);
const formatOptionalRate = (value: number | null) => (value === null ? "N/A" : formatRate(value));

export function renderCacheSimulationMarkdown(): string {
  const traces = CACHE_SIMULATION_SCENARIOS.map(simulateCacheTrace);
  const schedules = Object.values(PRICE_SCHEDULES);
  const lines = [
    "---",
    "kind: cache-simulation",
    "cycle: C17-prompt-cache-deepseek-adaptation",
    "generated: 2026-08-17",
    "currency: CNY",
    "turns_per_scenario: 6",
    "---",
    "",
    "# Prompt Cache Before/After 确定性模拟",
    "",
    "## 结论",
    "",
    "把每轮变化的 Plan、Goal、Workflow 与 review capsule 从 system prompt 移到按需 `continuity_status` 结果后，T3 状态变化与 T5 review 边界不再破坏早期 request prefix。六轮 All-turn CH 因包含一次冷启动，理论上限约为 5/6 = 83.33%；排除冷启动后，长与超长场景的 Warm-turn CH 为 99.61%，与 DSH 常见的 warm/latest `99%+` 表述处于同一量级。",
    "",
    "## 方法与边界",
    "",
    "- 每档固定 6 turn；T1 为冷启动，T3 改变 Plan/Workflow，T5 进入 review，其余为普通追加。",
    "- Before 的动态 capsule 位于稳定 system 前缀之后；T3/T5 最长公共前缀退回 2,048 tokens。After 的 system prompt 与 tools 不变，`continuity_status` 结果只追加到历史尾部，因此从 T2 起可复用上一请求的完整 prompt。",
    "- Before/After 使用完全相同的 prompt token 和 output trace。`cacheWrite` 固定为 0，因为这是 request-prefix counterfactual，不伪造 Provider 是否执行显式 cache write。",
    "- Cache Hit Rate 使用 Pi 口径 `cacheRead / (input + cacheRead + cacheWrite)`；本 fixture 中 `promptTokens = cacheRead + uncached`。",
    "- `All-turn CH` 包含 T1 冷启动，表示整个固定 workload 的计费结果；`Warm-turn CH` 统计 T2-T6，表示预热后架构表现；`Latest-turn CH` 取稳定的 T6，用于和 recent/latest 指标比较。",
    "- bootstrap、promotion、model switch 与 compaction 会开启新 cache epoch；跨 epoch 的首请求应作为新的 cold start 单列，不能混入 warm `99%+`。",
    "- 重复计费 token 只计 `min(previousPrompt, currentPrompt) - cacheRead`，不把首轮冷启动或新追加尾部算作优化损失。",
    "- 费用按 `PRICE_SCHEDULES` 的人民币/百万 token 逐 bucket 计算；`officialCny` 与 `catalogEstimateCny` 严格分开。输出费用两侧相同，但保留在总价中。",
    "",
    "## Provider-reported 实测",
    "",
    "当前 M1 baseline 来自 235 个有效 assistant 响应：input 592,794、cache read 26,346,304、output 150,605，Session CH 97.7995%，最近 CH 99.3684%，6 次 miss 导致 349,929 个重复计费 token。Provider cost breakdown 为 0，因此 `providerBilledCny` 仍为 unknown。该实测不与下方 counterfactual 合并。",
    "",
    "## 与 DSH `99%+` 的可比口径",
    "",
    "DSH 的具体数字只有在相同 trace、相同 cache epoch 和相同 Provider-reported 口径下才能做严格 A/B。下表不把 DSH 的宣传数字伪装成实测；它展示 VSPi 模拟在 All-turn、Warm-turn 与 Latest-turn 三种口径下为何分别约为 83% 和 99%+。",
    "",
    "| 场景 | Before All-turn | After All-turn | Before Warm-turn | After Warm-turn | After Latest-turn |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const trace of traces) {
    const comparison = compareCacheHitRates(trace);
    lines.push(
      `| ${trace.scenario.label} | ${formatRate(comparison.before.allTurns)} | ${formatRate(comparison.after.allTurns)} | ${formatRate(comparison.before.warmTurns)} | ${formatRate(comparison.after.warmTurns)} | ${formatRate(comparison.after.latestTurn)} |`,
    );
  }
  lines.push("", "## 逐 Turn 请求结构", "");
  for (const trace of traces) {
    lines.push(
      `### ${trace.scenario.label}`,
      "",
      "| Turn | 事件 | Prompt | Before 前缀 | Before cached / uncached / write | After 前缀 | After cached / uncached / write | Output |",
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const [index, before] of trace.before.entries()) {
      const after = trace.after[index];
      if (!after) throw new Error(`After trace is missing turn ${before.turn}`);
      lines.push(
        `| T${before.turn} | ${before.event} | ${formatInteger(before.promptTokens)} | ${formatInteger(before.stablePrefixTokens)} | ${formatInteger(before.cacheRead)} / ${formatInteger(before.uncached)} / ${formatInteger(before.cacheWrite)} | ${formatInteger(after.stablePrefixTokens)} | ${formatInteger(after.cacheRead)} / ${formatInteger(after.uncached)} / ${formatInteger(after.cacheWrite)} | ${formatInteger(before.output)} |`,
      );
    }
    const before = summarizeCacheTurns(trace.before);
    const after = summarizeCacheTurns(trace.after);
    const comparison = compareCacheHitRates(trace);
    lines.push(
      "",
      `汇总：All-turn CH ${formatRate(before.cacheHitRate)} → ${formatRate(after.cacheHitRate)}（+${((after.cacheHitRate - before.cacheHitRate) * 100).toFixed(2)} pp）；Warm-turn CH ${formatRate(comparison.before.warmTurns)} → ${formatRate(comparison.after.warmTurns)}；After Latest-turn CH ${formatRate(comparison.after.latestTurn)}；重复计费 ${formatInteger(before.repeatedBilledTokens)} → ${formatInteger(after.repeatedBilledTokens)} tokens。`,
      "",
    );
  }
  lines.push(
    "## Price schedules 与来源",
    "",
    "单价单位为人民币元/百万 tokens。DeepSeek 新价高峰为北京时间 09:00-12:00、14:00-18:00；其余时段为空闲。`catalogEstimateCny` 不是 Provider 实际账单价。",
    "",
    "| Provider / Model | Provenance | 生效时间 | cached / uncached / write / output | Context | 来源（版本） |",
    "| --- | --- | --- | ---: | ---: | --- |",
  );
  for (const schedule of schedules) {
    lines.push(
      `| ${schedule.provider} / ${schedule.model} | ${schedule.provenance} | ${schedule.effectiveAt} | ${schedule.cacheRead} / ${schedule.uncached} / ${schedule.cacheWrite} / ${schedule.output} | ${formatInteger(schedule.contextWindow)} | ${schedule.source} (${schedule.sourceVersion}) |`,
    );
  }
  lines.push(
    "",
    "## 逐模型人民币费用",
    "",
    "费用包含相同的 output；节省仅来自 T3/T5 避免把历史前缀重新按 uncached 计费。Luna/Sol 的 272K context 无法容纳约 512K fixture，明确标为 N/A。",
    "",
    "| 价格档（来源） | 场景 | Before | After | 节省 | 节省比例 |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );
  for (const schedule of schedules) {
    for (const trace of traces) {
      const cost = priceCacheTrace(trace, schedule);
      lines.push(
        `| ${schedule.id} (${schedule.provenance}) | ${trace.scenario.label} | ${formatCny(cost.beforeCny)} | ${formatCny(cost.afterCny)} | ${formatCny(cost.savedCny)} | ${formatOptionalRate(cost.savedRatio)} |`,
      );
    }
  }
  lines.push(
    "",
    "## 解释限制",
    "",
    "- 这是 payload 结构的确定性反事实模拟，不是 Provider 实际命中承诺。Provider 最小缓存阈值、TTL、路由、显式 cache-write 策略和服务端 eviction 都可能改变实测结果。",
    "- 模型/profile/resource/tool 集合切换与 compaction 是允许的 cache epoch 边界；本 fixture 不把这些必要 reset 算作动态 capsule 回归。",
    "- `catalogEstimateCny` 只用于横向估算，不代表 VSPLab 实际账单。正式账单必须继续显示为 `providerBilledCny: unknown`，直到 Provider 返回可信 cost。",
    "",
    "## 复现",
    "",
    "```bash",
    "npx tsx scripts/cache-simulation.ts",
    "npx vitest run test/cache-simulation.test.ts",
    "```",
    "",
  );
  return lines.join("\n");
}
