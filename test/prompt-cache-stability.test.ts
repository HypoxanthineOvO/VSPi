import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ReviewSnapshot } from "../src/continuity/review-tracker.js";
import { createContinuityStatusTool } from "../src/continuity/status-tool.js";
import type { StoredPlan } from "../src/plans/types.js";
import { createPromptProfileExtension } from "../src/prompts/pi-prompt-profile-extension.js";
import type { WorkflowSnapshot } from "../src/workflow/types.js";

type PromptHandler = (event: {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: Record<string, unknown>;
}) => Promise<{ systemPrompt?: string } | undefined>;

function promptHandler(options: { identity(): { provider: string; model: string }; overlay(): string }): PromptHandler {
  let handler: PromptHandler | undefined;
  createPromptProfileExtension({
    resolve: async () => ({ profileId: "stable-profile", overlay: options.overlay() }),
    getModelIdentity: options.identity,
  })({
    on(event: string, next: unknown) {
      if (event === "before_agent_start") handler = next as PromptHandler;
    },
  } as never);
  if (!handler) throw new Error("before_agent_start handler was not registered");
  return handler;
}

async function execute(tool: ToolDefinition) {
  return tool.execute("call", {}, undefined, undefined, {} as never);
}

function requestSurface(prompt: Awaited<ReturnType<PromptHandler>>, tool: ToolDefinition) {
  return {
    systemPrompt: prompt?.systemPrompt,
    tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
  };
}

const PLAN: StoredPlan = {
  id: "release-plan",
  title: "Release",
  goal: "dynamic plan objective",
  challenges: [],
  items: [{ id: "M2", title: "Stabilize prompt", status: "in_progress" }],
  focusItemId: "M2",
  blockers: [],
  nextAction: "Run the next status query",
  revision: 2,
  semanticHash: "plan-hash",
  archived: false,
};

const WORKFLOW: WorkflowSnapshot = {
  status: "ready",
  diagnostic: "Workflow ready",
  delivery: {
    id: "C17",
    kind: "plan",
    status: "executing",
    revision: 3,
    planHash: "workflow-hash",
    milestones: [{ id: "M2", title: "Stable prompt", status: "executing" }],
    currentMilestoneId: "M2",
  },
};

describe("C17 prompt cache stability", () => {
  it("keeps three same-epoch prompt payloads stable while mutable continuity is read as tool data", async () => {
    let identity = { provider: "deepseek", model: "v4-pro" };
    let overlay = "Stable DeepSeek profile";
    let plan: StoredPlan | undefined;
    let workflow: WorkflowSnapshot | undefined;
    let review: ReviewSnapshot = { meaningfulTurns: 0, workEvents: 0, needsReview: false, reasons: [] };
    let checkpoint: string | undefined;
    const handler = promptHandler({ identity: () => identity, overlay: () => overlay });
    const statusTool = createContinuityStatusTool({
      readPlanBinding: () => (plan ? { planId: plan.id } : undefined),
      readPlan: async () => plan,
      readGoalBinding: () => undefined,
      readGoal: async () => undefined,
      readWorkflow: async () => workflow,
      readReview: () => review,
      resolveCheckpoint: async () => checkpoint,
    });
    const event = {
      type: "before_agent_start" as const,
      prompt: "continue",
      systemPrompt: "Stable Pi base prompt and tools",
      systemPromptOptions: { cwd: "/workspace" },
    };

    const firstPrompt = await handler(event);
    const firstSchema = structuredClone(statusTool.parameters);
    const firstStatus = await execute(statusTool);

    plan = PLAN;
    review = { meaningfulTurns: 4, workEvents: 0, needsReview: true, reasons: ["resume"] };
    checkpoint = "reconcile revision 2";
    const secondPrompt = await handler(event);
    const secondSchema = structuredClone(statusTool.parameters);
    const secondStatus = await execute(statusTool);

    workflow = WORKFLOW;
    review = { meaningfulTurns: 4, workEvents: 1, needsReview: true, reasons: ["compaction"] };
    checkpoint = undefined;
    const thirdPrompt = await handler(event);
    const thirdSchema = structuredClone(statusTool.parameters);
    const thirdStatus = await execute(statusTool);

    const requestSurfaces = [firstPrompt, secondPrompt, thirdPrompt].map((prompt) =>
      requestSurface(prompt, statusTool),
    );
    expect([secondPrompt, thirdPrompt]).toEqual([firstPrompt, firstPrompt]);
    expect([secondSchema, thirdSchema]).toEqual([firstSchema, firstSchema]);
    expect(requestSurfaces).toEqual([requestSurfaces[0], requestSurfaces[0], requestSurfaces[0]]);
    expect(requestSurfaces.map((surface) => JSON.stringify(surface))).toEqual([
      JSON.stringify(requestSurfaces[0]),
      JSON.stringify(requestSurfaces[0]),
      JSON.stringify(requestSurfaces[0]),
    ]);
    expect(firstPrompt?.systemPrompt).not.toContain(PLAN.goal);
    expect(firstPrompt?.systemPrompt).not.toContain(WORKFLOW.delivery?.id);
    expect([firstStatus.details, secondStatus.details, thirdStatus.details]).toEqual([
      expect.objectContaining({ authority: "none", plan: null, checkpoint: null }),
      expect.objectContaining({ authority: "local-plan", plan: expect.objectContaining({ revision: 2 }) }),
      expect.objectContaining({ authority: "hypo-workflow", workflow: expect.objectContaining({ status: "ready" }) }),
    ]);
    expect(secondStatus.content).toEqual([{ type: "text", text: JSON.stringify(secondStatus.details) }]);
    const existingHistory = [{ role: "user", content: "continue" }];
    const nextHistory = [
      ...existingHistory,
      { role: "toolResult", toolName: statusTool.name, content: secondStatus.content },
    ];
    expect(nextHistory.slice(0, -1)).toEqual(existingHistory);
    expect(nextHistory.at(-1)).toEqual({
      role: "toolResult",
      toolName: "continuity_status",
      content: secondStatus.content,
    });

    identity = { provider: "deepseek", model: "v4-flash" };
    overlay = "Stable DeepSeek Flash profile";
    const switchedPrompt = await handler(event);
    expect(switchedPrompt).not.toEqual(firstPrompt);
    expect(await handler(event)).toEqual(switchedPrompt);
  });
});
