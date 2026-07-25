import { EFFORT_LEVELS, type EffortLevel } from "./types.js";

const LEGACY_EFFORTS: Record<string, EffortLevel> = {
  低: "low",
  中: "medium",
  高: "high",
};

export function normalizeEffortLevel(value: unknown, fallback: EffortLevel = "medium"): EffortLevel {
  if (typeof value !== "string") return fallback;
  if ((EFFORT_LEVELS as readonly string[]).includes(value)) return value as EffortLevel;
  return LEGACY_EFFORTS[value] ?? fallback;
}

export function effortLabel(level: EffortLevel): string {
  if (level === "xhigh") return "X-High";
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

export function modelEffortLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<EffortLevel, string | null>>;
}): EffortLevel[] {
  if (!model.reasoning) return ["off"];
  return EFFORT_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}
