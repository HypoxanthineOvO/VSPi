import { describe, expect, it, vi } from "vitest";
import { createHypoWorkflowAdapter } from "../src/workflow/hypo-adapter.js";
import type { LoadedWorkflowCore, WorkflowCoreModule } from "../src/workflow/types.js";

describe("C2 M3 read-only Workflow session isolation", () => {
  it("projects one workspace Delivery without creating Session or Workstream write state", async () => {
    const resume = vi.fn(async () => ({
      delivery: {
        object_ref: { kind: "delivery", id: "workspace-delivery" },
        delivery_kind: "cycle",
        status: "executing",
        revision: 2,
        plan_hash: "a".repeat(64),
        milestones: [{ id: "M3", title: "Isolation", status: "executing" }],
      },
    }));
    const createWorkstreamStore = vi.fn(() => {
      throw new Error("read-only adapter must never construct a Workstream store");
    });
    const core = {
      createDeliveryStore: () => ({ resume }),
      createWorkstreamStore,
      compileVspiIntegrationContract: (value: { generated_at: string }) => value,
      parseVspiIntegrationContract: (value: unknown) => value,
      verifyPortableBundle: async () => ({ files: [] }),
    } satisfies WorkflowCoreModule;
    const loaded: LoadedWorkflowCore = {
      core,
      identity: {
        version: "14.0.0-test.1",
        sourceCommit: "b".repeat(40),
        archiveSha256: "c".repeat(64),
        contractVersion: "1",
        root: "/workflow/core",
      },
    };
    const adapter = createHypoWorkflowAdapter({ workspace: "/workspace/project", loaded });

    await expect(adapter.snapshot()).resolves.toMatchObject({
      projection: { scope: "workspace", access: "read-only" },
      delivery: { id: "workspace-delivery", currentMilestoneId: "M3" },
    });
    await expect(adapter.snapshot()).resolves.toMatchObject({ delivery: { id: "workspace-delivery" } });
    await expect(adapter.authorize({ kind: "workflow-authority", operation: "record-evidence" })).resolves.toBe(false);

    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenNthCalledWith(1, "/workspace/project", {});
    expect(resume).toHaveBeenNthCalledWith(2, "/workspace/project", {});
    expect(createWorkstreamStore).not.toHaveBeenCalled();
  });
});
