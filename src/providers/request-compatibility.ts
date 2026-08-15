import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const REPETITION_BOUNDS = new Set(["minLength", "maxLength", "minItems", "maxItems"]);

/**
 * llama.cpp eagerly expands bounded JSON-schema repetitions into a GBNF grammar. Large tool
 * limits can exceed its parser threshold before inference starts. VSPi retains the authoritative
 * schema for host-side validation and removes only repetition bounds from the wire copy.
 */
export function sanitizeOpenAiToolSchemaBounds(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;

  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) return tool;
    const parameters = tool.function.parameters;
    if (!isRecord(parameters)) return tool;
    const sanitized = stripRepetitionBounds(parameters);
    if (sanitized === parameters) return tool;
    changed = true;
    return { ...tool, function: { ...tool.function, parameters: sanitized } };
  });

  return changed ? { ...payload, tools } : payload;
}

export function createProviderRequestCompatibilityExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event, context) => {
      const model = context.model;
      if (model?.api !== "openai-completions" || !isRecord(model.compat) || model.compat.supportsStrictMode !== false) {
        return undefined;
      }
      return sanitizeOpenAiToolSchemaBounds(event.payload);
    });
  };
}

function stripRepetitionBounds(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const sanitized = stripRepetitionBounds(item);
      if (sanitized !== item) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (REPETITION_BOUNDS.has(key)) {
      changed = true;
      continue;
    }
    const sanitized = stripRepetitionBounds(child);
    if (sanitized !== child) changed = true;
    next[key] = sanitized;
  }
  return changed ? next : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
