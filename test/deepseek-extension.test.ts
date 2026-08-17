import { describe, expect, it, vi } from "vitest";
import { createDeepSeekHarnessExtension } from "../src/deepseek/extension.js";
import { DEEPSEEK_HARNESS_PERSONA } from "../src/deepseek/official.js";

type Handler = (event: never, context: never) => unknown;

function harness(options: Parameters<typeof createDeepSeekHarnessExtension>[0] = {}) {
  const handlers = new Map<string, Handler[]>();
  let activeTools = ["read", "bash", "edit", "write", "continuity_status"];
  const onPhase = vi.fn();
  const registered: string[] = [];
  createDeepSeekHarnessExtension({ ...options, onPhase })({
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools = [...tools];
    },
    registerTool: (tool: { name: string; label?: string }) => {
      registered.push(tool.label ?? tool.name);
    },
  } as never);
  const emit = async (event: string, value: unknown, context: unknown) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler(value as never, context as never);
    return result;
  };
  const context = (model: { provider: string; id: string; name?: string }, entries: unknown[] = []) => ({
    model,
    sessionManager: { buildContextEntries: () => entries, getEntries: () => entries },
  });
  return { emit, context, activeTools: () => activeTools, registered, onPhase };
}

describe("DeepSeek anchored-standard Pi extension", () => {
  it("uses only the two bootstrap tools, then restores the complete host catalog", async () => {
    const h = harness();
    const context = h.context({ provider: "relay", id: "deepseek-v4-pro" });
    await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
    expect(h.activeTools()).toEqual(["bash", "str_replace_editor"]);

    const payload = { instructions: "Pi full prompt", tools: [{ name: "read", parameters: {} }] };
    const first = await h.emit("before_provider_request", { payload }, context);
    expect(first).toMatchObject({ instructions: DEEPSEEK_HARNESS_PERSONA });
    expect((first as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      "bash",
      "str_replace_editor",
    ]);

    await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, context);
    expect(h.activeTools()).toEqual(["read", "bash", "edit", "write", "continuity_status"]);
    const promoted = await h.emit("before_provider_request", { payload }, context);
    expect(promoted).toEqual({ ...payload, instructions: `${DEEPSEEK_HARNESS_PERSONA}\n\nPi full prompt` });
  });

  it("keeps non-DeepSeek and summary requests unchanged and resets after compaction/model switch", async () => {
    const h = harness();
    const other = h.context({ provider: "openai", id: "gpt-5.6" });
    const payload = { instructions: "Pi", tools: [{ name: "read", parameters: {} }] };
    await h.emit("session_start", { type: "session_start", reason: "startup" }, other);
    expect(await h.emit("before_provider_request", { payload }, other)).toBeUndefined();

    const deepseek = h.context({ provider: "deepseek", id: "deepseek-v4-flash" });
    await h.emit("model_select", { model: deepseek.model }, deepseek);
    expect(h.activeTools()).toEqual(["bash", "str_replace_editor"]);
    const summary = {
      system: "You are a context summarization assistant.",
      messages: [{ role: "user", content: "<conversation>x</conversation>" }],
    };
    expect(await h.emit("before_provider_request", { payload: summary }, deepseek)).toBeUndefined();
    await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text" }] } }, deepseek);
    expect(h.activeTools()).toContain("read");
    await h.emit("session_compact", { type: "session_compact" }, deepseek);
    expect(h.activeTools()).toEqual(["bash", "str_replace_editor"]);
  });

  it("promotes immediately on a tool-call signal and preserves tool execution lookup", async () => {
    const h = harness();
    const context = h.context({ provider: "deepseek", id: "deepseek-v4-pro" });
    await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
    await h.emit("tool_call", { toolName: "bash" }, context);
    expect(h.activeTools()).toContain("continuity_status");
  });

  it("restores a promoted phase from persisted history on session bind", async () => {
    const h = harness();
    const context = h.context({ provider: "deepseek", id: "deepseek-v4-pro" }, [
      { type: "model_change" },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "previous" }] } },
    ]);
    await h.emit("session_start", { type: "session_start", reason: "resume" }, context);
    expect(h.activeTools()).toEqual(["read", "bash", "edit", "write", "continuity_status"]);
    expect(h.onPhase).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "promoted", hasAssistant: true }));
  });

  it("installs persistent bash only for bootstrap and restores native bash on promotion/model exit", async () => {
    const resetBash = vi.fn(async () => undefined);
    const h = harness({
      resetBash,
      toolBridge: {
        bootstrapBash: { name: "bash", label: "bootstrap" } as never,
        standardBash: { name: "bash", label: "standard" } as never,
      },
    });
    const deepseek = h.context({ provider: "deepseek", id: "deepseek-v4-pro" });
    await h.emit("session_start", { type: "session_start", reason: "startup" }, deepseek);
    await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text" }] } }, deepseek);
    const other = h.context({ provider: "openai", id: "gpt-5.6" });
    await h.emit("model_select", { model: other.model }, other);

    expect(h.registered).toEqual(["bootstrap", "standard"]);
    expect(resetBash).toHaveBeenCalledOnce();
    expect(h.activeTools()).toContain("read");
  });
});
