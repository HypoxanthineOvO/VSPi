import type { TranscriptMessage } from "../domain/types.js";
import { alignRight, padLine, truncateToWidth } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

export interface ActivityRailInput {
  indicator: string;
  steering: number;
  followUp: number;
}

export function renderActivityRail(input: ActivityRailInput, width: number, theme: VspiTheme): string {
  const text = truncateToWidth(`${theme.bold("Working")} ${theme.muted(input.indicator)}`, Math.max(1, width), "…");
  return padLine(text, width);
}

export function renderQueuedMessage(
  message: Extract<TranscriptMessage, { kind: "text" }>,
  width: number,
  theme: VspiTheme,
): string {
  const attachmentText = (message.attachments ?? []).map((attachment) => attachment.alias).join(" · ");
  const content = [message.text.replace(/\s+/g, " ").trim(), attachmentText].filter(Boolean).join(" · ");
  const left = `${theme.focus("▌")} ${theme.muted(content)}`;
  const right = theme.muted(theme.capabilities.unicode ? "↪" : ">");
  return theme.activitySurface(alignRight(left, right, width));
}
