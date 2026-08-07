import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../src/backend/types.js";
import { createGoalBackend } from "../src/goals/backend.js";
import { createLocalPlanBackend } from "../src/plans/local-plan-backend.js";

function stats(sessionId: string): SessionStats {
  return {
    sessionFile: undefined,
    sessionId,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function fakeSession(onPrompt: (emit: (event: AgentSessionEvent) => void) => Promise<void> | void) {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const sessionId = "goal-runner-session";
  const session = {
    model: {
      id: "goal-model",
      name: "Goal Model",
      provider: "test",
      input: ["text"],
      contextWindow: 200_000,
    },
    messages: [],
    sessionId,
    thinkingLevel: "high",
    isStreaming: false,
    subscribe(callback: (event: AgentSessionEvent) => void) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    setThinkingLevel: vi.fn(),
    prompt: vi.fn(async () => onPrompt((event) => listener?.(event))),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({})),
    getContextUsage: vi.fn(() => ({ tokens: 0, contextWindow: 200_000, percent: 0 })),
    getSessionStats: vi.fn(() => stats(sessionId)),
    dispose: vi.fn(),
  } as unknown as AgentSession;
  return session;
}

function events(): ChatBackendEvents {
  return {
    onMessage: vi.fn(),
    onMessageUpdate: vi.fn(),
    onBusy: vi.fn(),
    onUsage: vi.fn(),
    onNotice: vi.fn(),
  };
}

async function harness(onPrompt: (emit: (event: AgentSessionEvent) => void) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), "vspi-goal-runner-"));
  const goalBackend = createGoalBackend({ rootDir: join(root, "goals") });
  const planBackend = createLocalPlanBackend({ rootDir: join(root, "plans") });
  const session = fakeSession(onPrompt);
  const backend = new PiBackend({
    cwd: root,
    sessionDir: join(root, "sessions"),
    planBackend,
    goalBackend,
    sessionFactory: async (manager) => ({ session: Object.assign(session, { sessionManager: manager }) }),
  });
  await backend.start(events());
  return { backend, goalBackend, session };
}

const assistantEnd = (text: string) =>
  ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) as AgentSessionEvent;

describe("Pi GoalRunner", () => {
  it("restores a lost-owner Goal as paused and requires explicit resume without auto-generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-goal-restart-"));
    const sessionDir = join(root, "sessions");
    const goalBackend = createGoalBackend({ rootDir: join(root, "goals") });
    const planBackend = createLocalPlanBackend({ rootDir: join(root, "plans") });
    const firstSession = fakeSession(() => undefined);
    const first = new PiBackend({
      cwd: root,
      sessionDir,
      planBackend,
      goalBackend,
      sessionFactory: async (manager) => ({ session: Object.assign(firstSession, { sessionManager: manager }) }),
    });
    await first.start(events());
    const created = await first.createGoal("Persist across restart");
    await first.dispose();

    const resumedSession = fakeSession(() => undefined);
    const resumed = new PiBackend({
      cwd: root,
      sessionDir,
      continueRecent: true,
      planBackend,
      goalBackend,
      sessionFactory: async (manager) => ({ session: Object.assign(resumedSession, { sessionManager: manager }) }),
    });
    await resumed.start(events());
    expect(await resumed.getGoal()).toMatchObject({
      id: created.id,
      state: "paused",
      stateReason: "lost_owner_requires_explicit_resume",
    });
    expect(resumedSession.prompt).not.toHaveBeenCalled();
    expect(resumedSession.followUp).not.toHaveBeenCalled();

    const executing = await resumed.resumeGoal();
    expect(executing).toMatchObject({ state: "executing", autoRounds: 0, consumedTokens: 0 });
    expect(resumedSession.prompt).not.toHaveBeenCalled();
    await resumed.dispose();
  });

  it("waits for agent_end and queues only once across multiple assistant message blocks", async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const boundary = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const h = await harness(async (emit) => {
      emit({ type: "agent_start" } as AgentSessionEvent);
      emit(assistantEnd("I will inspect the files."));
      emit(assistantEnd("The inspection phase is complete."));
      reached();
      await gate;
      emit({ type: "agent_end" } as AgentSessionEvent);
    });
    await h.backend.createGoal("Complete a multi-step implementation");
    const pending = h.backend.send("Complete it", { attachments: [], effort: "high", behavior: "prompt" });
    await boundary;
    expect(h.session.followUp).not.toHaveBeenCalled();
    release();
    await pending;
    await vi.waitFor(() => expect(h.session.followUp).toHaveBeenCalledOnce());
    await h.backend.dispose();
  });

  it("uses native followUp when an ordinary final response leaves the durable Goal executing", async () => {
    const h = await harness((emit) => {
      emit({ type: "agent_start" } as AgentSessionEvent);
      emit(assistantEnd("Finished this phase. Next I will continue with the remaining chapters."));
      emit({ type: "agent_end" } as AgentSessionEvent);
    });
    const goal = await h.backend.createGoal("Index the complete novel", { maxNoProgressRounds: 3 });
    await h.backend.send("Index the complete novel", { attachments: [], effort: "high", behavior: "prompt" });
    await vi.waitFor(() => expect(h.session.followUp).toHaveBeenCalledOnce());

    const persisted = await h.goalBackend.read(goal.id);
    expect(persisted).toMatchObject({ state: "executing", autoRounds: 1, noProgressRounds: 1 });
    expect(h.session.followUp).toHaveBeenCalledWith(expect.stringContaining("vspi_goal_continuation"));
    await h.backend.dispose();
  });

  it("does not follow up after structured completion enters pending acceptance", async () => {
    let goalId = "";
    const h = await harness(async (emit) => {
      emit({ type: "agent_start" } as AgentSessionEvent);
      const current = await h.goalBackend.read(goalId);
      if (!current) throw new Error("goal unavailable");
      await h.goalBackend.claimComplete(current.id, {
        expectedRevision: current.revision,
        summary: "All chapters indexed",
        evidence: ["index/manifest.json"],
      });
      emit(assistantEnd("The requested outcome is complete."));
      emit({ type: "agent_end" } as AgentSessionEvent);
    });
    const goal = await h.backend.createGoal("Index every chapter");
    goalId = goal.id;
    await h.backend.send("Index every chapter", { attachments: [], effort: "high", behavior: "prompt" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.session.followUp).not.toHaveBeenCalled();
    expect((await h.goalBackend.read(goal.id))?.state).toBe("pending_acceptance");
    await h.backend.dispose();
  });

  it("pauses at the configured round boundary instead of queuing another model turn", async () => {
    const h = await harness((emit) => {
      emit({ type: "agent_start" } as AgentSessionEvent);
      emit(assistantEnd("Phase one report."));
      emit({ type: "agent_end" } as AgentSessionEvent);
    });
    const goal = await h.backend.createGoal("Long task", { maxAutoRounds: 1 });
    await h.backend.send("Long task", { attachments: [], effort: "high", behavior: "prompt" });
    await vi.waitFor(async () => expect((await h.goalBackend.read(goal.id))?.state).toBe("paused"));

    expect(h.session.followUp).not.toHaveBeenCalled();
    expect(await h.goalBackend.read(goal.id)).toMatchObject({ stateReason: "round_budget", autoRounds: 1 });
    await h.backend.dispose();
  });
});
