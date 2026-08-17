import { DEEPSEEK_HARNESS_PERSONA, DEEPSEEK_HARNESS_TOOLS } from "./official.js";

export type DeepSeekHarnessFamily = "pro" | "flash";
export type DeepSeekHarnessPhase = "inactive" | "bootstrap" | "promoted";
export type DeepSeekHarnessPromotion = "either" | "tool-call" | "assistant-message";

export interface DeepSeekModelIdentity {
  provider?: string;
  id?: string;
  name?: string;
}

export interface DeepSeekHarnessSnapshot {
  phase: DeepSeekHarnessPhase;
  family: DeepSeekHarnessFamily | null;
  epoch: number;
  hasAssistant: boolean;
  hasTool: boolean;
}

export interface DeepSeekHistoryEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelToken(value: string): string {
  return value.toLowerCase().replace(/[\s_\-./:]+/g, "");
}

export function matchDeepSeekHarnessModel(
  model: DeepSeekModelIdentity | null | undefined,
): DeepSeekHarnessFamily | undefined {
  if (!model) return undefined;
  const haystack = normalizeModelToken([model.provider, model.id, model.name].filter(Boolean).join(" "));
  if (haystack.includes("deepseekv4pro")) return "pro";
  if (haystack.includes("deepseekv4flash")) return "flash";
  return undefined;
}

function modelKey(model: DeepSeekModelIdentity | null | undefined): string {
  if (!model) return "";
  return normalizeModelToken([model.provider, model.id, model.name].filter(Boolean).join(" "));
}

function hasToolCall(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "toolCall");
}

function isEpochBoundary(type: string | undefined): boolean {
  return type === "compaction" || type === "model_change" || type === "branch_summary";
}

function scanCurrentEpoch(entries: readonly DeepSeekHistoryEntry[]): { hasAssistant: boolean; hasTool: boolean } {
  let boundary = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const type = entries[index]?.type;
    if (isEpochBoundary(type)) boundary = index;
  }
  let hasAssistant = false;
  let hasTool = false;
  for (let index = boundary + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message?.role === "assistant") {
      hasAssistant = true;
      hasTool ||= hasToolCall(entry.message.content);
    } else if (entry.message?.role === "toolResult") {
      hasTool = true;
    }
  }
  return { hasAssistant, hasTool };
}

function isPromoted(
  signals: { hasAssistant: boolean; hasTool: boolean },
  promotion: DeepSeekHarnessPromotion,
): boolean {
  if (promotion === "tool-call") return signals.hasTool;
  if (promotion === "assistant-message") return signals.hasAssistant;
  return signals.hasAssistant || signals.hasTool;
}

export class DeepSeekHarnessState {
  readonly #promotion: DeepSeekHarnessPromotion;
  #modelKey = "";
  #family: DeepSeekHarnessFamily | undefined;
  #epoch = 0;
  #hasAssistant = false;
  #hasTool = false;

  constructor(promotion: DeepSeekHarnessPromotion = "either") {
    this.#promotion = promotion;
  }

  selectModel(model: DeepSeekModelIdentity | null | undefined): DeepSeekHarnessSnapshot {
    const nextKey = modelKey(model);
    if (nextKey !== this.#modelKey) {
      if (this.#modelKey) this.#epoch += 1;
      this.#modelKey = nextKey;
      this.#family = matchDeepSeekHarnessModel(model);
      this.#hasAssistant = false;
      this.#hasTool = false;
    }
    return this.snapshot();
  }

  resume(
    model: DeepSeekModelIdentity | null | undefined,
    entries: readonly DeepSeekHistoryEntry[],
  ): DeepSeekHarnessSnapshot {
    this.#modelKey = modelKey(model);
    this.#family = matchDeepSeekHarnessModel(model);
    const signals = scanCurrentEpoch(entries);
    this.#hasAssistant = signals.hasAssistant;
    this.#hasTool = signals.hasTool;
    this.#epoch = entries.filter((entry) => isEpochBoundary(entry.type)).length;
    return this.snapshot();
  }

  compact(): DeepSeekHarnessSnapshot {
    this.#epoch += 1;
    this.#hasAssistant = false;
    this.#hasTool = false;
    return this.snapshot();
  }

  noteAssistant(options: { hasToolCall?: boolean } = {}): DeepSeekHarnessSnapshot {
    if (!this.#family) return this.snapshot();
    this.#hasAssistant = true;
    this.#hasTool ||= options.hasToolCall === true;
    return this.snapshot();
  }

  noteToolCall(): DeepSeekHarnessSnapshot {
    if (!this.#family) return this.snapshot();
    this.#hasTool = true;
    return this.snapshot();
  }

  rewrite(payload: unknown): unknown {
    return this.snapshot().phase === "bootstrap" ? rewriteDeepSeekBootstrapRequest(payload) : payload;
  }

  snapshot(): DeepSeekHarnessSnapshot {
    const phase = !this.#family
      ? "inactive"
      : isPromoted({ hasAssistant: this.#hasAssistant, hasTool: this.#hasTool }, this.#promotion)
        ? "promoted"
        : "bootstrap";
    return {
      phase,
      family: this.#family ?? null,
      epoch: this.#epoch,
      hasAssistant: this.#hasAssistant,
      hasTool: this.#hasTool,
    };
  }
}

function exactChatCompletionTools(): Record<string, unknown>[] {
  return DEEPSEEK_HARNESS_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters),
    },
  }));
}

function exactAnthropicTools(): Record<string, unknown>[] {
  return DEEPSEEK_HARNESS_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: structuredClone(tool.parameters),
  }));
}

function exactNamedParameterTools(): Record<string, unknown>[] {
  return DEEPSEEK_HARNESS_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
  }));
}

function rewriteTools(tools: unknown): unknown {
  if (Array.isArray(tools)) {
    const first = tools[0];
    if (isRecord(first) && first.type === "function" && isRecord(first.function)) return exactChatCompletionTools();
    if (isRecord(first) && "input_schema" in first) return exactAnthropicTools();
    if (isRecord(first) && typeof first.name === "string" && "parameters" in first) {
      return exactNamedParameterTools();
    }
  }
  return exactChatCompletionTools();
}

const PI_IDENTITY =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export function reanchorDeepSeekPrompt(systemPrompt: string): string {
  const prompt = systemPrompt.replace(/^\uFEFF?[\s\n]*/, "");
  if (prompt.startsWith(DEEPSEEK_HARNESS_PERSONA)) return prompt;
  if (prompt.startsWith(PI_IDENTITY)) return DEEPSEEK_HARNESS_PERSONA + prompt.slice(PI_IDENTITY.length);
  return prompt.length === 0 ? DEEPSEEK_HARNESS_PERSONA : `${DEEPSEEK_HARNESS_PERSONA}\n\n${prompt}`;
}

function rewriteInstructionContent(content: unknown, persona = DEEPSEEK_HARNESS_PERSONA): unknown {
  if (Array.isArray(content)) {
    let replaced = false;
    return content.map((part) => {
      if (replaced || !isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
      replaced = true;
      return { ...part, text: persona };
    });
  }
  return persona;
}

function reanchorInstructionContent(content: unknown): unknown {
  if (typeof content === "string") return reanchorDeepSeekPrompt(content);
  if (!Array.isArray(content)) return content;
  let replaced = false;
  return content.map((part) => {
    if (replaced || !isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    replaced = true;
    return { ...part, text: reanchorDeepSeekPrompt(part.text) };
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

export function isDeepSeekSummaryRequest(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  let system: string | undefined;
  if (typeof payload.system === "string") system = payload.system;
  else if (typeof payload.instructions === "string") system = payload.instructions;
  if (system === undefined && Array.isArray(payload.messages)) {
    const instruction = payload.messages.find(
      (message) => isRecord(message) && (message.role === "system" || message.role === "developer"),
    );
    if (isRecord(instruction)) system = messageText(instruction.content);
  }
  if (system && /context summarization assistant/i.test(system)) return true;
  if (!Array.isArray(payload.messages)) return false;
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message = payload.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = messageText(message.content);
    return text.includes("<conversation>") && (text.includes("</conversation>") || text.includes("<previous-summary>"));
  }
  return false;
}

export function rewriteDeepSeekBootstrapRequest(payload: unknown): unknown {
  if (!isRecord(payload) || isDeepSeekSummaryRequest(payload)) return payload;
  const next: Record<string, unknown> = { ...payload };
  if ("system" in next && (typeof next.system === "string" || Array.isArray(next.system))) {
    next.system = rewriteInstructionContent(next.system);
  }
  if ("instructions" in next && typeof next.instructions === "string") {
    next.instructions = DEEPSEEK_HARNESS_PERSONA;
  }
  if (Array.isArray(next.messages)) {
    let replaced = false;
    next.messages = next.messages.map((message) => {
      if (replaced || !isRecord(message) || (message.role !== "system" && message.role !== "developer")) {
        return message;
      }
      replaced = true;
      return { ...message, content: rewriteInstructionContent(message.content) };
    });
  }
  next.tools = rewriteTools(next.tools);
  return next;
}

export function rewriteDeepSeekPromotedRequest(payload: unknown): unknown {
  if (!isRecord(payload) || isDeepSeekSummaryRequest(payload)) return payload;
  const next: Record<string, unknown> = { ...payload };
  if ("system" in next && (typeof next.system === "string" || Array.isArray(next.system))) {
    next.system = reanchorInstructionContent(next.system);
  }
  if ("instructions" in next && typeof next.instructions === "string") {
    next.instructions = reanchorDeepSeekPrompt(next.instructions);
  }
  if (Array.isArray(next.messages)) {
    let replaced = false;
    next.messages = next.messages.map((message) => {
      if (replaced || !isRecord(message) || (message.role !== "system" && message.role !== "developer")) {
        return message;
      }
      replaced = true;
      return {
        ...message,
        content: reanchorInstructionContent(message.content),
      };
    });
  }
  return next;
}
