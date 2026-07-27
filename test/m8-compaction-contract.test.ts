import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../src/backend/types.js";
import { createLocalPlanBackend } from "../src/plans/local-plan-backend.js";

type ProfileId = "pi-native" | "execution-continuity" | "research-decisions" | "custom";

interface CompactOptions {
  profile: ProfileId;
  customInstructions?: string;
}

interface CompactBackend {
  compact(options?: CompactOptions): Promise<void>;
  abortCompaction(): void;
  cancel(): Promise<void>;
  getPlanBinding(): { planId: string } | undefined;
  bindPlan(planId: string | undefined): Promise<void>;
  newSession(options?: { defaults: boolean; continuePlan: boolean }): Promise<void>;
  switchSession(id: string): Promise<void>;
  forkSession(id: string): Promise<void>;
}

async function profilesModule() {
  const specifier = "../src/continuity/compaction-profiles.js";
  return (await import(specifier)) as {
    COMPACTION_PROFILES: ReadonlyArray<{ id: ProfileId; label: string }>;
    resolveCompactionProfile(input: { hasPlanBinding: boolean; profile?: ProfileId; customInstructions?: string }): {
      profile: ProfileId;
      customInstructions?: string;
    };
  };
}

function backendApi(backend: PiBackend): CompactBackend {
  const api = backend as unknown as Partial<CompactBackend>;
  expect(api.abortCompaction).toBeTypeOf("function");
  return api as CompactBackend;
}

async function harness(compactImpl?: (instructions?: string) => Promise<unknown>) {
  const cwd = await mkdtemp(join(tmpdir(), "vspi-m8-compact-"));
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const compact = vi.fn(compactImpl ?? (async () => ({})));
  const abortCompaction = vi.fn();
  const abort = vi.fn(async () => {});
  const followUp = vi.fn(async () => {});
  const managers: SessionManager[] = [];
  const planBackend = createLocalPlanBackend({ rootDir: join(cwd, "compatibility-plans") });
  const backend = new PiBackend({
    cwd,
    planBackend,
    sessionFactory: async (manager: SessionManager) => {
      managers.push(manager);
      return {
        session: {
          model: { id: "m8", name: "M8", provider: "test", input: ["text"], contextWindow: 32_000 },
          sessionId: manager.getSessionId(),
          sessionManager: manager,
          messages: manager.buildSessionContext().messages,
          thinkingLevel: "medium",
          isStreaming: false,
          subscribe(callback: (event: AgentSessionEvent) => void) {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
          setThinkingLevel: vi.fn(),
          prompt: vi.fn(async () => {}),
          followUp,
          steer: vi.fn(async () => {}),
          clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
          abort,
          compact,
          abortCompaction,
          getContextUsage: vi.fn(() => ({ tokens: 0, contextWindow: 32_000, percent: 0 })),
          getSessionStats: vi.fn(() => ({
            sessionFile: manager.getSessionFile(),
            sessionId: manager.getSessionId(),
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
          })),
          dispose: vi.fn(),
        } as unknown as AgentSession,
      };
    },
  });
  const events: ChatBackendEvents = {
    onMessage: vi.fn(),
    onMessageUpdate: vi.fn(),
    onBusy: vi.fn(),
    onUsage: vi.fn(),
    onNotice: vi.fn(),
  };
  await backend.start(events);
  return {
    backend,
    api: backendApi(backend),
    compact,
    abortCompaction,
    abort,
    followUp,
    planBackend,
    events,
    managers,
    emit: (event: AgentSessionEvent) => listener?.(event),
  };
}

describe("M8 compaction profiles", () => {
  it("offers exactly the four approved profiles and chooses defaults by Plan binding", async () => {
    const { COMPACTION_PROFILES, resolveCompactionProfile } = await profilesModule();
    expect(COMPACTION_PROFILES.map((profile) => profile.id)).toEqual([
      "pi-native",
      "execution-continuity",
      "research-decisions",
      "custom",
    ]);
    expect(resolveCompactionProfile({ hasPlanBinding: false })).toEqual({ profile: "pi-native" });
    expect(resolveCompactionProfile({ hasPlanBinding: true })).toMatchObject({ profile: "execution-continuity" });
  });

  it("maps continuity, research, and custom selections to explicit Pi customInstructions", async () => {
    const { resolveCompactionProfile } = await profilesModule();
    expect(
      resolveCompactionProfile({ hasPlanBinding: true, profile: "execution-continuity" }).customInstructions,
    ).toMatch(/goal|focus|blocker|next action|revision/i);
    expect(
      resolveCompactionProfile({ hasPlanBinding: false, profile: "research-decisions" }).customInstructions,
    ).toMatch(/decision|evidence|citation|open question/i);
    expect(
      resolveCompactionProfile({
        hasPlanBinding: false,
        profile: "custom",
        customInstructions: "Preserve API decisions",
      }),
    ).toEqual({ profile: "custom", customInstructions: "Preserve API decisions" });
    expect(() => resolveCompactionProfile({ hasPlanBinding: false, profile: "custom" })).toThrow(
      /instruction|required/i,
    );
  });

  it("passes the resolved manual profile instructions to Pi and leaves Pi Native undefined", async () => {
    const h = await harness();
    try {
      await h.api.compact({ profile: "research-decisions" });
      expect(h.compact).toHaveBeenLastCalledWith(expect.stringMatching(/decision|evidence|citation/i));

      await h.api.compact({ profile: "pi-native" });
      expect(h.compact).toHaveBeenLastCalledWith(undefined);
    } finally {
      await h.backend.dispose();
    }
  });

  it("routes Ctrl+C cancellation to Pi abortCompaction", async () => {
    let release: (() => void) | undefined;
    const h = await harness(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const pending = h.api.compact({ profile: "execution-continuity" });
      h.api.abortCompaction();
      expect(h.abortCompaction).toHaveBeenCalledOnce();
      release?.();
      await pending;
    } finally {
      await h.backend.dispose();
    }
  });

  it.each(["success", "failure", "cancel"] as const)(
    "preserves the active session and Plan binding atomically on manual compaction %s",
    async (outcome) => {
      let rejectCompact: ((error: Error) => void) | undefined;
      const h = await harness(
        outcome === "failure"
          ? async () => {
              throw new Error("compaction failure sentinel");
            }
          : outcome === "cancel"
            ? () =>
                new Promise((_resolve, reject) => {
                  rejectCompact = reject;
                })
            : undefined,
      );
      try {
        await h.api.bindPlan("release-plan");
        const sessionId = (h.backend as unknown as { session: AgentSession }).session.sessionId;
        const operation = h.api.compact({ profile: "execution-continuity" });
        if (outcome === "cancel") {
          h.api.abortCompaction();
          rejectCompact?.(new Error("aborted"));
        }
        if (outcome === "success") await expect(operation).resolves.toBeUndefined();
        else await expect(operation).rejects.toThrow();

        expect((h.backend as unknown as { session: AgentSession }).session.sessionId).toBe(sessionId);
        expect(h.api.getPlanBinding()).toEqual({ planId: "release-plan" });
      } finally {
        await h.backend.dispose();
      }
    },
  );

  it("refreshes usage when Pi-native auto compaction succeeds", async () => {
    const h = await harness();
    try {
      vi.mocked(h.events.onUsage).mockClear();
      h.emit({
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        willRetry: false,
        result: {},
      } as AgentSessionEvent);
      expect(h.events.onUsage).toHaveBeenCalledOnce();
      expect(h.events.onUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ contextTokens: 0, contextWindow: 32_000 }),
      );
    } finally {
      await h.backend.dispose();
    }
  });

  it("does not refresh usage when Pi-native compaction is cancelled or fails", async () => {
    const h = await harness();
    try {
      for (const event of [
        { type: "compaction_end", reason: "threshold", aborted: true, willRetry: false },
        {
          type: "compaction_end",
          reason: "threshold",
          aborted: false,
          willRetry: false,
          errorMessage: "compaction failed",
        },
      ] as AgentSessionEvent[]) {
        vi.mocked(h.events.onUsage).mockClear();
        h.emit(event);
        expect(h.events.onUsage).not.toHaveBeenCalled();
      }
    } finally {
      await h.backend.dispose();
    }
  });

  it("keeps auto compaction Pi-native and only observes completion as a review boundary", async () => {
    const h = await harness();
    try {
      h.emit({ type: "compaction_end", reason: "threshold", aborted: false } as AgentSessionEvent);
      expect(h.compact).not.toHaveBeenCalled();
    } finally {
      await h.backend.dispose();
    }
  });
});

function sessionInfo(manager: SessionManager): SessionInfo {
  const path = manager.getSessionFile();
  if (!path) throw new Error("M8 target session was not persisted");
  return {
    id: manager.getSessionId(),
    path,
    cwd: manager.getCwd(),
    created: new Date(),
    modified: new Date(),
    messageCount: manager.buildSessionContext().messages.length,
    firstMessage: "M8 target session",
    allMessagesText: "M8 target session",
  };
}

type MutationOperation = "newSession" | "switchSession" | "forkSession" | "bindPlan";

async function invokeMutation(
  operation: MutationOperation,
  api: CompactBackend,
  target: SessionManager,
): Promise<void> {
  if (operation === "newSession") return api.newSession({ defaults: false, continuePlan: false });
  if (operation === "switchSession") return api.switchSession(target.getSessionId());
  if (operation === "forkSession") return api.forkSession(target.getSessionId());
  return api.bindPlan("replacement-plan");
}

function populateTarget(manager: SessionManager): void {
  manager.appendMessage({ role: "user", content: "target branch point", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "target ready" }],
    api: "openai-completions",
    provider: "test",
    model: "m8",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
}

describe("M8 compaction mutation barrier", () => {
  it.each(["newSession", "switchSession", "forkSession", "bindPlan"] as const)(
    "rejects %s during auto compaction without replacing the session or changing Plan binding",
    async (operation) => {
      const h = await harness();
      const target = SessionManager.create(h.managers[0]?.getCwd() ?? "");
      populateTarget(target);
      const list = vi.spyOn(SessionManager, "list").mockResolvedValue([sessionInfo(target)]);
      try {
        await h.api.bindPlan("release-plan");
        const initialSessionId = h.managers[0]?.getSessionId();
        h.emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);

        await expect(invokeMutation(operation, h.api, target)).rejects.toThrow(/compact|压缩|progress|进行/i);
        expect(h.managers).toHaveLength(1);
        expect(h.managers[0]?.getSessionId()).toBe(initialSessionId);
        expect(h.api.getPlanBinding()).toEqual({ planId: "release-plan" });
        if (operation === "switchSession" || operation === "forkSession") expect(list).not.toHaveBeenCalled();
      } finally {
        list.mockRestore();
        await h.backend.dispose();
      }
    },
  );

  it.each(["newSession", "switchSession", "forkSession", "bindPlan"] as const)(
    "allows %s again after compaction_end",
    async (operation) => {
      const h = await harness();
      const target = SessionManager.create(h.managers[0]?.getCwd() ?? "");
      populateTarget(target);
      const list = vi.spyOn(SessionManager, "list").mockResolvedValue([sessionInfo(target)]);
      try {
        h.emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
        h.emit({
          type: "compaction_end",
          reason: "threshold",
          aborted: false,
          willRetry: false,
          result: {},
        } as AgentSessionEvent);

        await expect(invokeMutation(operation, h.api, target)).resolves.toBeUndefined();
        if (operation === "bindPlan") expect(h.api.getPlanBinding()).toEqual({ planId: "replacement-plan" });
        else expect(h.managers.length).toBeGreaterThan(1);
      } finally {
        list.mockRestore();
        await h.backend.dispose();
      }
    },
  );

  it.each(["newSession", "switchSession", "forkSession", "bindPlan"] as const)(
    "keeps %s blocked across overflow compaction_end until the retry generation settles",
    async (operation) => {
      const h = await harness();
      const target = SessionManager.create(h.managers[0]?.getCwd() ?? "");
      populateTarget(target);
      const list = vi.spyOn(SessionManager, "list").mockResolvedValue([sessionInfo(target)]);
      try {
        await h.api.bindPlan("release-plan");
        const initialSessionId = h.managers[0]?.getSessionId();
        h.emit({ type: "compaction_start", reason: "overflow" } as AgentSessionEvent);
        h.emit({
          type: "compaction_end",
          reason: "overflow",
          aborted: false,
          willRetry: true,
          result: {},
        } as AgentSessionEvent);

        await expect(invokeMutation(operation, h.api, target)).rejects.toThrow(/compact|压缩|retry|progress|进行/i);
        expect(h.managers).toHaveLength(1);
        expect(h.managers[0]?.getSessionId()).toBe(initialSessionId);
        expect(h.api.getPlanBinding()).toEqual({ planId: "release-plan" });
        if (operation === "switchSession" || operation === "forkSession") expect(list).not.toHaveBeenCalled();

        h.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
        await expect(invokeMutation(operation, h.api, target)).resolves.toBeUndefined();
        if (operation === "bindPlan") expect(h.api.getPlanBinding()).toEqual({ planId: "replacement-plan" });
        else expect(h.managers.length).toBeGreaterThan(1);
      } finally {
        list.mockRestore();
        await h.backend.dispose();
      }
    },
  );

  it.each(["newSession", "switchSession", "forkSession", "bindPlan"] as const)(
    "allows %s after an overflow retry reaches agent_end",
    async (operation) => {
      const h = await harness();
      const target = SessionManager.create(h.managers[0]?.getCwd() ?? "");
      populateTarget(target);
      const list = vi.spyOn(SessionManager, "list").mockResolvedValue([sessionInfo(target)]);
      try {
        h.emit({ type: "compaction_start", reason: "overflow" } as AgentSessionEvent);
        h.emit({
          type: "compaction_end",
          reason: "overflow",
          aborted: false,
          willRetry: true,
          result: {},
        } as AgentSessionEvent);
        h.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);

        await expect(invokeMutation(operation, h.api, target)).resolves.toBeUndefined();
        if (operation === "bindPlan") expect(h.api.getPlanBinding()).toEqual({ planId: "replacement-plan" });
        else expect(h.managers.length).toBeGreaterThan(1);
      } finally {
        list.mockRestore();
        await h.backend.dispose();
      }
    },
  );
  it("queues one internal Plan reconciliation when a completion claim did not update the bound Plan", async () => {
    const h = await harness();
    try {
      const plan = await h.planBackend.create({
        title: "Finish page updates",
        goal: "Apply and verify the requested page changes",
        challenges: [],
        items: [
          { id: "content", title: "Update content", status: "done" },
          { id: "verify", title: "Verify desktop and mobile", status: "in_progress" },
        ],
        focusItemId: "verify",
        blockers: [],
        nextAction: "Run browser checks",
      });
      await h.api.bindPlan(plan.id);
      h.emit({ type: "agent_start" } as AgentSessionEvent);
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "已完成页面修改和桌面端、移动端验证。" }],
      };
      h.emit({ type: "message_end", message } as AgentSessionEvent);
      h.emit({ type: "message_end", message } as AgentSessionEvent);

      await vi.waitFor(() => expect(h.followUp).toHaveBeenCalledOnce());
      expect(h.followUp).toHaveBeenCalledWith(
        expect.stringMatching(/vspi_plan_reconciliation[\s\S]*plan_read[\s\S]*plan_update/u),
      );
      expect(h.followUp).toHaveBeenCalledWith(expect.stringContaining("不要重复执行"));
    } finally {
      await h.backend.dispose();
    }
  });
});

describe("M8 Pi compaction event state machine", () => {
  it.each(["threshold", "overflow"] as const)("enters busy state when %s auto compaction starts", async (reason) => {
    const h = await harness();
    try {
      h.emit({ type: "compaction_start", reason } as AgentSessionEvent);
      expect(h.events.onBusy).toHaveBeenLastCalledWith(true);
      expect(h.compact).not.toHaveBeenCalled();
    } finally {
      await h.backend.dispose();
    }
  });

  it.each(["threshold", "overflow"] as const)(
    "routes cancellation during %s auto compaction to abortCompaction rather than agent abort",
    async (reason) => {
      const h = await harness();
      try {
        h.emit({ type: "compaction_start", reason } as AgentSessionEvent);
        await h.api.cancel();
        expect(h.abortCompaction).toHaveBeenCalledOnce();
        expect(h.abort).not.toHaveBeenCalled();
      } finally {
        await h.backend.dispose();
      }
    },
  );

  it("rejects concurrent manual compaction without invoking Pi compact twice", async () => {
    const releases: Array<() => void> = [];
    const h = await harness(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      first = h.api.compact({ profile: "execution-continuity" });
      second = h.api.compact({ profile: "research-decisions" });
      const outcome = second.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.compact).toHaveBeenCalledOnce();
      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ message: expect.stringMatching(/compact|压缩|progress|进行/i) }),
      });
    } finally {
      for (const release of releases) release();
      await Promise.allSettled([first, second].filter((item): item is Promise<void> => item !== undefined));
      await h.backend.dispose();
    }
  });

  it.each([true, false] as const)(
    "clears auto-compaction busy state when compaction ends aborted=%s",
    async (aborted) => {
      const h = await harness();
      try {
        h.emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
        h.emit({
          type: "compaction_end",
          reason: "threshold",
          aborted,
          willRetry: false,
          result: aborted ? undefined : {},
        } as AgentSessionEvent);
        expect(h.events.onBusy).toHaveBeenLastCalledWith(false);
        vi.mocked(h.abort).mockClear();
        vi.mocked(h.abortCompaction).mockClear();
        await h.api.cancel();
        expect(h.abort).toHaveBeenCalledOnce();
        expect(h.abortCompaction).not.toHaveBeenCalled();
      } finally {
        await h.backend.dispose();
      }
    },
  );

  it("does not report idle after overflow compaction when Pi will retry the pending generation", async () => {
    const h = await harness();
    try {
      h.emit({ type: "agent_start" } as AgentSessionEvent);
      h.emit({ type: "compaction_start", reason: "overflow" } as AgentSessionEvent);
      h.emit({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: true,
        result: {},
      } as AgentSessionEvent);
      expect(h.events.onBusy).toHaveBeenLastCalledWith(true);
    } finally {
      await h.backend.dispose();
    }
  });

  it("keeps busy state while overflow compaction schedules an automatic retry", async () => {
    const h = await harness();
    try {
      h.emit({ type: "compaction_start", reason: "overflow" } as AgentSessionEvent);
      h.emit({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: true,
        result: {},
      } as AgentSessionEvent);
      expect(h.events.onBusy).toHaveBeenLastCalledWith(true);
    } finally {
      await h.backend.dispose();
    }
  });

  it("never calls manual compact or supplies customInstructions for threshold/overflow auto compaction", async () => {
    const h = await harness();
    try {
      for (const reason of ["threshold", "overflow"] as const) {
        h.emit({ type: "compaction_start", reason } as AgentSessionEvent);
        h.emit({
          type: "compaction_end",
          reason,
          aborted: false,
          willRetry: reason === "overflow",
          result: {},
        } as AgentSessionEvent);
      }
      expect(h.compact).not.toHaveBeenCalled();
    } finally {
      await h.backend.dispose();
    }
  });
});
