export type EffectivePromptSource = "pi-base" | "system" | "append" | "context" | "profile" | "plan";

export interface EffectivePromptSegment {
  source: EffectivePromptSource;
  content: string;
}

export interface EffectivePromptInput {
  piBase: string;
  system?: string | undefined;
  append?: string | string[] | undefined;
  context?: string | string[] | undefined;
  profile?: string | undefined;
  plan?: string | undefined;
  secrets?: string[] | undefined;
}

export function composeEffectivePrompt(input: EffectivePromptInput): {
  segments: EffectivePromptSegment[];
  text: string;
} {
  const rawSegments: EffectivePromptSegment[] = [
    { source: "pi-base", content: input.piBase },
    { source: "system", content: input.system ?? "" },
    { source: "append", content: arrayText(input.append) },
    { source: "context", content: arrayText(input.context) },
    ...(input.profile ? [{ source: "profile" as const, content: input.profile }] : []),
    ...(input.plan ? [{ source: "plan" as const, content: input.plan }] : []),
  ];
  const segments = rawSegments
    .filter((segment) => segment.content.length > 0)
    .map((segment) => ({ ...segment, content: redactPrompt(segment.content, input.secrets ?? []) }));
  return {
    segments,
    text: segments.map((segment) => `[${segment.source}]\n${segment.content}`).join("\n\n"),
  };
}

export function redactPrompt(value: string, secrets: string[] = []): string {
  let redacted = value;
  for (const secret of secrets.filter(Boolean)) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, "$1[REDACTED]");
}

function arrayText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("\n\n") : (value ?? "");
}
