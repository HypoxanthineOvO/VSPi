import { randomUUID } from "node:crypto";
import { startUiAfterSplash } from "../src/app/startup.js";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents, SendOptions, SendResult } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/defaults.js";
import type { Question, SessionOption, TextMessage } from "../src/domain/types.js";
import { applySettingsToCapabilities, detectTerminalCapabilities } from "../src/ui/capabilities.js";
import { ScrollbackProcessTerminal, ScrollbackTUI } from "../src/ui/scrollback-terminal.js";
import { createTheme } from "../src/ui/theme.js";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

class MockAttachments {
  sessionGeneration = 0;
  readonly store = { list: () => [] };

  async start(): Promise<void> {}
  async dispose(): Promise<void> {}

  async switchSession(): Promise<void> {
    this.sessionGeneration += 1;
    await delay(process.env.VSPI_TERMINAL_MOCK_TRACE === "1" ? 15 : 180);
  }
}

class TerminalMockBackend implements ChatBackend {
  readonly kind = "fixture" as const;
  readonly modelLabel = "Mock Deterministic";
  readonly modelId = "mock-deterministic";
  readonly modelProvider = "mock";
  readonly supportsVision = false;
  private events: ChatBackendEvents | undefined;
  private generation = 0;
  private responseNumber = 0;
  private sessionId = "mock-startup";

  async start(events: ChatBackendEvents): Promise<void> {
    this.events = events;
    events.onSessionReset?.({ id: this.sessionId, reason: "startup" });
    events.onUsage({ ...DEFAULT_USAGE, contextWindow: 128_000 });
  }

  async send(text: string, _options: SendOptions): Promise<SendResult> {
    const events = this.requireEvents();
    const generation = ++this.generation;
    const responseNumber = ++this.responseNumber;
    events.onBusy(true);
    const normalized = text.trim().toLowerCase();
    if (normalized.startsWith("mock question")) {
      const mode = normalized.slice("mock question".length).trim();
      const question: Question =
        mode === "multi"
          ? {
              id: `mock-question-${responseNumber}`,
              title: "Multi-choice Question",
              prompt: "Choose every signal that should remain visible",
              kind: "multiChoice",
              options: [
                { id: "context", label: "Context", description: "Preserve the active task context" },
                { id: "cost", label: "Cost", description: "Keep token and cost telemetry available" },
                { id: "status", label: "Status", description: "Retain the fixed two-line Status footprint" },
              ],
            }
          : mode === "ranking"
            ? {
                id: `mock-question-${responseNumber}`,
                title: "Ranking Question",
                prompt: "Rank the interface priorities",
                kind: "ranking",
                options: [
                  { id: "focus", label: "Focus ownership" },
                  { id: "spacing", label: "Option spacing" },
                  { id: "color", label: "Color fidelity" },
                ],
              }
            : mode === "text"
              ? {
                  id: `mock-question-${responseNumber}`,
                  title: "Free-text Question",
                  prompt: "Enter a deterministic review note",
                  kind: "freeText",
                }
              : {
                  id: `mock-question-${responseNumber}`,
                  title: "Trace Question",
                  prompt: "Choose the deterministic continuation",
                  kind: "singleChoice",
                  options: [
                    { id: "continue", label: "Continue" },
                    { id: "cancel", label: "Cancel" },
                  ],
                };
      await events.onQuestion?.([question]);
    }
    if (text.trim().toLowerCase() === "mock wait") {
      await delay(process.env.VSPI_TERMINAL_MOCK_TRACE === "1" ? 80 : 2_000);
    }

    const lineCount = text.toLowerCase().includes("long") || text.toLowerCase().includes("trace") ? 96 : 28;
    const response = [
      `MOCK_RESPONSE_${responseNumber}_START`,
      ...Array.from(
        { length: lineCount },
        (_, index) => `mock response ${responseNumber} line ${String(index + 1).padStart(3, "0")} | ${text}`,
      ),
      `MOCK_RESPONSE_${responseNumber}_END`,
    ].join("\n");
    const id = `mock-response-${responseNumber}-${randomUUID()}`;
    const message: TextMessage = { id, role: "assistant", kind: "text", text: "", streaming: true };
    events.onMessage(message);
    const chunkSize = process.env.VSPI_TERMINAL_MOCK_TRACE === "1" ? 220 : 72;
    const chunkDelay = process.env.VSPI_TERMINAL_MOCK_TRACE === "1" ? 1 : 14;
    for (let offset = 0; offset < response.length && generation === this.generation; offset += chunkSize) {
      events.onMessageUpdate(id, { text: response.slice(0, offset + chunkSize), streaming: true });
      await delay(chunkDelay);
    }
    if (generation !== this.generation) return { status: "cancelled" };
    events.onMessageUpdate(id, { text: response, streaming: false });
    events.onBusy(false);
    return { status: "completed" };
  }

  async cancel() {
    this.generation += 1;
    this.events?.onBusy(false);
    return { queuedMessages: [] };
  }

  async compact(): Promise<void> {}

  async newSession(): Promise<void> {
    this.sessionId = `mock-new-${Date.now()}`;
    this.events?.onSessionReset?.({ id: this.sessionId, reason: "new" });
    this.events?.onUsage({ ...DEFAULT_USAGE, contextWindow: 128_000 });
  }

  async listSessions(): Promise<SessionOption[]> {
    return [
      { id: "mock-long", label: "Long hydrated session", relativeTime: "刚刚", branchDepth: 0 },
      { id: "mock-short", label: "Short session", relativeTime: "1 分钟前", branchDepth: 0 },
      { id: "mock-empty", label: "Empty session", relativeTime: "2 分钟前", branchDepth: 0 },
    ];
  }

  async switchSession(id: string): Promise<void> {
    const events = this.requireEvents();
    this.sessionId = id;
    events.onSessionReset?.({ id, reason: "resume" });
    const count = id === "mock-long" ? 72 : id === "mock-short" ? 8 : 0;
    for (let index = 0; index < count; index += 1) {
      events.onMessage({
        id: `mock-resume-${index}`,
        role: "assistant",
        kind: "text",
        text: `MOCK_RESUME_${String(index + 1).padStart(3, "0")}${index === count - 1 ? "_END" : ""}`,
      });
      if ((index + 1) % 8 === 0) await delay(process.env.VSPI_TERMINAL_MOCK_TRACE === "1" ? 2 : 45);
    }
    events.onUsage({ ...DEFAULT_USAGE, contextTokens: count * 80, contextWindow: 128_000 });
  }

  async getModelOptions() {
    return [
      {
        id: this.modelId,
        provider: this.modelProvider,
        brand: "Mock",
        label: this.modelLabel,
        vision: false,
        efforts: ["medium" as const],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        contextWindow: 128_000,
      },
    ];
  }

  async getModelGroups() {
    return [];
  }

  async getProviderOptions() {
    return [];
  }

  async dispose(): Promise<void> {
    this.generation += 1;
  }

  private requireEvents(): ChatBackendEvents {
    if (!this.events) throw new Error("Terminal mock backend has not started");
    return this.events;
  }
}

const terminal = new ScrollbackProcessTerminal();
const tui = new ScrollbackTUI(terminal, true, process.env.VSPI_MOCK_LOG_DIR);
const requestedTheme = process.env.VSPI_TERMINAL_MOCK_THEME;
const settings = {
  ...DEFAULT_SETTINGS,
  reducedMotion: false,
  workingStyle: 3 as const,
  theme:
    requestedTheme === "Terminal" || requestedTheme === "VSPi Dark" || requestedTheme === "VSPi Light"
      ? requestedTheme
      : DEFAULT_SETTINGS.theme,
};
const capabilities = applySettingsToCapabilities(detectTerminalCapabilities(), settings);
const theme = createTheme(capabilities, settings.theme);
const backend = new TerminalMockBackend();
const attachments = new MockAttachments();
let closing = false;

const shutdown = async () => {
  if (closing) return;
  closing = true;
  tui.stop();
  await app.dispose();
  process.exitCode = 0;
};

const app = new VspiApp(tui, theme, backend, {
  cwd: process.cwd(),
  settings,
  attachments: attachments as unknown as AttachmentService,
  onExit: () => void shutdown(),
});
tui.addChild(app);
tui.setFocus(app);

await startUiAfterSplash({
  width: terminal.columns,
  theme,
  write: (chunk) => process.stdout.write(chunk),
  startApp: async () => {
    await app.start();
    return app.startupStatus();
  },
  startTui: (startupSurface) => {
    app.setStartupSurface(startupSurface);
    tui.start();
  },
});

process.once("SIGTERM", () => void shutdown());
process.once("SIGHUP", () => void shutdown());
