function prettyJson(value: string): string | undefined {
  try {
    let parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    if (parsed === null || typeof parsed !== "object") return undefined;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return undefined;
  }
}

export function formatErrorDetails(text: string): string {
  const trimmed = text.trim();
  const whole = prettyJson(trimmed);
  if (whole) return whole;

  const markerOffsets = Array.from(trimmed.matchAll(/\bdata\s*:\s*/gi), (match) => match.index + match[0].length);
  for (const searchFrom of [...markerOffsets.reverse(), 0]) {
    const starts = [trimmed.indexOf("{", searchFrom), trimmed.indexOf("[", searchFrom)]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    for (const start of starts) {
      const formatted = prettyJson(trimmed.slice(start));
      if (formatted) return `${trimmed.slice(0, start).trimEnd()}\n${formatted}`;
    }
  }
  return text;
}
