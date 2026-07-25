import { padLine, truncateToWidth } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

export interface ActivityRailInput {
  indicator: string;
  steering: number;
  followUp: number;
}

export function renderActivityRail(input: ActivityRailInput, width: number, theme: VspiTheme): string {
  const queued = input.steering + input.followUp;
  const detail =
    width < 60
      ? queued > 0
        ? ` · 队列 ${queued}`
        : ""
      : [input.steering ? `插入 ${input.steering}` : "", input.followUp ? `后续 ${input.followUp}` : ""]
          .filter(Boolean)
          .map((value) => ` · ${value}`)
          .join("");
  const text = truncateToWidth(
    `${theme.focus("▌")} ${theme.bold("Working")} ${theme.focus(input.indicator)}${detail}`,
    Math.max(1, width),
    "…",
  );
  return theme.activitySurface(padLine(text, width));
}
