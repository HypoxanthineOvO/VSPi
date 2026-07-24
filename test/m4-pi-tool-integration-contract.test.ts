import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ExecutionPolicyService, PolicyExecutionResult } from "./m4-contract.js";
import { loadExecutionPolicyModule } from "./m4-contract.js";
import { loadPolicyToolModule } from "./m4-integration-contract.js";

const MODEL = {
  id: "policy-tool-model",
  name: "Policy Tool Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

const allowedResult: PolicyExecutionResult = {
  decision: { allowed: true, approval: "not-required", reason: "test", sandboxed: true },
  started: true,
  exitCode: 0,
  stdout: "POLICY_TOOL_OK",
  stderr: "",
};

function fakePolicy(
  execute: ExecutionPolicyService["execute"] = vi.fn(async (_input) => allowedResult),
): ExecutionPolicyService {
  return {
    snapshot: () => ({ policy: "Standard", boundary: "Sandboxed", sandboxed: true, recovery: false }),
    evaluate: vi.fn(async () => allowedResult.decision),
    switchPolicy: vi.fn(async () => ({
      policy: "Standard" as const,
      boundary: "Sandboxed" as const,
      sandboxed: true,
      recovery: false,
    })),
    execute,
    auditLog: () => [],
  };
}

function events() {
  return { onMessage: vi.fn(), onMessageUpdate: vi.fn(), onBusy: vi.fn(), onUsage: vi.fn(), onNotice: vi.fn() };
}

async function realWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "vspi-m4-policy-tools-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        policytools: {
          name: "Policy Tools",
          baseUrl: "http://127.0.0.1:11111",
          apiKey: "FAKE_POLICY_TOOL_KEY",
          api: "openai-completions",
          models: [MODEL],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "policytools", defaultModel: MODEL.id }),
  );
  return { root, cwd, agentDir };
}

describe("M4 Pi base-tool policy integration", () => {
  it("builds exactly read/bash/edit/write overrides with Pi-native schemas", async () => {
    const module = await loadPolicyToolModule();
    expect(module, "M4 must expose policy-aware Pi base tool overrides").toBeDefined();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-tool-schema-"));
    const tools = module.createPolicyToolOverrides({ workspace, executionPolicy: fakePolicy() });
    expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "read", "write"]);
    const native = {
      read: createReadTool(workspace),
      bash: createBashTool(workspace),
      edit: createEditTool(workspace),
      write: createWriteTool(workspace),
    };
    for (const name of ["read", "bash", "edit", "write"] as const) {
      expect(tools[name]).toMatchObject({
        name,
        label: native[name].label,
        description: native[name].description,
        parameters: native[name].parameters,
      });
    }
  });

  it("routes read/write/edit and classified bash through ExecutionPolicyService", async () => {
    const module = await loadPolicyToolModule();
    expect(module, "M4 must expose policy-aware Pi base tool overrides").toBeDefined();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-tool-routing-"));
    const execute = vi.fn<ExecutionPolicyService["execute"]>(async () => allowedResult);
    const tools = module.createPolicyToolOverrides({ workspace, executionPolicy: fakePolicy(execute) });
    await tools.read.execute("read-1", { path: "input.txt" });
    await tools.write.execute("write-1", { path: "output.txt", content: "content" });
    await tools.edit.execute("edit-1", { path: "edit.txt", edits: [{ oldText: "a", newText: "b" }] });
    await tools.bash.execute("bash-1", { command: "curl http://127.0.0.1:43210/probe", timeout: 250 });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls.map(([input]) => input.action.kind)).toEqual([
      "file-read",
      "file-write",
      "file-write",
      "network",
    ]);
    expect(execute.mock.calls[3]?.[0]).toMatchObject({
      action: { kind: "network", target: "http://127.0.0.1:43210/probe" },
      timeoutMs: 250,
    });
  });

  it("forwards Bash AbortSignal and timeout without using the default local BashOperations", async () => {
    const module = await loadPolicyToolModule();
    expect(module, "M4 must expose policy-aware Pi base tool overrides").toBeDefined();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-tool-abort-"));
    const execute = vi.fn<ExecutionPolicyService["execute"]>(async () => allowedResult);
    const tools = module.createPolicyToolOverrides({ workspace, executionPolicy: fakePolicy(execute) });
    const controller = new AbortController();
    await tools.bash.execute("bash-abort", { command: "node -e 0", timeout: 75 }, controller.signal);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, timeoutMs: 75 }));
  });

  it("installs no default local base tool and retains one shared service across new and resumed runtimes", async () => {
    const workspace = await realWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", workspace.agentDir);
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const execute = vi.fn<ExecutionPolicyService["execute"]>(async () => allowedResult);
    const policy = fakePolicy(execute);
    const backend = new PiBackend({
      cwd: workspace.cwd,
      continueRecent: false,
      executionPolicy: policy,
    } as never);
    try {
      await backend.start(events());
      await assertPolicyOverrides(backend, policy, execute);
      const initialSession = (backend as unknown as { session?: AgentSession }).session;
      if (!initialSession) throw new Error("Pi session did not start");
      const persisted = SessionManager.create(workspace.cwd, initialSession.sessionManager.getSessionDir());
      persisted.appendMessage({ role: "user", content: "POLICY_SWITCH_FORK_SESSION", timestamp: 1 });
      persisted.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "POLICY_SWITCH_FORK_READY" }],
        api: "openai-completions",
        provider: "policytools",
        model: MODEL.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const persistedId = persisted.getSessionId();
      const persistedPath = persisted.getSessionFile();
      if (!persistedPath) throw new Error("Policy switch/fork fixture was not persisted");
      await backend.newSession({ defaults: false, continuePlan: false });
      await assertPolicyOverrides(backend, policy, execute);
      const listSpy = vi.spyOn(SessionManager, "list").mockResolvedValue([
        {
          id: persistedId,
          path: persistedPath,
          cwd: workspace.cwd,
          created: new Date(),
          modified: new Date(),
          messageCount: 1,
          firstMessage: "POLICY_SWITCH_FORK_SESSION",
          allMessagesText: "POLICY_SWITCH_FORK_SESSION",
        },
      ]);
      try {
        await backend.switchSession(persistedId);
        await assertPolicyOverrides(backend, policy, execute);
        await backend.forkSession(persistedId);
        await assertPolicyOverrides(backend, policy, execute);
      } finally {
        listSpy.mockRestore();
      }
    } finally {
      await backend.dispose();
    }

    const resumed = new PiBackend({ cwd: workspace.cwd, continueRecent: true, executionPolicy: policy } as never);
    try {
      await resumed.start(events());
      await assertPolicyOverrides(resumed, policy, execute);
    } finally {
      await resumed.dispose();
      vi.unstubAllEnvs();
    }
    expect(execute).toHaveBeenCalledTimes(20);
  });

  it.each([
    ["ordinary", false],
    ["Recovery", true],
  ] as const)(
    "fails closed with policy-aware tools when a direct %s PiBackend omits executionPolicy",
    async (_label, recovery) => {
      const workspace = await realWorkspace();
      const policyOnlyPath = join(workspace.root, "policy-only.txt");
      await writeFile(policyOnlyPath, "POLICY_ONLY_MUST_NOT_REACH_LOCAL_READ");
      vi.stubEnv("PI_CODING_AGENT_DIR", workspace.agentDir);
      vi.stubEnv("DEEPSEEK_API_KEY", "");
      const backend = new PiBackend({
        cwd: workspace.cwd,
        continueRecent: false,
        recovery,
        trustedProject: recovery,
      } as never);
      try {
        await backend.start(events());
        const session = (backend as unknown as { session?: AgentSession }).session;
        if (!session) throw new Error("Pi session did not start");
        expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
        for (const name of ["read", "bash", "edit", "write"]) {
          const definition = session.getToolDefinition(name);
          expect(definition?.parameters).toBeDefined();
          expect(definition?.renderCall).toBeTypeOf("function");
          expect(definition?.renderResult).toBeTypeOf("function");
        }
        const read = session.getToolDefinition("read");
        if (!read) throw new Error("Policy-aware read definition is missing");
        await expect(
          read.execute("direct-backend-read", { path: "../policy-only.txt" }, undefined, undefined, undefined as never),
        ).rejects.toThrow(/Policy|Standard|outside|workspace|deny|拒绝|边界/i);
      } finally {
        await backend.dispose();
        vi.unstubAllEnvs();
      }
    },
  );

  it("bounds real policy child execution by timeout and AbortSignal", async () => {
    const module = await loadExecutionPolicyModule();
    if (!module) throw new Error("execution policy module is required");
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-process-control-"));
    const service = module.createExecutionPolicyService({ workspace, policy: "Standard" });
    const script = "setTimeout(() => process.stdout.write('LATE'), 300)";
    const timed = await service.execute({
      action: { kind: "process", risk: "low" },
      command: process.execPath,
      args: ["-e", script],
      timeoutMs: 25,
    });
    expect(timed.exitCode).not.toBe(0);
    expect(timed.stderr).toMatch(/timeout|timed out|超时/i);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    const aborted = await service.execute({
      action: { kind: "process", risk: "low" },
      command: process.execPath,
      args: ["-e", script],
      signal: controller.signal,
    });
    expect(aborted.exitCode).not.toBe(0);
    expect(aborted.stderr).toMatch(/abort|cancel|取消|中止/i);
  });

  it("executes real read, write, and edit definitions inside the Standard bwrap boundary", async () => {
    const policyModule = await loadExecutionPolicyModule();
    const toolModule = await loadPolicyToolModule();
    if (!policyModule || !toolModule) throw new Error("policy modules are required");
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-real-files-"));
    const service = policyModule.createExecutionPolicyService({ workspace, policy: "Standard" });
    const tools = toolModule.createPolicyToolOverrides({ workspace, executionPolicy: service });

    await tools.write.execute("write-real", { path: "policy.txt", content: "before" });
    expect(await readFile(join(workspace, "policy.txt"), "utf8")).toBe("before");
    await tools.edit.execute("edit-real", {
      path: "policy.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(await readFile(join(workspace, "policy.txt"), "utf8")).toBe("after");
    expect(JSON.stringify(await tools.read.execute("read-real", { path: "policy.txt" }))).toContain("after");
    expect(service.auditLog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: expect.objectContaining({ kind: "file-read" }) }),
        expect.objectContaining({ action: expect.objectContaining({ kind: "file-write" }) }),
      ]),
    );
  });

  it("kills the complete sandbox process group after timeout and AbortSignal", async () => {
    const module = await loadExecutionPolicyModule();
    if (!module) throw new Error("execution policy module is required");
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-process-group-"));
    const service = module.createExecutionPolicyService({ workspace, policy: "Standard" });

    for (const reason of ["timeout", "abort"] as const) {
      const marker = join(workspace, `${reason}-orphan.txt`);
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ORPHAN"), 250)`;
      const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
        descendant,
      )}], { stdio: "ignore" }); setTimeout(() => {}, 5000)`;
      const controller = new AbortController();
      if (reason === "abort") setTimeout(() => controller.abort(), 50);
      const result = await service.execute({
        action: { kind: "process", risk: "low" },
        command: process.execPath,
        args: ["-e", parent],
        ...(reason === "timeout" ? { timeoutMs: 50 } : { signal: controller.signal }),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(reason === "timeout" ? /timeout|timed out|超时/i : /abort|cancel|取消|中止/i);
      await delay(350);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

async function assertPolicyOverrides(
  backend: PiBackend,
  policy: ExecutionPolicyService,
  execute: ReturnType<typeof vi.fn<ExecutionPolicyService["execute"]>>,
) {
  const session = (backend as unknown as { session?: AgentSession }).session;
  if (!session) throw new Error("Pi session did not start");
  const overrides = (
    session as unknown as { _baseToolsOverride?: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }> }
  )._baseToolsOverride;
  if (overrides) expect(Object.keys(overrides).sort()).toEqual(["bash", "edit", "read", "write"]);
  expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
  for (const name of ["read", "bash", "edit", "write"]) {
    const definition = session.getToolDefinition(name);
    expect(definition?.parameters).toBeDefined();
    expect(definition?.renderCall).toBeTypeOf("function");
    expect(definition?.renderResult).toBeTypeOf("function");
  }
  expect((backend as unknown as { options: { executionPolicy?: unknown } }).options.executionPolicy).toBe(policy);
  const definitions = Object.fromEntries(
    ["read", "bash", "edit", "write"].map((name) => [name, session.getToolDefinition(name)]),
  );
  if (Object.values(definitions).some((definition) => !definition)) {
    throw new Error("Policy-aware base-tool definition is missing");
  }
  const callsBefore = execute.mock.calls.length;
  const results = await Promise.all([
    definitions.read?.execute(
      "identity-read",
      { path: "policy-route-must-not-hit-local.txt" },
      undefined,
      undefined,
      undefined as never,
    ),
    definitions.write?.execute(
      "identity-write",
      { path: "policy-route-must-not-hit-local.txt", content: "LOCAL_WRITE_MUST_NOT_RUN" },
      undefined,
      undefined,
      undefined as never,
    ),
    definitions.edit?.execute(
      "identity-edit",
      { path: "policy-route-must-not-hit-local.txt", edits: [{ oldText: "a", newText: "b" }] },
      undefined,
      undefined,
      undefined as never,
    ),
    definitions.bash?.execute("identity-bash", { command: "node -e 0" }, undefined, undefined, undefined as never),
  ]);
  expect(execute.mock.calls).toHaveLength(callsBefore + 4);
  expect(execute.mock.calls.slice(callsBefore).map(([input]) => input.action.kind)).toEqual([
    "file-read",
    "file-write",
    "file-write",
    "process",
  ]);
  for (const result of results) expect(JSON.stringify(result)).toContain("POLICY_TOOL_OK");
}
