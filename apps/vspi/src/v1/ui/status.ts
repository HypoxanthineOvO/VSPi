import { truncateToWidth } from "@moonshot-ai/pi-tui";
import type {
	RuntimeGoalStatus,
	TaskDashboardSnapshot,
} from "../backend/types.js";
import { effortLabel } from "../domain/effort.js";
import type { EffortLevel, UsageSnapshot } from "../domain/types.js";
import { padLine, stripAnsi, visibleWidth } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

export interface RuntimeStatusInput {
	working: boolean;
	tasks: TaskDashboardSnapshot;
	pendingQuestions: number;
	pendingApprovals: number;
	scheduled: number;
	goal?: RuntimeGoalStatus;
}

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
	backend?: string;
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

function activeTaskCount(
	items: readonly { status: string; detached?: boolean }[],
): number {
	return items.filter(
		(item) =>
			(item.status === "queued" || item.status === "running") &&
			item.detached !== false,
	).length;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function runtimeGoalLabel(status: RuntimeGoalStatus): string {
	const labels: Record<RuntimeGoalStatus, string> = {
		active: "执行中",
		paused: "已暂停",
		blocked: "阻塞",
		complete: "已完成",
	};
	return `Goal · ${labels[status]}`;
}

export function renderRuntimeStatus(
	input: RuntimeStatusInput,
	width: number,
	theme: VspiTheme,
): string {
	const agents = activeTaskCount(input.tasks.agents);
	const processes = activeTaskCount(input.tasks.processes);
	const taskQuestions = input.tasks.questions
		.filter((question) => question.status === "running")
		.reduce((total, question) => total + question.questionCount, 0);
	const questions = Math.max(taskQuestions, input.pendingQuestions);
	const approvals = input.pendingApprovals;
	const needsInput = questions + approvals > 0;
	const state = needsInput
		? "Needs input"
		: input.working
			? "Working"
			: agents + processes > 0
				? "Waiting"
				: "Idle";
	const parts = [theme.muted("Runtime"), theme.text(state)];
	const accessories = [
		...(questions > 0 ? [countLabel(questions, "Question")] : []),
		...(approvals > 0 ? [countLabel(approvals, "Approval")] : []),
		...(agents > 0 ? [countLabel(agents, "Agent")] : []),
		...(processes > 0 ? [countLabel(processes, "Process", "Processes")] : []),
		...(input.scheduled > 0 ? [`${input.scheduled} scheduled`] : []),
		...(state === "Waiting" ? ["完成后自动继续"] : []),
	];
	const goal = input.goal === undefined ? undefined : theme.text(runtimeGoalLabel(input.goal));
	const primary = join(parts, " · ", theme);
	if (goal !== undefined && visibleWidth(primary) + visibleWidth(goal) + 1 > width) {
		return padLine(primary, width);
	}
	for (const accessory of accessories) {
		const candidate = join([...parts, theme.text(accessory)], " · ", theme);
		const required =
			visibleWidth(candidate) + (goal === undefined ? 0 : visibleWidth(goal) + 1);
		if (required > width) break;
		parts.push(theme.text(accessory));
	}
	const left = join(parts, " · ", theme);
	if (goal === undefined) return padLine(left, width);
	return `${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(goal))}${goal}`;
}

export function appendRuntimeStatus(
	lines: readonly string[],
	runtime: string,
): string[] {
	return [...lines, runtime];
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

function formatTokens(input: number | null): string {
	if (!isFiniteNumber(input)) return "?";
	if (input < 1000) return input.toString();
	const thousands = input / 1000;
	const formatted =
		thousands >= 1e21
			? formatExponential(thousands)
			: fixedWithoutCarry(thousands, input >= 100_000 ? 0 : 1);
	return `${formatted}k`;
}

export function formatContextTokens(input: number | null): string {
	if (!isFiniteNumber(input)) return "?K";
	const thousands = input / 1000;
	if (input < 10_000 && input % 1000 !== 0)
		return `${Number(fixedWithoutCarry(thousands, 1))}K`;
	if (thousands >= 1e21) return `${formatExponential(thousands)}K`;
	return `${fixedWithoutCarry(thousands, 0)}K`;
}

export function formatContextUsage(
	usage: Pick<
		UsageSnapshot,
		"contextTokens" | "contextWindow" | "contextPercent" | "contextEstimated"
	>,
): string {
	const percent = isFiniteNumber(usage.contextPercent)
		? `${usage.contextPercent}%`
		: "?%";
	const estimate =
		usage.contextEstimated && usage.contextTokens !== null ? "~" : "";
	return `${estimate}${formatContextTokens(usage.contextTokens)} / ${formatContextTokens(usage.contextWindow)} ${percent}`;
}

function fitColumn(
	text: string,
	width: number,
	align: "left" | "right" = "left",
): string {
	if (width <= 0) return "";
	const raw = truncateToWidth(text, width, "…");
	const truncated = text.includes("\u001b") ? raw : stripAnsi(raw);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return align === "right"
		? `${padding}${truncated}`
		: `${truncated}${padding}`;
}

function composeColumns(
	fields: Array<{ start: number; value: string; align?: "left" | "right" }>,
	width: number,
): string | undefined {
	if (fields.length === 0 || fields[0]?.start !== 0) return undefined;
	let output = "";
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		const nextStart = fields[index + 1]?.start ?? width;
		if (field.start < 0 || nextStart <= field.start) return undefined;
		output += fitColumn(field.value, nextStart - field.start, field.align);
	}
	return padLine(output, width);
}

function variableField(
	prefix: string,
	variable: string,
	suffix: string,
	width: number,
	theme: VspiTheme,
): string {
	const available = Math.max(
		0,
		width - visibleWidth(prefix) - visibleWidth(suffix),
	);
	const raw = truncateToWidth(variable, available, "…");
	const fitted = variable.includes("\u001b") ? raw : stripAnsi(raw);
	return `${prefix}${theme.text(fitted)}${suffix}`;
}

function effortField(
	input: StatusLineInput,
	theme: VspiTheme,
	compact = false,
): string {
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
	return join(parts, compact ? " " : " · ", theme);
}

function modelEffortField(
	input: StatusLineInput,
	width: number,
	theme: VspiTheme,
	compact = false,
): string {
	const effort = effortField(input, theme, compact);
	return variableField(
		"",
		input.modelLabel,
		`${theme.muted(" · ")}${effort}${theme.muted(" ")}`,
		width,
		theme,
	);
}

function contextField(
	input: StatusLineInput,
	theme: VspiTheme,
	compact = false,
): string {
	const formatted = compact
		? isFiniteNumber(input.usage.contextPercent) &&
			input.usage.contextPercent <= 999
			? `${input.usage.contextPercent}%`
			: "?%"
		: formatContextUsage(input.usage);
	return `${label("Context", "focus", theme)}${value(formatted, theme)}`;
}

function formatSpeed(value: number | null): string {
	if (!isFiniteNumber(value) || value < 0) return "—";
	if (value < 100) return fixedWithoutCarry(value, 1);
	if (value < 1_000) return fixedWithoutCarry(value, 0);
	return formatTokens(value);
}

function speedField(
	input: StatusLineInput,
	theme: VspiTheme,
	compact = false,
): string {
	const speed = formatSpeed(
		input.usage.throughputNow ?? input.usage.throughputAverage,
	);
	const formatted = compact ? speed : `${speed} tok/s`;
	return `${label("Speed", "blue", theme)}${value(formatted, theme)}`;
}

function pathField(
	input: StatusLineInput,
	width: number,
	statusWidth: number,
	theme: VspiTheme,
): string {
	const mode =
		statusWidth < 120 && input.mode
			? `${theme.muted(" · ")}${theme.blue(input.mode)}`
			: "";
	const policy =
		statusWidth >= 60 && input.policy
			? `${mode}${theme.muted(" · ")}${theme.focus(input.policy)}${theme.muted(" ")}`
			: `${mode}${theme.muted(" ")}`;
	return variableField("", input.cwd, policy, width, theme);
}

function tokenField(
	input: StatusLineInput,
	theme: VspiTheme,
	compact = false,
): string {
	if (compact) {
		const inputOnly = `↑ ${formatTokens(input.usage.inputTokens)}`;
		if (visibleWidth(inputOnly) <= 10) return value(inputOnly, theme);
		return "";
	}
	return value(
		`↑ ${formatTokens(input.usage.inputTokens)}  ↓ ${formatTokens(input.usage.outputTokens)}`,
		theme,
	);
}

function cacheField(
	input: StatusLineInput,
	theme: VspiTheme,
	compact = false,
): string {
	const hit = isFiniteNumber(input.usage.recentCacheHitPercent)
		? `${input.usage.recentCacheHitPercent}%`
		: "—";
	if (compact) return `${label("Cache", "focus", theme)}${value(hit, theme)}`;
	return `${label("CacheΣ", "focus", theme)}${value(`${formatTokens(input.usage.cacheReadTokens)} · ${hit}`, theme)}`;
}

function costField(
	input: StatusLineInput,
	theme: VspiTheme,
	compactAvailable?: number,
): string {
	const cost =
		input.usage.costUsd === null
			? null
			: input.usage.costUsd * input.usage.fxRate;
	const exact = isFiniteNumber(cost) ? `¥${fixedWithoutCarry(cost, 2)}` : "—";
	const rounded = isFiniteNumber(cost) ? `¥${String(Math.round(cost))}` : "—";
	const formatted =
		compactAvailable !== undefined
			? visibleWidth(`Cost ${rounded}`) <= compactAvailable
				? rounded
				: "…"
			: exact;
	return value(formatted, theme);
}

function boundedTrackWidth(
	content: string,
	minimum: number,
	representativeMaximum: number,
): number {
	const current = visibleWidth(content);
	return current <= representativeMaximum
		? Math.max(minimum, current)
		: minimum;
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
	cache: number;
	cost: number;
} {
	if (width >= 80) {
		const speedWidth = boundedTrackWidth(speed, 18, 18);
		const contextWidth = boundedTrackWidth(context, 24, 25);
		const costWidth = boundedTrackWidth(cost, 9, 12);
		const contextStart = width - contextWidth;
		const costStart = width - costWidth;
		const cacheWidth = width >= 120 ? 22 : 11;
		const cacheStart = costStart - cacheWidth;
		return {
			speed: contextStart - speedWidth,
			context: contextStart,
			token: cacheStart - 20,
			cache: cacheStart,
			cost: costStart,
		};
	}
	if (width >= 60)
		return {
			speed: Math.max(20, width - 12),
			context: width,
			token: width - 36,
			cache: width - 18,
			cost: width - 8,
		};
	return { speed: width, context: width, token: 18, cache: 28, cost: 38 };
}

export function renderStatusLines(
	input: StatusLineInput,
	width: number,
	theme: VspiTheme,
): string[] {
	const compact = width < 60;
	const speed = speedField(input, theme, width < 80);
	const context = contextField(input, theme, compact);
	const token = tokenField(input, theme, compact);
	const cache = cacheField(input, theme, width < 120);
	// compact 布局的 Cost 锚点固定为 32（见 tracks），可用宽度随终端实际列数变化。
	const cost = costField(
		input,
		theme,
		compact ? Math.max(0, width - 32) : undefined,
	);
	const columns = tracks(width, speed, context, cost);
	const identityCompact = width < 120;
	const identityFields = [
		{
			start: 0,
			value: modelEffortField(input, columns.speed, theme, identityCompact),
		},
		{ start: columns.speed, value: speed },
		...(columns.context < width
			? [{ start: columns.context, value: context, align: "right" as const }]
			: []),
	];
	const identity = composeColumns(identityFields, width);
	const telemetry = composeColumns(
		[
			{ start: 0, value: pathField(input, columns.token, width, theme) },
			{ start: columns.token, value: token },
			{ start: columns.cache, value: cache },
			{ start: columns.cost, value: cost, align: "right" },
		],
		width,
	);
	return [
		identity ?? padLine(modelEffortField(input, width, theme, compact), width),
		telemetry ?? padLine(pathField(input, width, width, theme), width),
	];
}
