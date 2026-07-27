import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStartupLocalPlanBackend } from "../src/plans/startup.js";
import type { PlanInput } from "../src/plans/types.js";

const PLAN: PlanInput = {
  title: "Workspace continuity",
  goal: "Keep one durable plan authority",
  challenges: [],
  items: [{ id: "wire", title: "Wire startup", status: "in_progress" }],
  focusItemId: "wire",
  blockers: [],
  nextAction: "Run startup tests",
};

describe("startup Local Plan authority", () => {
  it("persists within one workspace and isolates different workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-plan-startup-"));
    const agentDir = join(root, "agent");
    const first = createStartupLocalPlanBackend({
      workspace: join(root, "workspace-a"),
      agentDir,
      recovery: false,
      workflow: false,
    });
    if (!first) throw new Error("Local Plan backend was not created");
    const created = await first.create(PLAN);

    const reopened = createStartupLocalPlanBackend({
      workspace: join(root, "workspace-a"),
      agentDir,
      recovery: false,
      workflow: false,
    });
    const isolated = createStartupLocalPlanBackend({
      workspace: join(root, "workspace-b"),
      agentDir,
      recovery: false,
      workflow: false,
    });

    await expect(reopened?.read(created.id)).resolves.toMatchObject({ id: created.id, goal: PLAN.goal });
    await expect(isolated?.list()).resolves.toEqual([]);
  });

  it("does not construct Local Plan authority in Workflow or Recovery mode", () => {
    const base = { workspace: "/workspace", agentDir: "/agent" };
    expect(createStartupLocalPlanBackend({ ...base, recovery: false, workflow: true })).toBeUndefined();
    expect(createStartupLocalPlanBackend({ ...base, recovery: true, workflow: false })).toBeUndefined();
  });
});
