import type { createBashToolDefinition, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  DeepSeekHarnessState,
  type DeepSeekHistoryEntry,
  reanchorDeepSeekPrompt,
  rewriteDeepSeekBootstrapRequest,
  rewriteDeepSeekPromotedRequest,
} from "./harness.js";

const BOOTSTRAP_TOOLS = ["bash", "str_replace_editor"];

export interface DeepSeekToolBridge {
  bootstrapBash?: ReturnType<typeof createBashToolDefinition>;
  standardBash?: ReturnType<typeof createBashToolDefinition>;
}

export function createDeepSeekHarnessExtension(
  options: {
    toolBridge?: DeepSeekToolBridge;
    resetBash?(): Promise<void> | void;
    onPhase?(phase: ReturnType<DeepSeekHarnessState["snapshot"]>): void;
  } = {},
): ExtensionFactory {
  return (pi) => {
    const state = new DeepSeekHarnessState();
    let surface: "inactive" | "bootstrap" | "promoted" = "inactive";
    let previousTools: string[] | undefined;

    const syncTools = () => {
      const snapshot = state.snapshot();
      if (snapshot.phase === "bootstrap") {
        if (surface !== "bootstrap") {
          if (options.toolBridge?.bootstrapBash) pi.registerTool(options.toolBridge.bootstrapBash);
          previousTools = pi.getActiveTools().filter((name) => name !== "str_replace_editor");
        }
        pi.setActiveTools([...BOOTSTRAP_TOOLS]);
      } else if (surface === "bootstrap") {
        if (options.toolBridge?.standardBash) pi.registerTool(options.toolBridge.standardBash);
        pi.setActiveTools(
          previousTools && previousTools.length > 0 ? previousTools : ["read", "bash", "edit", "write"],
        );
      }
      surface = snapshot.phase;
      options.onPhase?.(snapshot);
    };

    pi.on("session_start", (_event, context) => {
      state.resume(context.model, sessionEntries(context));
      syncTools();
    });
    pi.on("model_select", async (event) => {
      await options.resetBash?.();
      state.selectModel(event.model);
      syncTools();
    });
    pi.on("session_compact", () => {
      state.compact();
      syncTools();
    });
    pi.on("session_tree", (_event, context) => {
      state.resume(context.model, sessionEntries(context));
      syncTools();
    });
    pi.on("session_shutdown", async () => {
      await options.resetBash?.();
    });
    pi.on("before_agent_start", (event, context) => {
      state.selectModel(context.model);
      syncTools();
      if (state.snapshot().phase !== "promoted") return undefined;
      return { systemPrompt: reanchorDeepSeekPrompt(event.systemPrompt) };
    });
    pi.on("message_end", (event) => {
      if (isAssistantMessage(event.message)) {
        state.noteAssistant({ hasToolCall: event.message.content.some(isToolCall) });
        syncTools();
      }
    });
    pi.on("tool_call", () => {
      state.noteToolCall();
      syncTools();
    });
    pi.on("before_provider_request", (event, context) => {
      state.selectModel(context.model);
      syncTools();
      const phase = state.snapshot().phase;
      const rewritten =
        phase === "bootstrap"
          ? rewriteDeepSeekBootstrapRequest(event.payload)
          : phase === "promoted"
            ? rewriteDeepSeekPromotedRequest(event.payload)
            : event.payload;
      return rewritten === event.payload ? undefined : rewritten;
    });
  };
}

function sessionEntries(context: ExtensionContext): DeepSeekHistoryEntry[] {
  try {
    return context.sessionManager.buildContextEntries() as DeepSeekHistoryEntry[];
  } catch {
    return context.sessionManager.getEntries() as DeepSeekHistoryEntry[];
  }
}

function isAssistantMessage(value: unknown): value is { role: "assistant"; content: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "assistant" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isToolCall(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "toolCall";
}
