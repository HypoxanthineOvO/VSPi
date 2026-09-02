export interface LocalEnvironment {
  currentDate: string;
  timezone: string;
}

export function resolveLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function resolveLocalEnvironment(
  now: Date = new Date(),
  timezone: string = resolveLocalTimezone(),
): LocalEnvironment {
  return {
    currentDate: formatDateParts(now, timezone, "-"),
    timezone,
  };
}

export function formatLocalDate(value: string | Date, timezone: string = resolveLocalTimezone()): string | undefined {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.valueOf()) ? undefined : formatDateParts(date, timezone, "/", false);
}

export function formatLocalTimestamp(
  value: string | Date,
  timezone: string = resolveLocalTimezone(),
): string | undefined {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) return undefined;
  const parts = dateParts(date, timezone, true);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatLocalTime(value: string | Date, timezone: string = resolveLocalTimezone()): string | undefined {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) return undefined;
  const parts = dateParts(date, timezone, true, true);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatDateParts(date: Date, timezone: string, separator: string, includeYear = true): string {
  const parts = dateParts(date, timezone, false);
  return includeYear
    ? `${parts.year}${separator}${parts.month}${separator}${parts.day}`
    : `${parts.month}${separator}${parts.day}`;
}

function dateParts(date: Date, timezone: string, includeTime: boolean, includeSeconds = false): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime
      ? {
          hour: "2-digit",
          minute: "2-digit",
          ...(includeSeconds ? { second: "2-digit" } : {}),
          hourCycle: "h23" as const,
        }
      : {}),
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}
