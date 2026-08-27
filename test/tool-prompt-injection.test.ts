import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiAgentManager } from "../src/agents/manager.js";
import { CronRuntime } from "../src/cron/runtime.js";
import { createCronToolDefinitions } from "../src/cron/tools.js";
import { createExecutionPolicyService } from "../src/policy/execution-policy.js";

describe("Subagent and Cron prompt injection", () => {
  it("places active capability snippets and autonomous scheduling guidance in Pi's real system prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-tool-prompt-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const services = await createAgentSessionServices({ cwd, agentDir });
    const manager = await PiAgentManager.create({
      cwd,
      agentDir,
      trustedProject: false,
      recovery: false,
      modelRuntime: services.modelRuntime,
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
    });
    const runtime = await CronRuntime.restore({
      store: { read: () => [], append: () => {} },
      isIdle: () => true,
      injectPrompt: () => {},
    });
    const cron = createCronToolDefinitions(runtime);
    const subagent = manager.createTool(["read"], true);
    const tools = [...cron, subagent];
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: tools as ToolDefinition[],
      tools: tools.map((tool) => tool.name),
    });
    try {
      expect(session.systemPrompt).toContain("CronCreate: Schedule visible recurring or one-shot prompts");
      expect(session.systemPrompt).toContain("expected model quota or budget recovery");
      expect(session.systemPrompt).toContain("do not use shell sleep as a scheduler");
      expect(session.systemPrompt).toContain("subagent: Run foreground or background delegated agents");
      expect(session.systemPrompt).toContain("completion is delivered automatically");
    } finally {
      session.dispose();
      await manager.dispose();
    }
  });
});
