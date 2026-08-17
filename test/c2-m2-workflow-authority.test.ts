import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("C2 M2 single Workflow authority", () => {
  it("wires workspace Local Plan only when Workflow and Recovery are both inactive", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const startup = await readFile(new URL("../src/plans/startup.ts", import.meta.url), "utf8");

    expect(source).toMatch(/createStartupLocalPlanBackend/);
    expect(startup).toMatch(/createLocalPlanBackend/);
    expect(startup).toMatch(/vspi-local-plans/);
    expect(startup).toMatch(/input\.recovery\s*\|\|\s*input\.workflow/);
    expect(source).toMatch(/localPlanBackend[\s\S]{0,500}workflowPlan:\s*workflowAdapter/);
    expect(source).not.toMatch(/createDefaultPlanTaskRouter|\bplanTaskRouter\s*:/);
    expect(source).toMatch(/\bworkflowAdapter\s*[,}]/);
  });

  it("keeps mutation tools authority-scoped and reads mutable state through continuity_status", async () => {
    const source = await readFile(new URL("../src/backend/pi-runtime-backend.ts", import.meta.url), "utf8");

    expect(source).toMatch(/getPlanBinding\(\)[\s\S]{0,120}!this\.options\.planBackend/);
    expect(source).toMatch(/bindPlan\([^)]*\)[\s\S]{0,180}Local Plan compatibility is not enabled/);
    expect(source).toMatch(/this\.options\.planBackend\s*\?\s*createPlanToolDefinitions/);
    expect(source).toMatch(/\.\.\.planTools\.map\(\(tool\)\s*=>\s*tool\.name\)/);
    expect(source).toMatch(/createContinuityStatusTool/);
    expect(source).toMatch(/continuityStatusTool\.name/);
    expect(source).not.toMatch(/create(?:PlanCapsule|GoalCapsule|WorkflowPlan|ReviewReminder)Extension/);
  });
});
