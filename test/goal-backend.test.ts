import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGoalBackend } from "../src/goals/backend.js";
import type { GoalInput, StoredGoal } from "../src/goals/types.js";

function input(overrides: Partial<GoalInput> = {}): GoalInput {
  return {
    contract: { objective: "Finish the whole novel index", completionCriteria: ["Every chapter is indexed"] },
    planId: "plan-long-work",
    limits: { maxAutoRounds: 5, maxNoProgressRounds: 2, maxTokens: 10_000 },
    owner: { sessionId: "session-1", processId: "process-1", acquiredAt: "2026-07-31T00:00:00.000Z" },
    initialTokens: 100,
    ...overrides,
  };
}

async function backendAt(name: string) {
  return createGoalBackend({ rootDir: await mkdtemp(join(tmpdir(), name)) });
}

describe("persistent Goal authority", () => {
  it("persists an immutable contract while markers and rounds advance with CAS", async () => {
    const backend = await backendAt("vspi-goal-store-");
    const created = await backend.create(input());
    const marked = await backend.checkpoint(created.id, {
      expectedRevision: created.revision,
      currentItem: "Chapter 8",
      completedWork: ["Indexed chapters 1-7"],
      evidence: ["index/chapter-01.md through chapter-07.md"],
      nextItem: "Index chapter 8",
    });
    const rounded = await backend.recordRound(marked.id, {
      expectedRevision: marked.revision,
      consumedTokens: 900,
      progressed: true,
    });

    expect(rounded.contract).toEqual(created.contract);
    expect(rounded.planId).toBe(created.planId);
    expect(rounded).toMatchObject({ revision: 3, autoRounds: 1, noProgressRounds: 0, consumedTokens: 900 });
    expect(rounded.markers.at(-1)).toMatchObject({ currentItem: "Chapter 8", nextItem: "Index chapter 8" });
    await expect(
      backend.checkpoint(created.id, {
        expectedRevision: created.revision,
        completedWork: [],
        evidence: [],
      }),
    ).rejects.toThrow(/revision conflict/i);
    expect((await backend.read(created.id))?.contract).toEqual(created.contract);
  });

  it("separates completion claim, user acceptance, blocking, pause and cancellation", async () => {
    const completionBackend = await backendAt("vspi-goal-complete-");
    const created = await completionBackend.create(input());
    const claimed = await completionBackend.claimComplete(created.id, {
      expectedRevision: created.revision,
      summary: "All chapters indexed",
      evidence: ["index/manifest.json"],
    });
    expect(claimed.state).toBe("pending_acceptance");
    await expect(
      completionBackend.checkpoint(claimed.id, {
        expectedRevision: claimed.revision,
        completedWork: [],
        evidence: [],
      }),
    ).rejects.toThrow(/not executing/i);
    const accepted = await completionBackend.transition(claimed.id, {
      expectedRevision: claimed.revision,
      state: "completed",
      reason: "user_accepted",
    });
    expect(accepted.state).toBe("completed");

    const blockedBackend = await backendAt("vspi-goal-blocked-");
    const blockedStart = await blockedBackend.create(input());
    const blocked = await blockedBackend.block(blockedStart.id, {
      expectedRevision: blockedStart.revision,
      reason: "Source volume is unavailable",
      attempts: ["Checked mounted volumes", "Checked project assets"],
      neededInput: "Mount or provide the source volume",
    });
    expect(blocked).toMatchObject({ state: "blocked", blocker: { neededInput: "Mount or provide the source volume" } });
    const resumed = await blockedBackend.transition(blocked.id, {
      expectedRevision: blocked.revision,
      state: "executing",
      reason: "user_resumed",
      owner: input().owner,
    });
    expect(resumed.state).toBe("executing");
    expect(resumed.blocker).toBeUndefined();
    const cancelled = await blockedBackend.transition(resumed.id, {
      expectedRevision: resumed.revision,
      state: "cancelled",
      reason: "user_cancelled",
    });
    expect(cancelled.state).toBe("cancelled");
  });

  it("stops at no-progress, round and token bounds without claiming completion", async () => {
    async function advance(
      overrides: Partial<GoalInput["limits"]>,
      rounds: Array<{ consumedTokens: number; progressed: boolean }>,
    ): Promise<StoredGoal> {
      const backend = await backendAt("vspi-goal-bounds-");
      let goal = await backend.create(input({ limits: { ...input().limits, ...overrides } }));
      for (const round of rounds) {
        goal = await backend.recordRound(goal.id, { expectedRevision: goal.revision, ...round });
        if (goal.state !== "executing") break;
      }
      return goal;
    }

    await expect(
      advance({ maxNoProgressRounds: 2 }, [
        { consumedTokens: 10, progressed: false },
        { consumedTokens: 20, progressed: false },
      ]),
    ).resolves.toMatchObject({ state: "stalled", stateReason: "no_progress" });
    await expect(
      advance({ maxAutoRounds: 2 }, [
        { consumedTokens: 10, progressed: true },
        { consumedTokens: 20, progressed: true },
      ]),
    ).resolves.toMatchObject({ state: "paused", stateReason: "round_budget" });
    await expect(advance({ maxTokens: 1_000 }, [{ consumedTokens: 1_000, progressed: true }])).resolves.toMatchObject({
      state: "paused",
      stateReason: "token_budget",
    });
  });

  it("rejects terminal-control text and symlinked storage roots", async () => {
    const backend = await backendAt("vspi-goal-controls-");
    await expect(
      backend.create(input({ contract: { objective: "unsafe\u001b[2J", completionCriteria: ["done"] } })),
    ).rejects.toThrow(/objective is invalid/i);

    const root = await mkdtemp(join(tmpdir(), "vspi-goal-symlink-"));
    const target = join(root, "outside");
    await mkdir(target);
    await symlink(target, join(root, "goals"));
    const linked = createGoalBackend({ rootDir: root });
    await expect(linked.create(input())).rejects.toThrow(/ordinary directory/i);
  });

  it("does not let bookkeeping checkpoints reset the no-progress counter", async () => {
    const backend = await backendAt("vspi-goal-marker-progress-");
    const created = await backend.create(input());
    const first = await backend.recordRound(created.id, {
      expectedRevision: created.revision,
      consumedTokens: 10,
      progressed: false,
    });
    const marked = await backend.checkpoint(first.id, {
      expectedRevision: first.revision,
      currentItem: "Chapter 1",
      completedWork: [],
      evidence: [],
    });
    expect(marked.noProgressRounds).toBe(1);
    const second = await backend.recordRound(marked.id, {
      expectedRevision: marked.revision,
      consumedTokens: 20,
      progressed: false,
    });
    expect(second).toMatchObject({ state: "stalled", noProgressRounds: 2 });
  });

  it("starts a fresh bounded run window on explicit resume while preserving markers", async () => {
    const backend = await backendAt("vspi-goal-resume-window-");
    const created = await backend.create(input({ limits: { ...input().limits, maxAutoRounds: 1 } }));
    const marked = await backend.checkpoint(created.id, {
      expectedRevision: created.revision,
      completedWork: ["Chapter 1"],
      evidence: ["index/01.md"],
    });
    const bounded = await backend.recordRound(marked.id, {
      expectedRevision: marked.revision,
      consumedTokens: 9_000,
      progressed: true,
    });
    expect(bounded).toMatchObject({ state: "paused", autoRounds: 1, consumedTokens: 9_000 });
    const resumed = await backend.transition(bounded.id, {
      expectedRevision: bounded.revision,
      state: "executing",
      reason: "user_resumed",
      owner: input().owner,
      initialTokens: 20_000,
    });
    expect(resumed).toMatchObject({
      state: "executing",
      autoRounds: 0,
      noProgressRounds: 0,
      consumedTokens: 0,
      initialTokens: 20_000,
    });
    expect(resumed.markers).toEqual(bounded.markers);
  });
});
