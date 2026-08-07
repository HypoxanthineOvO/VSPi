import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStartupGoalBackend } from "../src/goals/startup.js";

describe("Goal startup boundary", () => {
  it("is available only in normal local mode and remains workspace-scoped", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "vspi-goal-startup-"));
    const workspace = join(agentDir, "workspace-a");
    const normal = createStartupGoalBackend({ workspace, agentDir, recovery: false, workflow: false });
    expect(normal).toBeDefined();
    expect(createStartupGoalBackend({ workspace, agentDir, recovery: true, workflow: false })).toBeUndefined();
    expect(createStartupGoalBackend({ workspace, agentDir, recovery: false, workflow: true })).toBeUndefined();
    if (!normal) throw new Error("normal Goal backend unavailable");
    const goal = await normal.create({
      contract: { objective: "Startup contract", completionCriteria: ["Verified"] },
      planId: "plan-startup",
      limits: { maxAutoRounds: 2, maxNoProgressRounds: 1, maxTokens: 10_000 },
      owner: { sessionId: "session-1", processId: "process-1", acquiredAt: "2026-07-31T00:00:00.000Z" },
      initialTokens: 0,
    });
    const otherWorkspace = createStartupGoalBackend({
      workspace: join(agentDir, "workspace-b"),
      agentDir,
      recovery: false,
      workflow: false,
    });
    expect(await otherWorkspace?.read(goal.id)).toBeUndefined();
  });
});
