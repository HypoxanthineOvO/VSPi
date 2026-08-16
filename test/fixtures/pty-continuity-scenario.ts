import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { VspiApp } from "../../src/app/vspi-app.js";
import type { AttachmentService } from "../../src/attachments/service.js";
import { PiBackend } from "../../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../../src/domain/fixtures.js";
import { createLocalPlanBackend } from "../../src/plans/local-plan-backend.js";
import type { LocalPlanBackend, StoredPlan } from "../../src/plans/types.js";
import { detectTerminalCapabilities } from "../../src/ui/capabilities.js";
import { ScrollbackProcessTerminal, ScrollbackTUI } from "../../src/ui/scrollback-terminal.js";
import { createTheme } from "../../src/ui/theme.js";

const cwd = process.cwd();
const planStore = createLocalPlanBackend({ rootDir: `${cwd}/.pty-plans` });

class DelayedPlanBackend implements LocalPlanBackend {
  private nextReadDelay = 0;

  delayNextRead(milliseconds: number): void {
    this.nextReadDelay = milliseconds;
  }

  create = planStore.create.bind(planStore);
  list = planStore.list.bind(planStore);
  update = planStore.update.bind(planStore);
  archive = planStore.archive.bind(planStore);

  async read(planId: string): Promise<StoredPlan | undefined> {
    const snapshot = await planStore.read(planId);
    const delay = this.nextReadDelay;
    this.nextReadDelay = 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return snapshot;
  }
}

class ScenarioBackend extends PiBackend {
  private appEvents: ChatBackendEvents | undefined;

  override async start(events: ChatBackendEvents): Promise<void> {
    this.appEvents = events;
    await super.start(events);
  }

  notifyPlanChanged(): void {
    this.appEvents?.onPlanBindingChange?.(this.getPlanBinding());
  }

  showQuestion(): void {
    void this.appEvents?.onQuestion?.([
      {
        id: "pty-question",
        title: "Question spacing",
        prompt: "Verify the interaction gutter",
        kind: "singleChoice",
        options: [{ id: "yes", label: "Continue" }],
      },
    ]);
  }

  override async listSessions() {
    return [
      {
        id: "pty-resume-session",
        label: "PTY Resume Session",
        relativeTime: "刚刚",
        branchDepth: 0,
      },
    ];
  }

  override async switchSession(id: string): Promise<void> {
    this.appEvents?.onSessionReset?.({ id, reason: "resume" });
    for (let index = 0; index < 24; index += 1) {
      this.appEvents?.onMessage({
        id: `resume-history-${index}`,
        role: "assistant",
        kind: "text",
        text: `RESUMED_HISTORY_${index}`,
      });
    }
  }

  override async getModelOptions() {
    return [
      {
        id: "pty-scenario",
        provider: "test",
        brand: "Test",
        label: "PTY Scenario",
        vision: false,
        efforts: ["medium" as const],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        contextWindow: 32_000,
      },
    ];
  }

  async getModelGroups() {
    return [];
  }

  override async getProviderOptions() {
    return [];
  }
}

function assistant(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "pty-scenario",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emitAssistant(emit: (event: AgentSessionEvent) => void, text: string): void {
  const message = assistant(text);
  emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
  } as unknown as AgentSessionEvent);
  emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
  } as unknown as AgentSessionEvent);
  emit({ type: "message_end", message } as unknown as AgentSessionEvent);
}

function scenarioSession(manager: SessionManager): AgentSession {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let continuations = 0;
  const emit = (event: AgentSessionEvent) => listener?.(event);
  const compact = () => {
    emit({ type: "compaction_start", reason: "threshold" });
    emit({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "scenario", firstKeptEntryId: "scenario-entry", tokensBefore: 24_000 },
      aborted: false,
      willRetry: false,
    });
  };
  return {
    model: {
      id: "pty-scenario",
      name: "PTY Scenario",
      provider: "test",
      input: ["text"],
      contextWindow: 32_000,
    },
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    messages: [],
    thinkingLevel: "medium",
    isStreaming: false,
    subscribe(callback: (event: AgentSessionEvent) => void) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    setThinkingLevel() {},
    async prompt() {
      emit({ type: "agent_start" });
      emitAssistant(emit, "BEFORE_COMPACTION_1");
      emit({ type: "agent_end", messages: [], willRetry: false });
      compact();
      await new Promise((resolve) => setImmediate(resolve));
      if (continuations >= 1) {
        emit({ type: "agent_start" });
        emitAssistant(emit, "AFTER_COMPACTION_1");
        emit({ type: "agent_end", messages: [], willRetry: false });
      }
      compact();
      await new Promise((resolve) => setImmediate(resolve));
      if (continuations >= 2) {
        emit({ type: "agent_start" });
        emitAssistant(emit, "AFTER_COMPACTION_2");
        emit({ type: "agent_end", messages: [], willRetry: false });
      }
    },
    async followUp() {
      continuations += 1;
    },
    async steer() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    async abort() {},
    async compact() {
      return {} as never;
    },
    abortCompaction() {},
    getContextUsage: () => ({ tokens: 12_000, contextWindow: 32_000, percent: 38 }),
    getSessionStats: () => ({
      sessionFile: manager.getSessionFile(),
      sessionId: manager.getSessionId(),
      userMessages: 1,
      assistantMessages: 3,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 4,
      tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 },
      cost: 0,
    }),
    dispose() {},
  } as unknown as AgentSession;
}

const planBackend = new DelayedPlanBackend();
let plan = await planBackend.create({
  title: "PLAN_BEFORE_REFRESH",
  goal: "Verify Plan refresh ordering",
  challenges: [],
  items: [{ id: "refresh", title: "Refresh current revision", status: "in_progress" }],
  focusItemId: "refresh",
  blockers: [],
  nextAction: "Wait for mutation",
});
const backend = new ScenarioBackend({
  cwd,
  planBackend,
  sessionFactory: async (manager) => ({ session: scenarioSession(manager) }),
});
const capabilities = detectTerminalCapabilities();
const theme = createTheme(capabilities, "Terminal");
const terminal = new ScrollbackProcessTerminal();
const tui = new ScrollbackTUI(terminal, true);
let closing = false;
const attachments = {
  start: async () => {},
  dispose: async () => {},
} as unknown as AttachmentService;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  tui.stop();
  await app.dispose();
};
const app = new VspiApp(tui, theme, backend, {
  cwd,
  settings: { ...DEFAULT_SETTINGS, reducedMotion: true },
  attachments,
  planBackend,
  onExit: () => void shutdown(),
});
tui.addChild(app);
tui.setFocus(app);
await app.start();
await backend.bindPlan(plan.id);
for (let guard = 0; guard < 100; guard += 1) {
  if ((app as unknown as { planSnapshot?: StoredPlan }).planSnapshot) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (process.env.VSPI_PTY_QUESTION !== "1") app.setStartupSurface(["PTY_SCENARIO_INPUT_READY"]);
tui.start();
if (process.env.VSPI_PTY_QUESTION === "1") setTimeout(() => backend.showQuestion(), 100);

if (process.env.VSPI_PTY_QUESTION !== "1")
  setTimeout(async () => {
    plan = await planBackend.update(plan.id, {
      expectedRevision: plan.revision,
      plan: { ...plan, title: "PLAN_STALE_REFRESH" },
    });
    planBackend.delayNextRead(350);
    backend.notifyPlanChanged();
    setTimeout(async () => {
      plan = await planBackend.update(plan.id, {
        expectedRevision: plan.revision,
        plan: { ...plan, title: "PLAN_LATEST_REFRESH" },
      });
      planBackend.delayNextRead(10);
      backend.notifyPlanChanged();
    }, 30);
  }, 500);

process.once("SIGTERM", () => void shutdown());
process.once("SIGHUP", () => void shutdown());
