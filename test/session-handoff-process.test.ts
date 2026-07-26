import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const CHILD_SOURCE = `
import { PiBackend } from './src/backend/pi-backend.ts';

const role = process.env.ROLE;
const interactionKind = process.env.INTERACTION_KIND || '';
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let abortCalls = 0;
let managerSeen;
let finishInteraction;
const interactionFinished = new Promise(resolve => { finishInteraction = resolve; });
function summary(manager) {
  return manager.getBranch().filter(entry => entry.type === 'message').map(entry =>
    typeof entry.message.content === 'string' ? entry.message.content : entry.message.model
  );
}
function session(manager) {
  let listener;
  return {
    model: { id: 'fixture', name: 'Fixture', provider: 'fixture', input: ['text'], contextWindow: 100000 },
    messages: [],
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    thinkingLevel: 'medium',
    isStreaming: false,
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    setThinkingLevel() {},
    getAvailableThinkingLevels() { return ['off', 'medium', 'high']; },
    async prompt(text) {
      manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
      if (interactionKind) await interactionFinished;
      else await new Promise(resolve => setTimeout(resolve, 450));
      manager.appendMessage({ role: 'assistant', content: [], api: 'openai-completions', provider: 'fixture', model: role, usage, stopReason: 'stop', timestamp: Date.now() });
    },
    async steer() {},
    async followUp() {},
    clearQueue() { return { steering: [], followUp: [] }; },
    async abort() { abortCalls += 1; },
    async compact() {},
    abortCompaction() {},
    getContextUsage() { return { tokens: 0, contextWindow: 100000, percent: 0 }; },
    getSessionStats() { return { sessionFile: manager.getSessionFile(), sessionId: manager.getSessionId(), userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }; },
    dispose() {},
  };
}
const backend = new PiBackend({
  cwd: process.env.WORKSPACE,
  agentDir: process.env.AGENT_DIR,
  sessionDir: process.env.SESSION_DIR,
  continueRecent: true,
  sessionLeases: true,
  sessionFactory: async manager => {
    managerSeen = manager;
    process.send({ type: 'factory', role, branch: summary(manager) });
    return { session: session(manager) };
  },
});
let markReady;
const ready = new Promise(resolve => { markReady = resolve; });
const events = {
  onMessage() {}, onMessageUpdate() {}, onBusy() {}, onUsage() {},
  onNotice(message) { process.send({ type: 'notice', role, message }); },
  onSessionReady() { markReady(); },
  onSessionWait(waiting) { if (waiting) process.send({ type: 'waiting', role }); },
  async onHandoffInteraction(interaction) {
    process.send({ type: 'interaction', role, interaction });
    if (interaction.kind === 'question') {
      return { kind: 'question', questions: interaction.questions.map(question => ({ ...question, answer: 'continue' })) };
    }
    return { kind: 'approval', response: { type: 'allow-once' } };
  },
  onHandoffPending(relay) {
    if (!interactionKind) return;
    const interaction = interactionKind === 'question'
      ? { kind: 'question', questions: [{ id: 'handoff-question', title: 'Continue', prompt: 'Continue the tool?', kind: 'singleChoice', options: [{ id: 'continue', label: 'Continue' }] }] }
      : { kind: 'approval', request: { action: { kind: 'file-write', target: '/tmp/result' }, category: 'file-write', policy: 'Safe', requiredPolicy: 'Standard' } };
    void relay.request(interaction).then(response => {
      managerSeen.appendCustomEntry('vspi.handoff-test', { interactionKind, response });
      process.send({ type: 'interaction-response', role, interaction: response });
      finishInteraction();
    });
  },
  onTakeover() {
    process.send({ type: 'takeover', role, abortCalls });
    void backend.dispose().then(() => {
      process.send({ type: 'disposed', role, abortCalls });
      setTimeout(() => process.exit(0), 10);
    });
  },
};
await backend.start(events);
if (role === 'A') {
  const pending = backend.send('A_USER', { attachments: [], effort: 'medium', behavior: 'prompt' });
  process.send({ type: 'running', role });
  await pending;
  process.send({ type: 'completed', role, abortCalls, branch: summary(managerSeen) });
} else {
  if (!backend.isSessionReady()) {
    process.send({ type: 'ui-started', role });
    await ready;
  }
  process.send({ type: 'acquired', role, abortCalls, branch: summary(managerSeen) });
  await backend.dispose();
  process.send({ type: 'disposed', role, abortCalls });
  setTimeout(() => process.exit(0), 10);
}
`;

type ChildMessage = {
  type: string;
  role: string;
  abortCalls?: number;
  branch?: string[];
  message?: string;
  interaction?: unknown;
};

describe("same-host Session handoff", () => {
  it("lets the old process finish its active turn before the new process acquires the same thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-handoff-process-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    const base = SessionManager.create(workspace, sessionDir);
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    base.appendMessage({ role: "user", content: "BASE_USER", timestamp: Date.now() });
    base.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "fixture",
      model: "BASE",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const messages: Array<ChildMessage & { at: number }> = [];
    const first = startChild("A", { workspace, agentDir, sessionDir }, messages);
    await waitFor(messages, (message) => message.role === "A" && message.type === "running");
    const second = startChild("B", { workspace, agentDir, sessionDir }, messages);
    await Promise.all([waitForExit(first), waitForExit(second)]);

    const completed = messages.find((message) => message.role === "A" && message.type === "completed");
    const oldDisposed = messages.find((message) => message.role === "A" && message.type === "disposed");
    const acquired = messages.find((message) => message.role === "B" && message.type === "acquired");
    expect(completed?.abortCalls).toBe(0);
    expect(oldDisposed?.abortCalls).toBe(0);
    expect(acquired?.at).toBeGreaterThanOrEqual(oldDisposed?.at ?? Number.POSITIVE_INFINITY);
    expect(acquired?.branch).toEqual(["BASE_USER", "BASE", "A_USER", "A"]);

    const sessionFile = base.getSessionFile();
    expect(sessionFile).toBeDefined();
    const lines = (await readFile(sessionFile ?? "", "utf8")).trim().split("\n");
    expect(lines.every((line) => JSON.parse(line))).toBe(true);
    expect(
      SessionManager.open(sessionFile ?? "")
        .getBranch()
        .filter((entry) => entry.type === "message"),
    ).toHaveLength(4);
  }, 15_000);

  for (const interactionKind of ["question", "approval"] as const) {
    it(`moves a pending ${interactionKind} to the new TUI without aborting or losing the active turn`, async () => {
      const root = await mkdtemp(join(tmpdir(), `vspi-handoff-${interactionKind}-`));
      const workspace = join(root, "workspace");
      const agentDir = join(root, "agent");
      const sessionDir = join(root, "sessions");
      const base = SessionManager.create(workspace, sessionDir);
      base.appendMessage({ role: "user", content: "BASE_USER", timestamp: Date.now() });
      base.appendMessage({
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "fixture",
        model: "BASE",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const messages: Array<ChildMessage & { at: number }> = [];
      const first = startChild("A", { workspace, agentDir, sessionDir }, messages, interactionKind);
      await waitFor(messages, (message) => message.role === "A" && message.type === "running");
      const second = startChild("B", { workspace, agentDir, sessionDir }, messages, interactionKind);
      await waitFor(messages, (message) => message.role === "B" && message.type === "interaction");
      await Promise.all([waitForExit(first), waitForExit(second)]);

      const uiStarted = messages.find((message) => message.role === "B" && message.type === "ui-started");
      const response = messages.find((message) => message.role === "A" && message.type === "interaction-response");
      const oldDisposed = messages.find((message) => message.role === "A" && message.type === "disposed");
      const acquired = messages.find((message) => message.role === "B" && message.type === "acquired");
      expect(uiStarted).toBeDefined();
      expect(response?.interaction).toEqual(
        interactionKind === "question"
          ? expect.objectContaining({ kind: "question" })
          : { kind: "approval", response: { type: "allow-once" } },
      );
      expect(messages.find((message) => message.role === "A" && message.type === "completed")?.abortCalls).toBe(0);
      expect(oldDisposed?.abortCalls).toBe(0);
      expect(acquired?.at).toBeGreaterThanOrEqual(oldDisposed?.at ?? Number.POSITIVE_INFINITY);
      expect(acquired?.branch).toEqual(["BASE_USER", "BASE", "A_USER", "A"]);

      const entries = SessionManager.open(base.getSessionFile() ?? "").getBranch();
      expect(entries.some((entry) => entry.type === "custom" && entry.customType === "vspi.handoff-test")).toBe(true);
      expect(entries.filter((entry) => entry.type === "message")).toHaveLength(4);
    }, 15_000);
  }
});

function startChild(
  role: string,
  paths: { workspace: string; agentDir: string; sessionDir: string },
  messages: Array<ChildMessage & { at: number }>,
  interactionKind = "",
): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD_SOURCE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROLE: role,
      WORKSPACE: paths.workspace,
      AGENT_DIR: paths.agentDir,
      SESSION_DIR: paths.sessionDir,
      INTERACTION_KIND: interactionKind,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.on("message", (message: ChildMessage) => messages.push({ ...message, at: Date.now() }));
  return child;
}

async function waitFor(
  messages: Array<ChildMessage & { at: number }>,
  predicate: (message: ChildMessage) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!messages.some(predicate)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for child message: ${JSON.stringify(messages)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Child exited with ${code}`));
    });
  });
}
