import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ReviewSnapshot } from "../src/continuity/review-tracker.js";
import { createContinuityStatusTool } from "../src/continuity/status-tool.js";
import type { StoredGoal } from "../src/goals/types.js";
import type { StoredPlan } from "../src/plans/types.js";
import type { WorkflowSnapshot } from "../src/workflow/types.js";

const REVIEW: ReviewSnapshot = {
  meaningfulTurns: 4,
  workEvents: 2,
  needsReview: true,
  reasons: ["resume"],
};

const PLAN: StoredPlan = {
  id: "plan-17",
  title: "Stable prompt",
  goal: "Keep mutable continuity state out of the system prompt",
  background: "PRIVATE_PLAN_BODY",
  challenges: ["PRIVATE_PLAN_NOTES"],
  items: [{ id: "m2", title: "Add status tool", status: "in_progress" }],
  focusItemId: "m2",
  blockers: ["Waiting for focused tests"],
  nextAction: "Run the continuity contract",
  revision: 7,
  semanticHash: "PRIVATE_PLAN_HASH",
  archived: false,
};

const GOAL: StoredGoal = {
  id: "goal-17",
  revision: 5,
  semanticHash: "PRIVATE_GOAL_HASH",
  contract: {
    objective: "Verify stable payloads",
    completionCriteria: ["Focused tests pass"],
  },
  planId: PLAN.id,
  limits: { maxAutoRounds: 24, maxNoProgressRounds: 3, maxTokens: 500_000 },
  owner: {
    sessionId: "PRIVATE_SESSION_CREDENTIAL",
    processId: "PRIVATE_PROCESS_ID",
    acquiredAt: "2026-08-17T12:00:00.000Z",
  },
  initialTokens: 100,
  state: "executing",
  autoRounds: 3,
  noProgressRounds: 0,
  consumedTokens: 42_000,
  markers: [
    {
      sequence: 1,
      recordedAt: "2026-08-17T12:01:00.000Z",
      currentItem: "m2",
      completedWork: ["Removed dynamic capsules"],
      evidence: ["Typecheck passed"],
      nextItem: "Add contract tests",
    },
  ],
  stateReason: "PRIVATE_STATE_BODY",
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:01:00.000Z",
};

const WORKFLOW: WorkflowSnapshot = {
  status: "ready",
  diagnostic: "PRIVATE_WORKFLOW_DIAGNOSTIC at /private/workflow/root",
  projection: { scope: "workspace", access: "read-only" },
  identity: {
    version: "15.0.0",
    sourceCommit: "PRIVATE_COMMIT",
    archiveSha256: "PRIVATE_ARCHIVE_HASH",
    contractVersion: "1",
    root: "/private/workflow/root",
  },
  workspaceId: "PRIVATE_WORKSPACE_ID",
  delivery: {
    id: "C17",
    kind: "plan",
    status: "active",
    revision: 9,
    planHash: "PRIVATE_WORKFLOW_PLAN_BODY",
    milestones: [
      { id: "M1", title: "Telemetry", status: "completed" },
      { id: "M2", title: "Stable prompt", status: "in_progress" },
    ],
    currentMilestoneId: "M2",
  },
};

function createTool(input: {
  plan?: StoredPlan;
  goal?: StoredGoal;
  workflow?: WorkflowSnapshot;
  review?: ReviewSnapshot;
  checkpoint?: string;
}) {
  return createContinuityStatusTool({
    readPlanBinding: () => (input.plan ? { planId: input.plan.id } : undefined),
    readPlan: async () => input.plan,
    readGoalBinding: () => (input.goal ? { goalId: input.goal.id } : undefined),
    readGoal: async () => input.goal,
    readWorkflow: async () => input.workflow,
    readReview: () => input.review ?? { meaningfulTurns: 0, workEvents: 0, needsReview: false, reasons: [] },
    resolveCheckpoint: async () => input.checkpoint,
  });
}

async function execute(tool: ToolDefinition) {
  return tool.execute("continuity-status-test", {}, undefined, undefined, {} as never);
}

function payload(result: Awaited<ReturnType<typeof execute>>) {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("continuity_status must return text content");
  return JSON.parse(content.text) as unknown;
}

describe("continuity_status tool", () => {
  it("reads an empty state without requiring or resolving any IDs", async () => {
    const readPlan = vi.fn(async () => undefined);
    const readGoal = vi.fn(async () => undefined);
    const tool = createContinuityStatusTool({
      readPlanBinding: () => undefined,
      readPlan,
      readGoalBinding: () => undefined,
      readGoal,
      readWorkflow: async () => undefined,
      readReview: () => ({ meaningfulTurns: 0, workEvents: 0, needsReview: false, reasons: [] }),
      resolveCheckpoint: async () => undefined,
    });

    const result = await execute(tool);

    expect(payload(result)).toEqual({
      authority: "none",
      workflow: { status: "unavailable" },
      plan: null,
      goal: null,
      review: { meaningfulTurns: 0, workEvents: 0, needsReview: false, reasons: [] },
      checkpoint: null,
    });
    expect(result.details).toEqual(payload(result));
    expect(readPlan).not.toHaveBeenCalled();
    expect(readGoal).not.toHaveBeenCalled();
  });

  it.each([
    ["hypo-workflow", { plan: PLAN, goal: GOAL, workflow: WORKFLOW }],
    ["local-plan", { plan: PLAN, goal: GOAL }],
    ["goal", { goal: GOAL }],
    ["none", {}],
  ] as const)("selects %s as the highest available authority", async (authority, input) => {
    expect(payload(await execute(createTool(input)))).toMatchObject({ authority });
  });

  it("projects workflow, plan, goal, review, and checkpoint as one bounded snapshot", async () => {
    const result = await execute(
      createTool({
        plan: PLAN,
        goal: GOAL,
        workflow: WORKFLOW,
        review: REVIEW,
        checkpoint: "reconcile M2 before continuing",
      }),
    );
    const projected = {
      authority: "hypo-workflow",
      workflow: {
        status: "ready",
        delivery: {
          id: "C17",
          kind: "plan",
          status: "active",
          revision: 9,
          milestones: [
            { id: "M1", title: "Telemetry", status: "completed" },
            { id: "M2", title: "Stable prompt", status: "in_progress" },
          ],
          currentMilestoneId: "M2",
        },
      },
      plan: {
        id: "plan-17",
        revision: 7,
        goal: "Keep mutable continuity state out of the system prompt",
        items: [{ id: "m2", title: "Add status tool", status: "in_progress" }],
        focusItemId: "m2",
        blockers: ["Waiting for focused tests"],
        nextAction: "Run the continuity contract",
      },
      goal: {
        id: "goal-17",
        revision: 5,
        contract: { objective: "Verify stable payloads", completionCriteria: ["Focused tests pass"] },
        state: "executing",
        limits: { maxAutoRounds: 24, maxNoProgressRounds: 3, maxTokens: 500_000 },
        autoRounds: 3,
        noProgressRounds: 0,
        consumedTokens: 42_000,
        latestMarker: {
          sequence: 1,
          recordedAt: "2026-08-17T12:01:00.000Z",
          currentItem: "m2",
          completedWork: ["Removed dynamic capsules"],
          evidence: ["Typecheck passed"],
          nextItem: "Add contract tests",
        },
        blocker: null,
      },
      review: REVIEW,
      checkpoint: "reconcile M2 before continuing",
    };

    expect(payload(result)).toEqual(projected);
    expect(result.details).toEqual(projected);
    const serialized = JSON.stringify(result);
    for (const excluded of [
      "PRIVATE_PLAN_BODY",
      "PRIVATE_PLAN_NOTES",
      "PRIVATE_PLAN_HASH",
      "PRIVATE_GOAL_HASH",
      "PRIVATE_SESSION_CREDENTIAL",
      "PRIVATE_PROCESS_ID",
      "PRIVATE_STATE_BODY",
      "/private/workflow/root",
      "PRIVATE_COMMIT",
      "PRIVATE_ARCHIVE_HASH",
      "PRIVATE_WORKSPACE_ID",
      "PRIVATE_WORKFLOW_PLAN_BODY",
      "PRIVATE_WORKFLOW_DIAGNOSTIC",
    ]) {
      expect(serialized).not.toContain(excluded);
    }
  });

  it("keeps the no-argument schema and tool metadata stable across mutable state", () => {
    const empty = createTool({});
    const populated = createTool({ plan: PLAN, goal: GOAL, workflow: WORKFLOW, review: REVIEW });

    expect({
      name: empty.name,
      label: empty.label,
      description: empty.description,
      parameters: empty.parameters,
    }).toEqual({
      name: populated.name,
      label: populated.label,
      description: populated.description,
      parameters: populated.parameters,
    });
    expect(empty.parameters).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
  });
});
