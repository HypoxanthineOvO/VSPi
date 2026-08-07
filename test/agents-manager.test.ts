import { mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { defaultAgentProjectConfig, saveAgentProjectConfig } from "../src/agents/config.js";
import { PiAgentManager } from "../src/agents/manager.js";
import type { AgentStatusEvent } from "../src/agents/types.js";
import { createExecutionPolicyService } from "../src/policy/execution-policy.js";

function fakeSession(prompt: (text: string) => Promise<string>): AgentSession {
  const messages: unknown[] = [];
  return {
    messages,
    subscribe(_callback: (event: AgentSessionEvent) => void) {
      return () => undefined;
    },
    async prompt(text: string) {
      const output = await prompt(text);
      const message = {
        role: "assistant",
        content: [{ type: "text", text: output }],
        stopReason: "stop",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: 0.01 },
        },
      };
      messages.push(message);
    },
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function stoppedSession(stopReason: "error" | "aborted", errorMessage: string): AgentSession {
  const messages = [
    {
      role: "assistant",
      content: [],
      stopReason,
      errorMessage,
    },
  ];
  return {
    messages,
    subscribe() {
      return () => undefined;
    },
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function fakeRuntime(): ModelRuntime {
  return catalogRuntime(["openai/gpt-5", "openai/gpt-4", "deepseek/reasoner", "kimi/k2"]);
}

function catalogRuntime(selectors: string[]): ModelRuntime {
  const models = selectors.map((selector) => {
    const [provider, id] = selector.split("/") as [string, string];
    return { provider, id, name: id, input: ["text"] };
  });
  return {
    getModel(provider: string, id: string) {
      return models.find((model) => model.provider === provider && model.id === id);
    },
    getModels: () => models,
  } as unknown as ModelRuntime;
}

function fakeToolContext(cwd: string, parentText?: string, model = { provider: "openai", id: "gpt-5" }) {
  const sessionManager = SessionManager.inMemory(cwd);
  if (parentText) sessionManager.appendMessage({ role: "user", content: parentText, timestamp: Date.now() });
  return {
    model,
    thinkingLevel: "high",
    sessionManager,
  };
}

describe("PiAgentManager", () => {
  it("maps GPT, DeepSeek, and Kimi role pools from the real catalog shape", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-pools-"));
    const runtime = catalogRuntime([
      "vsplab/gpt-5.6-sol",
      "vsplab/gpt-5.6-terra",
      "vsplab/gpt-5.6-luna",
      "deepseek/deepseek-pro",
      "deepseek/deepseek-flash",
      "kimi/k3",
      "kimi/k2.6",
    ]);
    const chosen: string[] = [];
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: runtime,
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async (input) => {
        chosen.push(input.model);
        return fakeSession(async () => "done");
      },
    });

    const pools = manager.snapshot().pools;
    expect(pools.find((pool) => pool.provider === "vsplab")?.roles).toEqual({
      orchestrator: "vsplab/gpt-5.6-sol",
      researcher: "vsplab/gpt-5.6-luna",
      analyst: "vsplab/gpt-5.6-terra",
      worker: "vsplab/gpt-5.6-terra",
    });
    expect(pools.find((pool) => pool.provider === "deepseek")?.roles).toEqual({
      orchestrator: "deepseek/deepseek-pro",
      researcher: "deepseek/deepseek-pro",
      analyst: "deepseek/deepseek-pro",
      worker: "deepseek/deepseek-flash",
    });
    expect(pools.find((pool) => pool.provider === "kimi")?.roles).toEqual({
      orchestrator: "kimi/k3",
      researcher: "kimi/k3",
      analyst: "kimi/k3",
      worker: "kimi/k2.6",
    });

    const tool = manager.createTool(["read"], true);
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain("vsplab/gpt-5.6-luna");
    expect(schema).not.toContain("claude-3-5-sonnet");
    expect(schema).not.toContain("gemini-2.5-pro");
    await tool.execute(
      "research",
      { task: "Research the long document", role: "researcher" },
      undefined,
      undefined,
      fakeToolContext(cwd, undefined, { provider: "vsplab", id: "gpt-5.6-sol" }) as never,
    );
    await tool.execute(
      "audit",
      { task: "Audit the evidence", role: "analyst" },
      undefined,
      undefined,
      fakeToolContext(cwd, undefined, { provider: "vsplab", id: "gpt-5.6-luna" }) as never,
    );
    expect(chosen).toEqual(["vsplab/gpt-5.6-luna", "vsplab/gpt-5.6-terra"]);
    await manager.dispose();
  });

  it("exposes one required task shape and hides unavailable teammate fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-schema-"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    });

    const schema = manager.createTool(["read"], true).parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toContain("task");
    expect(schema.properties).not.toHaveProperty("tasks");
    expect(schema.properties).not.toHaveProperty("teammate");
    expect(schema.properties).not.toHaveProperty("lane");
    expect(JSON.stringify(schema.properties?.model)).not.toContain("claude-3-5-sonnet");
    await manager.dispose();
  });

  it("keeps the subagent schema bounded for large model catalogs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-large-catalog-"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: catalogRuntime(Array.from({ length: 1_000 }, (_, index) => `provider/model-${index}`)),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    });

    const schema = manager.createTool(["read"], true).parameters as {
      properties?: Record<string, { pattern?: string }>;
    };
    expect(JSON.stringify(schema).length).toBeLessThan(5_000);
    expect(schema.properties?.model?.pattern).toBe("^[A-Za-z0-9._-]+/[A-Za-z0-9._:+-]+$");
    expect(JSON.stringify(schema)).not.toContain("provider/model-999");
    await manager.dispose();
  });

  it("rejects no-op recursive probes before starting a model session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-noop-"));
    const sessionFactory = vi.fn(async () => fakeSession(async () => "unused"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory,
    });
    await expect(
      manager
        .createTool(["read"], true)
        .execute("noop", { task: "No-op." }, undefined, undefined, fakeToolContext(cwd) as never),
    ).rejects.toThrow("substantive work");
    expect(sessionFactory).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("exposes teammate fields only when the trusted project config defines one", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-teammate-schema-"));
    const config = defaultAgentProjectConfig();
    config.teammates.push({
      id: "researcher",
      role: "Researcher",
      description: "Research project questions",
      routing: "manual",
      match: [],
      systemPrompt: "Research carefully.",
      tools: ["read"],
      preferredModel: "openai/gpt-5",
      fallbackModels: [],
    });
    await saveAgentProjectConfig(cwd, true, config);
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    });

    const schema = manager.createTool(["read"], true).parameters as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("teammate");
    expect(schema.properties).toHaveProperty("lane");
    expect(schema.properties).not.toHaveProperty("tasks");
    await manager.dispose();
  });

  it("starts Task Agents with minimal context, inherited model/effort, and read-only default tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-manager-"));
    const sessions: Array<{ model: string; effort: string; tools: string[] }> = [];
    const prompts: string[] = [];
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async (input) => {
        sessions.push({ model: input.model, effort: input.effort, tools: input.tools });
        return fakeSession(async (prompt) => {
          prompts.push(prompt);
          return "isolated result";
        });
      },
    });
    const tool = manager.createTool(["read", "ls", "find", "grep", "bash", "edit", "write"], true);
    const result = await tool.execute(
      "call-1",
      { task: "Inspect the repository", context: "Only this context" },
      undefined,
      undefined,
      fakeToolContext(cwd, "PARENT_CONTEXT_MUST_NOT_LEAK") as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "isolated result" }]);
    expect(sessions).toEqual([{ model: "openai/gpt-5", effort: "high", tools: ["read", "ls", "find", "grep"] }]);
    expect(prompts[0]).toContain("Only this context");
    expect(prompts[0]).not.toContain("PARENT_CONTEXT_MUST_NOT_LEAK");
    await manager.dispose();
  });

  it("applies explicit runtime options and filters sensitive inherited context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-inherit-"));
    const sessions: Array<{
      model: string;
      effort: string;
      tools: string[];
      systemPrompt: string;
      instructions: string;
    }> = [];
    let childPrompt = "";
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async (input) => {
        sessions.push(input);
        return fakeSession(async (prompt) => {
          childPrompt = prompt;
          return "custom result";
        });
      },
    });
    const tool = manager.createTool(["read", "bash"], true);
    const result = await tool.execute(
      "call-inherit",
      {
        task: "Use the inherited facts",
        instructions: "Answer as an auditor",
        system_prompt: "Custom child system prompt",
        model: "deepseek/reasoner",
        effort: "xhigh",
        tools: ["read"],
        inherit_parent_context: true,
      },
      undefined,
      undefined,
      fakeToolContext(cwd, "Visible parent fact; api_key=supersecret; sk-1234567890abcdef") as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "custom result" }]);
    expect(sessions).toMatchObject([
      {
        model: "deepseek/reasoner",
        effort: "xhigh",
        tools: ["read"],
        systemPrompt: "Custom child system prompt",
        instructions: "Answer as an auditor",
      },
    ]);
    expect(childPrompt).toContain("Visible parent fact");
    expect(childPrompt).toContain("[redacted]");
    expect(childPrompt).not.toContain("supersecret");
    expect(childPrompt).not.toContain("sk-1234567890abcdef");
    expect(manager.snapshot().recent[0]?.contextMode).toBe("inherited");
    await manager.dispose();
  });

  it("honors an explicit subagent requirement for the whole root turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-required-"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "delegated"),
    });
    manager.beginRootTask("请使用 subagent 调研这个问题");
    expect(() => manager.assertRootTaskComplete()).toThrow("explicitly required");
    manager.beginRootTask("再补充一个输出格式要求", true);
    expect(() => manager.assertRootTaskComplete()).toThrow("explicitly required");
    await manager
      .createTool(["read"], true)
      .execute("required-call", { task: "Research" }, undefined, undefined, fakeToolContext(cwd) as never);
    expect(() => manager.assertRootTaskComplete()).not.toThrow();

    manager.beginRootTask("不要使用 subagent，直接回答");
    expect(() => manager.assertRootTaskComplete()).not.toThrow();
    await manager.dispose();
  });

  it("projects an aborted child generation as cancelled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-cancelled-"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => stoppedSession("aborted", "cancelled by user"),
    });
    await expect(
      manager
        .createTool(["read"], true)
        .execute("cancelled", { task: "Research" }, undefined, undefined, fakeToolContext(cwd) as never),
    ).rejects.toMatchObject({ name: "AbortError", message: "cancelled by user" });
    expect(manager.snapshot().recent[0]?.status).toBe("cancelled");
    await manager.dispose();
  });

  it("rejects tools beyond the parent allowlist and disables delegation in Recovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-policy-"));
    const options = {
      cwd,
      agentDir: cwd,
      trustedProject: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    };
    const manager = await PiAgentManager.create({ ...options, recovery: false });
    await expect(
      manager
        .createTool(["read"], true)
        .execute(
          "denied-tool",
          { task: "Write", tools: ["write"] },
          undefined,
          undefined,
          fakeToolContext(cwd) as never,
        ),
    ).rejects.toThrow("exceeds parent allowlist");
    await manager.dispose();

    const recovery = await PiAgentManager.create({ ...options, recovery: true });
    expect(recovery.snapshot()).toMatchObject({ enabled: false, recovery: true });
    await expect(
      recovery
        .createTool(["read"], true)
        .execute("recovery", { task: "Research" }, undefined, undefined, fakeToolContext(cwd) as never),
    ).rejects.toThrow("Recovery mode disables");
    await recovery.dispose();
  });

  it("falls back only after a quota error and reports the model change to the parent surface", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-fallback-"));
    const events: AgentStatusEvent[] = [];
    let attempt = 0;
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      onStatus: (event) => events.push(event),
      sessionFactory: async () =>
        fakeSession(async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("insufficient_quota: account credits exhausted");
          return "fallback result";
        }),
    });
    const tool = manager.createTool(["read", "ls", "find", "grep"], true);
    const result = await tool.execute(
      "call-2",
      { task: "Research", fallback_models: ["deepseek/reasoner"] },
      undefined,
      undefined,
      fakeToolContext(cwd) as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain(
      "Task Agent fallback: openai/gpt-5 -> deepseek/reasoner",
    );
    expect((result.content[0] as { text: string }).text).toContain("fallback result");
    expect(events.some((event) => event.fallbackNotice?.includes("openai/gpt-5 -> deepseek/reasoner"))).toBe(true);
    expect(manager.snapshot().recent[0]).toMatchObject({
      model: "deepseek/reasoner",
      fallbackReason: "quota_exhausted",
    });
    await manager.dispose();
  });

  it("does not treat a temporary rate limit as quota exhaustion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-rate-limit-"));
    let attempts = 0;
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () =>
        fakeSession(async () => {
          attempts += 1;
          throw new Error("429 temporary rate limit; retry later");
        }),
    });
    const tool = manager.createTool(["read"], true);
    await expect(
      tool.execute(
        "call-3",
        { task: "Research", fallback_models: ["deepseek/reasoner"] },
        undefined,
        undefined,
        fakeToolContext(cwd) as never,
      ),
    ).rejects.toThrow("temporary rate limit");
    expect(attempts).toBe(1);
    await manager.dispose();
  });

  it("persists Teammate fallback as a sticky binding until an explicit model switch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-teammate-fallback-"));
    const config = defaultAgentProjectConfig();
    config.teammates.push({
      id: "frontend",
      role: "Frontend",
      description: "Frontend owner",
      routing: "required",
      match: ["frontend"],
      systemPrompt: "Frontend role",
      tools: ["read"],
      preferredModel: "kimi/k2",
      fallbackModels: ["openai/gpt-5"],
    });
    const path = await saveAgentProjectConfig(cwd, true, config);
    let attempt = 0;
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () =>
        fakeSession(async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("quota exceeded for this billing account");
          return "frontend result";
        }),
    });
    const tool = manager.createTool(["read"], true);
    manager.beginRootTask("Implement the frontend change");
    expect(() =>
      manager.assertMainAction({ kind: "file-write", target: join(cwd, "src", "app.ts"), operation: "write" }),
    ).toThrow("Required teammate");
    expect(() => manager.assertRootTaskComplete()).toThrow("Required teammate");
    await tool.execute(
      "call-4",
      { task: "Implement frontend", teammate: "frontend", lane: "main" },
      undefined,
      undefined,
      fakeToolContext(cwd) as never,
    );
    expect(() =>
      manager.assertMainAction({ kind: "file-write", target: join(cwd, "src", "app.ts"), operation: "write" }),
    ).not.toThrow();
    expect(() => manager.assertRootTaskComplete()).not.toThrow();

    expect(JSON.parse(await readFile(path, "utf8")).teammates[0]).toMatchObject({
      currentModel: "openai/gpt-5",
      fallback: { from: "kimi/k2", reason: "quota_exhausted" },
    });
    await manager.switchTeammateModel("frontend", "kimi/k2");
    const switched = JSON.parse(await readFile(path, "utf8")).teammates[0];
    expect(switched.currentModel).toBe("kimi/k2");
    expect(switched.fallback).toBeUndefined();
    await manager.dispose();
  });

  it("rolls back an in-memory sticky fallback when config persistence fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-teammate-fallback-rollback-"));
    const config = defaultAgentProjectConfig();
    config.teammates.push({
      id: "frontend",
      role: "Frontend",
      description: "Frontend owner",
      routing: "manual",
      match: [],
      systemPrompt: "Frontend role",
      tools: ["read"],
      preferredModel: "kimi/k2",
      fallbackModels: ["openai/gpt-5"],
    });
    const configPath = await saveAgentProjectConfig(cwd, true, config);
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => Promise.reject(new Error("insufficient_quota"))),
    });
    const outside = join(await mkdtemp(join(tmpdir(), "vspi-agent-config-target-")), "agents.json");
    await writeFile(outside, "{}\n");
    await unlink(configPath);
    await symlink(outside, configPath);

    await expect(
      manager
        .createTool(["read"], true)
        .execute(
          "fallback-save-failure",
          { task: "Frontend", teammate: "frontend" },
          undefined,
          undefined,
          fakeToolContext(cwd) as never,
        ),
    ).rejects.toThrow("symlink");
    expect(manager.snapshot().teammates[0]).toMatchObject({ preferredModel: "kimi/k2", stickyFallback: false });
    expect(manager.snapshot().teammates[0]?.currentModel).toBeUndefined();
    await manager.dispose();
  });
});
