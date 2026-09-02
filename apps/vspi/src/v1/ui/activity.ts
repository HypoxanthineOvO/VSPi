import type { TranscriptMessage } from "../domain/types.js";
import { alignRight, padLine, truncateToWidth } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

export interface ActivityRailInput {
	indicator: string;
	label: string;
	elapsedSeconds: number;
	steering: number;
	followUp: number;
}

export interface QueuedMessagePresentation {
	phase: "entering" | "stable" | "settling";
	frame: number;
	reducedMotion: boolean;
}

export function renderActivityRail(
	input: ActivityRailInput,
	width: number,
	theme: VspiTheme,
): string {
	const indicator = theme.focus(theme.bold(input.indicator));
	const queue = [
		input.steering > 0 ? `Steer ${input.steering}` : "",
		input.followUp > 0 ? `Follow-up ${input.followUp}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	const label = [
		theme.bold(input.label),
		theme.muted(formatActivityElapsed(input.elapsedSeconds)),
		queue,
	]
		.filter(Boolean)
		.join(" · ");
	const text = truncateToWidth(
		`${indicator} ${label}`,
		Math.max(1, width),
		"…",
	);
	return padLine(text, width);
}

export function formatActivityElapsed(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	if (hours > 0)
		return `${`${hours}`.padStart(2, "0")}:${`${minutes}`.padStart(2, "0")}:${`${remainder}`.padStart(2, "0")}`;
	return `${`${minutes}`.padStart(2, "0")}:${`${remainder}`.padStart(2, "0")}`;
}

export function renderQueuedMessage(
	message: Extract<TranscriptMessage, { kind: "text" }>,
	width: number,
	theme: VspiTheme,
	presentation: QueuedMessagePresentation,
): string {
	const attachmentText = (message.attachments ?? [])
		.map((attachment) => attachment.alias)
		.join(" · ");
	const content = [
		message.text.replace(/\s+/g, " ").trim(),
		attachmentText,
	]
		.filter(Boolean)
		.join(" · ");
	const label = message.delivery === "followUp" ? "Follow-up" : "Steer";
	const animated =
		!presentation.reducedMotion && presentation.phase !== "stable";
	const marker = animated && presentation.frame % 2 === 0 ? "▐" : "▌";
	const left = `${theme.focus(marker)} ${theme.bold(label)} · ${theme.muted(content)}`;
	const arrow = presentation.phase === "settling" ? "✓" : "↪";
	const right = theme.muted(
		theme.capabilities.unicode
			? arrow
			: presentation.phase === "settling"
				? "+"
				: ">",
	);
	return theme.activitySurface(alignRight(left, right, width));
}
