import { describe, expect, it, vi } from "vitest";
import { buildWorkflowPlanGuidance, createWorkflowPlanExtension } from "../src/continuity/workflow-plan.js";
import type { WorkflowSnapshot } from "../src/workflow/types.js";

const SNAPSHOT: WorkflowSnapshot = {
  status: "ready",
  diagnostic: "Workflow Core ready",
  projection: { scope: "workspace", access: "read-only" },
  delivery: {
    id: "release-vspi",
    kind: "plan",
    status: "executing",
    revision: 4,
    planHash: "a".repeat(64),
    currentMilestoneId: "M2",
    milestones: [
      { id: "M1", title: "Plan maintenance", status: "verified" },
      { id: "M2", title: "Runtime hooks", status: "executing", stone: true },
    ],
  },
};

describe("legacy Workflow plan maintenance hook (not runtime-registered)", () => {
  it("projects the active Delivery and forbids a competing Local Plan authority", () => {
    const guidance = buildWorkflowPlanGuidance(SNAPSHOT);
    expect(guidance).toContain('authority="hypo-workflow"');
    expect(guidance).toContain("release-vspi");
    expect(guidance).toContain("M2: [executing] Runtime hooks (Stone)");
    expect(guidance).toMatch(/最新|每次收到用户指令/);
    expect(guidance).toContain("不要创建或更新 VSPi Local Plan");
    expect(guidance.length).toBeLessThanOrEqual(2_000);
  });

  it("injects a hidden per-turn overlay and publishes the refreshed snapshot", async () => {
    let handler: ((event: { systemPrompt: string }) => Promise<{ systemPrompt?: string } | undefined>) | undefined;
    const onCapsule = vi.fn();
    createWorkflowPlanExtension({ snapshot: async () => SNAPSHOT, onCapsule })({
      on: (_event: string, next: unknown) => {
        handler = next as typeof handler;
      },
    } as never);
    if (!handler) throw new Error("Workflow plan extension did not register");

    const result = await handler({ systemPrompt: "Pi base" });
    expect(result?.systemPrompt).toContain("Pi base");
    expect(result?.systemPrompt).toContain("release-vspi");
    expect(onCapsule).toHaveBeenCalledWith(expect.stringContaining("release-vspi"), SNAPSHOT);
  });
});
