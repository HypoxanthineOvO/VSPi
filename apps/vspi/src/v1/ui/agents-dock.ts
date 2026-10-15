import type { AgentRunSnapshot, AgentSnapshot } from "../agents/types.js";
import { frame, truncateToWidth, visibleWidth } from "./ansi.js";
import {
	formatSubagentModel,
	formatSubagentProfile,
} from "./subagent-display.js";
import type { VspiTheme } from "./theme.js";

const MAX_VISIBLE_AGENTS = 4;

export class AgentsDock {
	private readonly visible = new Map<string, AgentRunSnapshot>();

	setSnapshot(snapshot: AgentSnapshot): void {
		const snapshotIds = new Set([
			...snapshot.active.map((run) => run.id),
			...snapshot.recent.map((run) => run.id),
		]);
		for (const id of this.visible.keys()) {
			if (!snapshotIds.has(id)) this.visible.delete(id);
		}
		for (const run of snapshot.active)
			this.visible.set(run.id, structuredClone(run));
		for (const run of snapshot.recent) {
			if (this.visible.has(run.id))
				this.visible.set(run.id, structuredClone(run));
		}
	}

	settle(parentToolCallId?: string): void {
		for (const [id, run] of this.visible) {
			if (
				agentRunTerminal(run.status) &&
				(parentToolCallId === undefined ||
					run.parentToolCallId === parentToolCallId)
			)
				this.visible.delete(id);
		}
	}

	reset(): void {
		this.visible.clear();
	}

	hasActive(): boolean {
		return [...this.visible.values()].some(
			(run) => !agentRunTerminal(run.status),
		);
	}

	render(width: number, theme: VspiTheme, now = Date.now()): string[] {
		// 顺序只由启动时间决定：状态变化（running→success）不再重排行序。
		const runs = [...this.visible.values()].toSorted(
			(left, right) =>
				(Date.parse(left.startedAt ?? "") || 0) -
				(Date.parse(right.startedAt ?? "") || 0),
		);
		if (runs.length === 0) return [];
		const shown = runs.slice(0, MAX_VISIBLE_AGENTS);
		const overflow = runs.length - shown.length;
		const active = runs.filter((run) => !agentRunTerminal(run.status)).length;
		const done = runs.length - active;
		const bodyWidth = Math.max(1, width - 4);
		const identityWidth = Math.min(
			28,
			Math.max(
				...shown.map((run) =>
					visibleWidth(`${run.codename ?? run.agentId} · ${run.taskTitle ?? run.task}`),
				),
			),
		);
		const body = shown.flatMap((run) => [
			renderAgentRow(run, bodyWidth, identityWidth, theme, now),
			...(run.progress
				? [
						theme.muted(
							truncateToWidth(
								`  进度 · ${run.progress.replaceAll(/\s+/gu, " ")}`,
								bodyWidth,
								"…",
							),
						),
					]
				: []),
		]);
		if (overflow > 0)
			body.push(theme.muted(`+${String(overflow)} active · /agents 查看全部`));
		return frame(body, width, theme, {
			title: "Agents",
			rightTitle: `${String(active)} active · ${String(done)} done`,
			maxBodyLines: body.length,
			paddingX: 1,
		});
	}
}

function renderAgentRow(
	run: AgentRunSnapshot,
	width: number,
	identityWidth: number,
	theme: VspiTheme,
	now: number,
): string {
	const symbol =
		run.status === "success"
			? theme.success("✓")
			: run.status === "error" ||
					run.status === "timed_out" ||
					run.status === "lost"
				? theme.error("×")
				: run.status === "cancelled" || run.status === "killed"
					? theme.muted("−")
					: run.status === "queued"
						? theme.muted("○")
						: theme.focus("●");
	const identity = truncateToWidth(
		`${run.codename ?? run.agentId} · ${run.taskTitle ?? run.task}`,
		identityWidth,
		"…",
	);
	const identityCell = `${identity}${" ".repeat(
		Math.max(0, identityWidth - visibleWidth(identity)),
	)}`;
	const model = formatSubagentModel(run.model);
	const elapsed = formatElapsed(run, now);
	const full = `${symbol} ${identityCell}  ${formatSubagentProfile(run.profile)} · ${model} · ${elapsed}`;
	if (visibleWidth(full) <= width) return full;
	const medium = `${symbol} ${identityCell}  ${formatSubagentProfile(run.profile)} · ${elapsed}`;
	if (visibleWidth(medium) <= width) return medium;
	return truncateToWidth(`${symbol} ${identity} · ${elapsed}`, width, "…");
}

function formatElapsed(run: AgentRunSnapshot, now: number): string {
	const start = Date.parse(run.startedAt ?? "");
	if (!Number.isFinite(start)) return run.status;
	const end = Date.parse(run.finishedAt ?? "");
	const seconds = Math.max(
		0,
		Math.floor(((Number.isFinite(end) ? end : now) - start) / 1_000),
	);
	if (seconds < 60) return `${String(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${String(minutes)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function agentRunTerminal(status: AgentRunSnapshot["status"]): boolean {
	return status !== "queued" && status !== "running";
}
