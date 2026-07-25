import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("C2 M2 single Workflow authority", () => {
  it("does not wire Local Plan storage or routing into any production entry", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/createLocalPlanBackend|createDefaultPlanTaskRouter|vspi-local-plans/);
    expect(source).not.toMatch(/\bplanBackend\s*[,}]/);
    expect(source).not.toMatch(/\bplanTaskRouter\s*:/);
    expect(source).toMatch(/\bworkflowAdapter\s*[,}]/);
  });

  it("keeps historical Local Plan bindings inert unless compatibility storage is explicitly injected", async () => {
    const source = await readFile(new URL("../src/backend/pi-runtime-backend.ts", import.meta.url), "utf8");

    expect(source).toMatch(/getPlanBinding\(\)[\s\S]{0,120}!this\.options\.planBackend/);
    expect(source).toMatch(/bindPlan\([^)]*\)[\s\S]{0,180}Local Plan compatibility is not enabled/);
    expect(source).not.toMatch(/createPlanToolDefinitions/);
    expect(source).toMatch(/tools:\s*\["read", "ls", "find", "grep", "bash", "edit", "write", "question"\]/);
  });
});
