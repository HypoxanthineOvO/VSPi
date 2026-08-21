import { truncateToWidth } from "@earendil-works/pi-tui";
import { effortLabel } from "../domain/effort.js";
import type { EffortLevel, UsageSnapshot } from "../domain/types.js";
import { padLine, stripAnsi, visibleWidth } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

export interface StatusLineInput {
  cwd: string;
  usage: UsageSnapshot;
  modelLabel: string;
  effort: EffortLevel;
  busy: boolean;
  working?: {
    indicator: string;
    steering: number;
    followUp: number;
  };
  mode?: string;
  backend?: "Pi" | "Fixture";
  policy?: string;
  boundary?: "Sandboxed" | "Host";
}

type LabelStyle = "focus" | "blue" | "warning";

function label(value: string, style: LabelStyle, theme: VspiTheme): string {
  return `${theme[style](value)} `;
}

function value(text: string, theme: VspiTheme): string {
  return theme.text(text);
}

function join(parts: string[], separator: string, theme: VspiTheme): string {
  return parts.join(theme.muted(separator));
}

function isFiniteNumber(input: number | null): input is number {
  return input !== null && Number.isFinite(input);
}

function formatExponential(input: number): string {
  return input
    .toExponential(2)
    .replace(/\.0+e/, "e")
    .replace(/(\.\d*?[1-9])0+e/, "$1e");
}

// 临界值不允许四舍五入进位升档（999.95 → 999.9 而不是 1000），否则显示宽度会突破状态栏列宽预算。
function fixedWithoutCarry(value: number, decimals: number): string {
  const rounded = value.toFixed(decimals);
  const factor = 10 ** decimals;
  const floored = (Math.floor(value * factor) / factor).toFixed(decimals);
  return rounded.length > floored.length ? floored : rounded;
}

function formatTokens(input: number): string {
  if (!isFiniteNumber(input)) return "?";
  if (input < 1000) return input.toString();
  const thousands = input / 1000;
  const formatted =
    thousands >= 1e21 ? formatExponential(thousands) : fixedWithoutCarry(thousands, input >= 10_000 ? 0 : 1);
  return `${formatted}k`;
}

export function formatContextTokens(input: number | null): string {
  if (!isFiniteNumber(input)) return "?K";
  const thousands = input / 1000;
  if (input < 10_000 && input % 1000 !== 0) return `${Number(fixedWithoutCarry(thousands, 1))}K`;
  if (thousands >= 1e21) return `${formatExponential(thousands)}K`;
  return `${fixedWithoutCarry(thousands, 0)}K`;
}

export function formatContextUsage(
  usage: Pick<UsageSnapshot, "contextTokens" | "contextWindow" | "contextPercent" | "contextEstimated">,
): string {
  const percent = isFiniteNumber(usage.contextPercent) ? `${usage.contextPercent}%` : "?%";
  const estimate = usage.contextEstimated && usage.contextTokens !== null ? "~" : "";
  return `${estimate}${formatContextTokens(usage.contextTokens)} / ${formatContextTokens(usage.contextWindow)} ${percent}`;
}

function fitColumn(text: string, width: number): string {
  if (width <= 0) return "";
  const raw = truncateToWidth(text, width, "…");
  const truncated = text.includes("\u001b") ? raw : stripAnsi(raw);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function composeColumns(fields: Array<{ start: number; value: string }>, width: number): string | undefined {
  if (fields.length === 0 || fields[0]?.start !== 0) return undefined;
  let output = "";
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const nextStart = fields[index + 1]?.start ?? width;
    if (field.start < 0 || nextStart <= field.start) return undefined;
    output += fitColumn(field.value, nextStart - field.start);
  }
  return padLine(output, width);
}

function variableField(prefix: string, variable: string, suffix: string, width: number, theme: VspiTheme): string {
  const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
  const raw = truncateToWidth(variable, available, "…");
  const fitted = variable.includes("\u001b") ? raw : stripAnsi(raw);
  return `${prefix}${theme.text(fitted)}${suffix}`;
}

function effortField(input: StatusLineInput, theme: VspiTheme, compact = false): string {
  const parts = [value(effortLabel(input.effort), theme)];
  if (input.busy) {
    if (input.working) {
      const queued = input.working.steering + input.working.followUp;
      const working = compact
        ? `W${input.working.indicator}${queued > 0 ? queued : ""}`
        : [
            `Working ${input.working.indicator}`,
            input.working.steering ? `插入 ${input.working.steering}` : "",
            input.working.followUp ? `后续 ${input.working.followUp}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
      parts.push(theme.warning(working));
    } else if (!compact) {
      parts.push(theme.warning("生成中"));
    }
  }
  if (!compact && input.mode) parts.push(theme.blue(input.mode));
  return `${label("Effort", "warning", theme)}${join(parts, compact ? " " : " · ", theme)}`;
}

function modelEffortField(input: StatusLineInput, width: number, theme: VspiTheme, compact = false): string {
  const prefix = label("Model", "blue", theme);
  const effort = effortField(input, theme, compact);
  const separator = theme.muted("  ");
  return variableField(prefix, input.modelLabel, `${separator}${effort}${theme.muted(" ")}`, width, theme);
}

function contextField(input: StatusLineInput, theme: VspiTheme, compact = false): string {
  const formatted = compact
    ? isFiniteNumber(input.usage.contextPercent) && input.usage.contextPercent <= 999
      ? `${input.usage.contextPercent}%`
      : "?%"
    : formatContextUsage(input.usage);
  return `${label("Context", "focus", theme)}${value(formatted, theme)}`;
}

function formatSpeed(value: number | null): string {
  if (!isFiniteNumber(value) || value < 0) return "—";
  if (value < 10) return fixedWithoutCarry(value, 1);
  if (value < 1_000) return fixedWithoutCarry(value, 0);
  return formatTokens(value);
}

function speedField(input: StatusLineInput, theme: VspiTheme, compact = false): string {
  // C19 P0-6：Speed 只显示平均吞吐；瞬时值不再展示。
  const average = formatSpeed(input.usage.throughputAverage);
  const formatted = compact ? average : `${average}t/s`;
  return `${label("Speed", "blue", theme)}${value(formatted, theme)}`;
}

function pathField(input: StatusLineInput, width: number, statusWidth: number, theme: VspiTheme): string {
  const mode = statusWidth < 120 && input.mode ? `${theme.muted(" · ")}${theme.blue(input.mode)}` : "";
  const policy =
    statusWidth >= 80 && input.policy && input.boundary
      ? `${mode}${theme.muted(" · Policy ")}${theme.focus(input.policy)}${theme.muted(" · ")}${theme.blue(input.boundary)}${theme.muted(" ")}`
      : `${mode}${theme.muted(" ")}`;
  return variableField("", input.cwd, policy, width, theme);
}

function tokenField(input: StatusLineInput, theme: VspiTheme, compact = false, showHitRate = false): string {
  if (compact) {
    // 40 列允许省略 Token 输出；连输入也放不下时整体省略 Token，不用 "?" 冒充未知值。
    const inputOnly = `↑${formatTokens(input.usage.inputTokens)}`;
    if (visibleWidth(`Token ${inputOnly}`) <= 12) return `${label("Token", "blue", theme)}${value(inputOnly, theme)}`;
    return "";
  }
  const both = `↑${formatTokens(input.usage.inputTokens)} ↓${formatTokens(input.usage.outputTokens)}`;
  // C19 P0-6：Cache Hit Rate（最近请求口径）并入 Token 行；仅 ≥120 列展示，避免 80 列挤掉 cwd。
  if (!showHitRate) return `${label("Token", "blue", theme)}${value(both, theme)}`;
  const cacheHit = isFiniteNumber(input.usage.recentCacheHitPercent) ? `${input.usage.recentCacheHitPercent}%` : "—";
  return `${label("Token", "blue", theme)}${value(`${both} Hit Rate: ${cacheHit}`, theme)}`;
}

function costField(input: StatusLineInput, theme: VspiTheme, compactAvailable?: number): string {
  const cost = input.usage.costUsd * input.usage.fxRate;
  const exact = `¥${isFiniteNumber(cost) ? fixedWithoutCarry(cost, 2) : "?"}`;
  const rounded = `¥${isFiniteNumber(cost) ? Math.round(cost) : "?"}`;
  const formatted =
    compactAvailable !== undefined ? (visibleWidth(`Cost ${rounded}`) <= compactAvailable ? rounded : "…") : exact;
  return `${label("Cost", "warning", theme)}${value(formatted, theme)}`;
}

function boundedTrackWidth(content: string, minimum: number, representativeMaximum: number): number {
  const current = visibleWidth(content);
  return current <= representativeMaximum ? Math.max(minimum, current) : minimum;
}

function tracks(
  width: number,
  speed: string,
  context: string,
  cost: string,
): {
  speed: number;
  context: number;
  token: number;
  cost: number;
} {
  if (width >= 80) {
    // C19 P0-6：Speed 只剩平均值（列变窄），Token 行并入 Hit Rate（列变宽）。
    const speedWidth = boundedTrackWidth(speed, width >= 120 ? 16 : 12, width >= 120 ? 16 : 12);
    const contextWidth = boundedTrackWidth(context, 24, 25);
    const costWidth = boundedTrackWidth(cost, 10, 13);
    const contextStart = width - contextWidth;
    const costStart = width - costWidth;
    return {
      speed: contextStart - speedWidth,
      context: contextStart,
      // 120 列 Token 行并入 Hit Rate 后最长需 32 列（Token ↑999k ↓999k Hit Rate: 100%），
      // 预留 34 避免命中率尾数被 Cost 锚点截断；80 列维持 18 宽以保住 cwd。
      token: costStart - (width >= 120 ? 34 : 18),
      cost: costStart,
    };
  }
  if (width >= 60) return { speed: Math.max(20, width - 22), context: width, token: width - 28, cost: width - 10 };
  return { speed: 25, context: width, token: 20, cost: 32 };
}

export function renderStatusLines(input: StatusLineInput, width: number, theme: VspiTheme): string[] {
  const compact = width < 60;
  const speed = speedField(input, theme, width < 120);
  const context = contextField(input, theme, compact);
  const token = tokenField(input, theme, compact, width >= 120);
  // compact 布局的 Cost 锚点固定为 32（见 tracks），可用宽度随终端实际列数变化。
  const cost = costField(input, theme, compact ? Math.max(0, width - 32) : undefined);
  const columns = tracks(width, speed, context, cost);
  const identityCompact = width < 120;
  const identityFields = [
    { start: 0, value: modelEffortField(input, columns.speed, theme, identityCompact) },
    { start: columns.speed, value: speed },
    ...(columns.context < width ? [{ start: columns.context, value: context }] : []),
  ];
  const identity = composeColumns(identityFields, width);
  const telemetry = composeColumns(
    [
      { start: 0, value: pathField(input, columns.token, width, theme) },
      { start: columns.token, value: token },
      { start: columns.cost, value: cost },
    ],
    width,
  );
  return [
    identity ?? padLine(modelEffortField(input, width, theme, compact), width),
    telemetry ?? padLine(pathField(input, width, width, theme), width),
  ];
}
