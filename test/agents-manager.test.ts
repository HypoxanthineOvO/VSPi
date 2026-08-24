import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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

const execFile = promisify(execFileCallback);

function fakeSession(prompt: (text: string) => Promise<string>, inputTokens = 2): AgentSession {
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
          input: inputTokens,
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

function abortControlledSession(onPrompt?: () => void): AgentSession {
  const messages: unknown[] = [];
  let resolvePrompt: (() => void) | undefined;
  let stopped = false;
  return {
    messages,
    subscribe() {
      return () => undefined;
    },
    prompt: vi.fn(async () => {
      onPrompt?.();
      await new Promise<void>((resolvePromise) => {
        resolvePrompt = resolvePromise;
      });
    }),
    abort: vi.fn(async () => {
      if (stopped) return;
      stopped = true;
      messages.push({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "cancelled" });
      resolvePrompt?.();
    }),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function stoppedSession(stopReason: "error" | "aborted", errorMessage: string, inputTokens = 0): AgentSession {
  const messages = [
    {
      role: "assistant",
      content: [],
      stopReason,
      errorMessage,
      usage: { input: inputTokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
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

    // C19 P0-3：Teammate Ban——即使配置里存在 teammate，schema 也不再暴露 teammate/lane 参数。
    const schema = manager.createTool(["read"], true).parameters as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).not.toHaveProperty("teammate");
    expect(schema.properties).not.toHaveProperty("lane");
    expect(schema.properties).not.toHaveProperty("tasks");
    // 配置本身仍可加载（数据保留）。
    expect(manager.snapshot().limits.maxDepth).toBe(3);
    await manager.dispose();
  });

  it("starts Task Agents with minimal context, inherited model/effort, and read-only default tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-manager-"));
    const sessions: Array<{ model: string; effort: string; tools: string[] }> = [];
    const prompts: string[] = [];
    const sessionFiles: Array<string | undefined> = [];
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async (input) => {
        sessions.push({ model: input.model, effort: input.effort, tools: input.tools });
        sessionFiles.push(input.manager.getSessionFile());
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
    expect(sessionFiles).toEqual([undefined]);
    await manager.dispose();
  });

  it("publishes a bounded redacted audit projection with usage and budget instead of a Session path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-audit-"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "Bearer audit-secret-token api_key=output-secret"),
    });
    await manager
      .createTool(["read"], true)
      .execute(
        "audit-projection",
        { task: "Audit api_key=task-secret" },
        undefined,
        undefined,
        fakeToolContext(cwd) as never,
      );
    const run = manager.snapshot().recent[0];
    expect(run).toMatchObject({
      provider: "openai",
      contextMode: "isolated",
      contextChars: 0,
      usage: { input: 2, output: 3, cacheRead: 1, turns: 1 },
      budget: { runTokensUsed: 6, treeTokensUsed: 6, maxRunTokens: 120_000, maxTreeTokens: 500_000 },
      status: "success",
    });
    expect(run?.timeline.map((event) => event.kind)).toEqual(["queued", "started", "completed"]);
    const audit = JSON.stringify(run);
    expect(audit).toContain("[redacted]");
    expect(audit).not.toContain("task-secret");
    expect(audit).not.toContain("audit-secret-token");
    expect(audit).not.toContain("output-secret");
    expect(audit).not.toContain(cwd);
    expect(run).not.toHaveProperty("sessionFile");
    await manager.dispose();
  });

  it("refreshes completed sibling projections with the final shared tree budget", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-tree-projection-"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "done"),
    });
    manager.beginRootTask("Run two checks");
    const tool = manager.createTool(["read"], true);
    await tool.execute("first", { task: "Check first area" }, undefined, undefined, fakeToolContext(cwd) as never);
    await tool.execute("second", { task: "Check second area" }, undefined, undefined, fakeToolContext(cwd) as never);
    expect(manager.snapshot().recent.map((run) => run.budget.treeTokensUsed)).toEqual([12, 12]);
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
        model: "openai/gpt-4",
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
        model: "openai/gpt-4",
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

  it("rejects cross-provider Task delegation before creating a Session when project policy disables it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-cross-provider-"));
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
        .execute(
          "cross-provider",
          { task: "Research", model: "deepseek/reasoner" },
          undefined,
          undefined,
          fakeToolContext(cwd) as never,
        ),
    ).rejects.toThrow("Cross-provider delegation is disabled");
    expect(sessionFactory).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("rejects full parent-history inheritance across Providers even when explicit delegation is enabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-cross-provider-inherit-"));
    const config = defaultAgentProjectConfig();
    config.crossProviderDelegation = true;
    await saveAgentProjectConfig(cwd, true, config);
    const sessionFactory = vi.fn(async () => fakeSession(async () => "unused"));
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory,
    });

    await expect(
      manager
        .createTool(["read"], true)
        .execute(
          "cross-provider-history",
          { task: "Research", model: "deepseek/reasoner", inherit_parent_context: true },
          undefined,
          undefined,
          fakeToolContext(cwd, "private parent history") as never,
        ),
    ).rejects.toThrow("Full parent context cannot cross Provider boundaries");
    expect(sessionFactory).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("allows only task and explicit context across Providers when project policy enables delegation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-cross-provider-explicit-"));
    const config = defaultAgentProjectConfig();
    config.crossProviderDelegation = true;
    await saveAgentProjectConfig(cwd, true, config);
    let prompt = "";
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async (input) =>
        fakeSession(async (received) => {
          expect(input.model).toBe("deepseek/reasoner");
          prompt = received;
          return "cross-provider result";
        }),
    });
    await manager
      .createTool(["read"], true)
      .execute(
        "cross-provider-explicit",
        { task: "Research remote facts", context: "share this fact", model: "deepseek/reasoner" },
        undefined,
        undefined,
        fakeToolContext(cwd, "private parent history") as never,
      );
    expect(prompt).toContain("share this fact");
    expect(prompt).not.toContain("private parent history");
    await manager.dispose();
  });

  it("no longer gates turns on keyword-detected subagent requirements (C19 P0-1)", async () => {
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
    // 讨论或要求 subagent 都不再形成回合末断言；主回答不会被 authority 否决。
    manager.beginRootTask("请使用 subagent 调研这个问题");
    expect(() => manager.assertRootTaskComplete()).not.toThrow();
    manager.beginRootTask("再补充一个输出格式要求", true);
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

  it("serializes all Bash boundaries across managers, including commands labelled read-only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-writer-"));
    const output = join(cwd, "writer-order.txt");
    const options = {
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    };
    const [firstManager, secondManager] = await Promise.all([
      PiAgentManager.create(options),
      PiAgentManager.create(options),
    ]);
    const first = firstManager.withToolBoundary({ kind: "process", operation: "read" }, async () => {
      await execFile(process.execPath, [
        "-e",
        "const {appendFileSync}=require('node:fs');appendFileSync(process.argv[1],'A');setTimeout(()=>appendFileSync(process.argv[1],'B'),100)",
        output,
      ]);
    });
    while (true) {
      try {
        if ((await readFile(output, "utf8")) === "A") break;
      } catch {}
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const second = secondManager.withToolBoundary({ kind: "process", operation: "read" }, async () => {
      await execFile(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1],'C')", output]);
    });
    await Promise.all([first, second]);
    expect(await readFile(output, "utf8")).toBe("ABC");
    await Promise.all([firstManager.dispose(), secondManager.dispose()]);
  });

  it("serializes the same file across managers without blocking writes to other files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-file-writer-"));
    const options = {
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    };
    const [firstManager, secondManager, thirdManager] = await Promise.all([
      PiAgentManager.create(options),
      PiAgentManager.create(options),
      PiAgentManager.create(options),
    ]);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolvePromise) => {
      markFirstStarted = resolvePromise;
    });
    const first = firstManager.withToolBoundary(
      { kind: "file-write", target: join(cwd, "same.txt"), operation: "write" },
      async () => {
        markFirstStarted();
        await new Promise<void>((resolvePromise) => {
          releaseFirst = resolvePromise;
        });
      },
    );
    await firstStarted;

    let sameFileStarted = false;
    const sameFile = secondManager.withToolBoundary(
      { kind: "file-write", target: join(cwd, "same.txt"), operation: "edit" },
      async () => {
        sameFileStarted = true;
      },
    );
    await thirdManager.withToolBoundary(
      { kind: "file-write", target: join(cwd, "other.txt"), operation: "write" },
      async () => undefined,
    );
    expect(sameFileStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, sameFile]);
    expect(sameFileStarted).toBe(true);
    await Promise.all([firstManager.dispose(), secondManager.dispose(), thirdManager.dispose()]);
  });

  it("does not make a file write wait for an unrelated Bash boundary in another manager", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-file-bash-"));
    const options = {
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    };
    const [firstManager, secondManager] = await Promise.all([
      PiAgentManager.create(options),
      PiAgentManager.create(options),
    ]);
    let releaseBash!: () => void;
    let markBashStarted!: () => void;
    const bashStarted = new Promise<void>((resolvePromise) => {
      markBashStarted = resolvePromise;
    });
    const bash = firstManager.withToolBoundary({ kind: "process", operation: "bash" }, async () => {
      markBashStarted();
      await new Promise<void>((resolvePromise) => {
        releaseBash = resolvePromise;
      });
    });
    await bashStarted;

    await expect(
      secondManager.withToolBoundary(
        { kind: "file-write", target: join(cwd, "independent.txt"), operation: "write" },
        async () => "written",
      ),
    ).resolves.toBe("written");

    releaseBash();
    await bash;
    await Promise.all([firstManager.dispose(), secondManager.dispose()]);
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
      { task: "Research", fallback_models: ["openai/gpt-4"] },
      undefined,
      undefined,
      fakeToolContext(cwd) as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("Task Agent fallback: openai/gpt-5 -> openai/gpt-4");
    expect((result.content[0] as { text: string }).text).toContain("fallback result");
    expect(events.some((event) => event.fallbackNotice?.includes("openai/gpt-5 -> openai/gpt-4"))).toBe(true);
    expect(manager.snapshot().recent[0]).toMatchObject({
      model: "openai/gpt-4",
      fallbackReason: "quota_exhausted",
    });
    await manager.dispose();
  });

  it("aggregates fallback attempt usage in the run and tree audit budget", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-fallback-usage-"));
    let attempt = 0;
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: false,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => {
        attempt += 1;
        return attempt === 1
          ? stoppedSession("error", "insufficient_quota", 10)
          : fakeSession(async () => "fallback complete");
      },
    });
    await manager
      .createTool(["read"], true)
      .execute(
        "fallback-usage",
        { task: "Research usage", fallback_models: ["openai/gpt-4"] },
        undefined,
        undefined,
        fakeToolContext(cwd) as never,
      );
    expect(manager.snapshot().recent[0]).toMatchObject({
      usage: { input: 12, output: 3, cacheRead: 1, cacheWrite: 0, turns: 2 },
      budget: { runTokensUsed: 16, treeTokensUsed: 16 },
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

  it("returns the real quota error without budget overriding it (C19 P0-2)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-failed-budget-"));
    const config = defaultAgentProjectConfig();
    config.maxRunTokens = 1_000;
    config.maxTreeTokens = 1_000;
    await saveAgentProjectConfig(cwd, true, config);
    let attempts = 0;
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => {
        attempts += 1;
        return stoppedSession("error", "insufficient_quota", 1_000);
      },
    });
    // 预算不再拦截：超限后仍尝试 fallback，最终上报原始 quota 错误而非预算错误。
    await expect(
      manager
        .createTool(["read"], true)
        .execute(
          "failed-budget",
          { task: "Research", fallback_models: ["openai/gpt-4"] },
          undefined,
          undefined,
          fakeToolContext(cwd) as never,
        ),
    ).rejects.toThrow("insufficient_quota");
    expect(attempts).toBe(2);
    await manager.dispose();
  });

  it("keeps a completed attempt's output despite exceeding the per-run token warning line (C19 P0-2)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-run-budget-"));
    const config = defaultAgentProjectConfig();
    config.maxRunTokens = 1_000;
    await saveAgentProjectConfig(cwd, true, config);
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "over budget", 1_001),
    });
    const result = await manager
      .createTool(["read"], true)
      .execute("run-budget", { task: "Research budget" }, undefined, undefined, fakeToolContext(cwd) as never);
    expect((result.content[0] as { type: string; text: string }).text).toBe("over budget");
    const recent = manager.snapshot().recent[0];
    expect(recent?.budget.runTokensUsed).toBeGreaterThan(1_000);
    expect(recent?.budget.warnRunTokens).toBe(true);
    await manager.dispose();
  });

  it("aborts an active attempt at its configured deadline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-deadline-"));
    const config = defaultAgentProjectConfig();
    config.maxRunSeconds = 1;
    await saveAgentProjectConfig(cwd, true, config);
    const child = abortControlledSession();
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => child,
    });
    await expect(
      manager
        .createTool(["read"], true)
        .execute("deadline", { task: "Wait for deadline" }, undefined, undefined, fakeToolContext(cwd) as never),
    ).rejects.toThrow("run deadline exceeded (1s)");
    expect(child.abort).toHaveBeenCalled();
    await manager.dispose();
  });

  it("cascades root cancellation to active and queued descendants", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agent-tree-cancel-"));
    const config = defaultAgentProjectConfig();
    config.maxConcurrency = 1;
    await saveAgentProjectConfig(cwd, true, config);
    let markStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      markStarted = resolvePromise;
    });
    const child = abortControlledSession(markStarted);
    const sessionFactory = vi.fn(async () => child);
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory,
    });
    manager.beginRootTask("Run parallel research");
    const tool = manager.createTool(["read"], true);
    const active = tool.execute(
      "active-child",
      { task: "Research active branch" },
      undefined,
      undefined,
      fakeToolContext(cwd) as never,
    );
    await started;
    const queued = tool.execute(
      "queued-child",
      { task: "Research queued branch" },
      undefined,
      undefined,
      fakeToolContext(cwd) as never,
    );
    const settled = Promise.allSettled([active, queued]);
    await manager.cancelAll();
    const results = await settled;
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(results.map((result) => (result.status === "rejected" ? result.reason.name : ""))).toEqual([
      "AbortError",
      "AbortError",
    ]);
    expect(sessionFactory).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it("persists Teammate fallback as a sticky binding until an explicit model switch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-teammate-fallback-"));
    const config = defaultAgentProjectConfig();
    config.crossProviderDelegation = true;
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
    const manager = await PiAgentManager.create({
      cwd,
      agentDir: cwd,
      trustedProject: true,
      recovery: false,
      modelRuntime: fakeRuntime(),
      executionPolicy: createExecutionPolicyService({ workspace: cwd, policy: "Standard" }),
      sessionFactory: async () => fakeSession(async () => "unused"),
    });
    const tool = manager.createTool(["read"], true);
    manager.beginRootTask("Implement the frontend change");
    // C19 P0-1/P0-3：required 门禁与 teammate 调用都被移除/拒绝，主代理操作不受影响。
    expect(() =>
      manager.assertMainAction({ kind: "file-write", target: join(cwd, "src", "app.ts"), operation: "write" }),
    ).not.toThrow();
    expect(() => manager.assertRootTaskComplete()).not.toThrow();
    await expect(
      tool.execute(
        "call-4",
        { task: "Implement frontend", teammate: "frontend", lane: "main" },
        undefined,
        undefined,
        fakeToolContext(cwd) as never,
      ),
    ).rejects.toThrow("temporarily disabled");
    await expect(manager.switchTeammateModel("frontend", "kimi/k2")).rejects.toThrow("temporarily disabled");
    // 配置文件中的 teammate 数据原样保留，不被 runtime 破坏。
    expect(JSON.parse(await readFile(path, "utf8")).teammates[0]).toMatchObject({
      id: "frontend",
      preferredModel: "kimi/k2",
    });
    await manager.dispose();
  });

  it("rolls back an in-memory sticky fallback when config persistence fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-teammate-fallback-rollback-"));
    const config = defaultAgentProjectConfig();
    config.crossProviderDelegation = true;
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

    // C19 P0-3：Ban 拦截先于任何配置写入；symlink 防护仍由 config 加载层保证。
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
    ).rejects.toThrow("temporarily disabled");
    expect(manager.snapshot().teammates).toEqual([]);
    await manager.dispose();
  });
});
