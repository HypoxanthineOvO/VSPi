import { describe, expect, it, vi } from "vitest";
import type { StoredPlan } from "../src/plans/types.js";

interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: Record<string, unknown>;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
  message?: unknown;
}

type BeforeAgentStartHandler = (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>;
type ExtensionFactory = (pi: { on(event: "before_agent_start", handler: BeforeAgentStartHandler): void }) => void;

async function capsuleModule() {
  const specifier = "../src/continuity/plan-capsule.js";
  return (await import(specifier)) as {
    buildPlanCapsule(plan: StoredPlan): string;
    createPlanCapsuleExtension(options: {
      readBinding(): Promise<{ planId: string } | undefined>;
      readPlan(planId: string): Promise<StoredPlan | undefined>;
    }): ExtensionFactory;
  };
}

function register(factory: ExtensionFactory): BeforeAgentStartHandler {
  let handler: BeforeAgentStartHandler | undefined;
  factory({
    on(event, next) {
      if (event === "before_agent_start") handler = next;
    },
  });
  if (!handler) throw new Error("Plan capsule extension did not register before_agent_start");
  return handler;
}

const PLAN: StoredPlan = {
  id: "release-plan",
  title: "Release VSPi",
  goal: "Ship a trustworthy terminal workflow",
  background: "Keep the active session useful across long-running work",
  challenges: ["Bounded context", "Crash recovery"],
  items: [
    { id: "done", title: "Implement profiles", status: "done" },
    { id: "focus", title: "Wire continuity", status: "in_progress" },
    { id: "blocked", title: "Run external audit", status: "blocked", blocker: "Waiting for reviewer" },
  ],
  focusItemId: "focus",
  blockers: ["Waiting for reviewer"],
  nextAction: "Run focused continuity tests",
  revision: 8,
  semanticHash: "sha256:m8-contract",
  archived: false,
};

function event(systemPrompt = "Pi base prompt"): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt,
    systemPromptOptions: { cwd: "/workspace" },
  };
}

describe("M8 legacy Local Plan capsule builder (not runtime-registered)", () => {
  it("projects only execution continuity facts and immutable provenance within about 2K tokens", async () => {
    const { buildPlanCapsule } = await capsuleModule();
    const capsule = buildPlanCapsule(PLAN);

    expect(capsule).toContain(PLAN.goal);
    expect(capsule).toContain("Wire continuity");
    expect(capsule).toContain("in_progress");
    expect(capsule).toContain("Waiting for reviewer");
    expect(capsule).toContain(PLAN.nextAction);
    expect(capsule).toMatch(/revision[^\n]*8/i);
    expect(capsule).toContain(PLAN.semanticHash);
    expect(capsule).toMatch(/source[^\n]*(local plan|release-plan)/i);
    expect(capsule.length).toBeLessThanOrEqual(8_000);
  });

  it("injects the capsule only as a per-turn system overlay for a bound Plan", async () => {
    const { createPlanCapsuleExtension } = await capsuleModule();
    const readPlan = vi.fn(async () => PLAN);
    const handler = register(
      createPlanCapsuleExtension({
        readBinding: async () => ({ planId: PLAN.id }),
        readPlan,
      }),
    );

    const result = await handler(event());

    expect(readPlan).toHaveBeenCalledWith(PLAN.id);
    expect(result?.systemPrompt).toContain("Pi base prompt");
    expect(result?.systemPrompt).toContain(PLAN.goal);
    expect(result?.systemPrompt).toContain("plan_update");
    expect(result?.systemPrompt).toMatch(/用户指令|latest user instruction/i);
    expect(result?.systemPrompt).toMatch(/不是本轮工作的终点|never overrides newer evidence/i);
    expect(result?.systemPrompt).toMatch(/未修复 bug|重开相关项/u);
    expect(result).not.toHaveProperty("message");
    expect(Object.keys(result ?? {})).toEqual(["systemPrompt"]);
  });

  it("injects bounded plan-creation guidance when the session has no Plan binding", async () => {
    const { createPlanCapsuleExtension } = await capsuleModule();
    const readPlan = vi.fn(async () => PLAN);
    const handler = register(
      createPlanCapsuleExtension({
        readBinding: async () => undefined,
        readPlan,
      }),
    );

    const result = await handler(event());
    expect(result?.systemPrompt).toContain("Pi base prompt");
    expect(result?.systemPrompt).toContain("plan_create");
    expect(result?.systemPrompt).toContain("plan_bind");
    expect(result?.systemPrompt).toMatch(/简单问答|一次性小改动/);
    expect(result).not.toHaveProperty("message");
    expect(readPlan).not.toHaveBeenCalled();
  });
});
