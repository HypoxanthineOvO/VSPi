import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEEPSEEK_HARNESS_TOOLS } from "../src/deepseek/official.js";
import type { PolicyAction, PolicyDecision } from "../src/policy/execution-policy.js";
import { createPolicyToolOverrides } from "../src/policy/pi-policy-tools.js";

const ALLOW: PolicyDecision = {
  allowed: true,
  approval: "not-required",
  reason: "test allow",
  sandboxed: false,
};

function execute(tool: ReturnType<typeof createPolicyToolOverrides>["str_replace_editor"], input: unknown) {
  return tool.execute("editor-call", input as never, undefined, undefined, undefined as never);
}

describe("DeepSeek persistent str_replace_editor", () => {
  it("is retained by Pi's real custom-tool allowlist", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-deepseek-editor-registry-"));
    const definition = createPolicyToolOverrides({
      workspace,
      executionPolicy: { evaluate: async () => ALLOW },
    }).str_replace_editor;
    const { session } = await createAgentSession({
      cwd: workspace,
      sessionManager: SessionManager.inMemory(workspace),
      customTools: [definition],
      tools: ["str_replace_editor"],
    });
    try {
      expect({
        active: session.getActiveToolNames(),
        registered: session.agent.state.tools.map((tool) => tool.name),
      }).toEqual({
        active: ["str_replace_editor"],
        registered: ["str_replace_editor"],
      });
    } finally {
      session.dispose();
    }
  });

  it("uses the official schema and persists create, view, replace, and insert operations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-deepseek-editor-"));
    const evaluate = vi.fn(async (_action: PolicyAction) => ALLOW);
    const tool = createPolicyToolOverrides({ workspace, executionPolicy: { evaluate } }).str_replace_editor;
    const fixture = DEEPSEEK_HARNESS_TOOLS.find((candidate) => candidate.name === "str_replace_editor");

    expect(tool).toMatchObject({
      name: fixture?.name,
      description: fixture?.description,
      parameters: fixture?.parameters,
    });

    const path = join(workspace, "sample.txt");
    await execute(tool, { command: "create", path, file_text: "alpha\nbeta\n" });
    const viewed = await execute(tool, { command: "view", path, view_range: [2, -1] });
    await execute(tool, {
      command: "str_replace",
      path,
      old_str: "beta",
      new_str: "bravo",
    });
    await execute(tool, { command: "insert", path, insert_line: 1, new_str: "middle" });

    expect({
      viewed: viewed.content,
      content: await readFile(join(workspace, "sample.txt"), "utf8"),
      actions: evaluate.mock.calls.map(([action]) => action),
    }).toEqual({
      viewed: [
        {
          type: "text",
          text: `Here's the content of ${path} with line numbers (which has a total of 3 lines) with view_range=[2, -1]:\n     2  beta\n     3  \n`,
        },
      ],
      content: "alpha\nmiddle\nbravo\n",
      actions: [
        {
          kind: "file-write",
          target: join(workspace, "sample.txt"),
          category: "file-write",
          operation: "edit",
        },
        {
          kind: "file-read",
          target: join(workspace, "sample.txt"),
          category: "file-read",
          operation: "read",
        },
        ...Array.from({ length: 2 }, () => ({
          kind: "file-write" as const,
          target: join(workspace, "sample.txt"),
          category: "file-write" as const,
          operation: "edit",
        })),
      ],
    });
  });

  it("requires a unique replacement and honors Policy and workspace containment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-deepseek-editor-safety-"));
    await writeFile(join(workspace, "duplicate.txt"), "same\nsame\n");
    const allowed = createPolicyToolOverrides({
      workspace,
      executionPolicy: { evaluate: async () => ALLOW },
      workspaceBoundary: true,
    }).str_replace_editor;
    await expect(
      execute(allowed, {
        command: "str_replace",
        path: join(workspace, "duplicate.txt"),
        old_str: "same",
        new_str: "new",
      }),
    ).rejects.toThrow("in lines [1, 2]");
    await expect(
      execute(allowed, { command: "create", path: join(workspace, "..", "outside.txt"), file_text: "blocked" }),
    ).rejects.toThrow("outside the workspace");

    const denied = createPolicyToolOverrides({
      workspace,
      executionPolicy: {
        evaluate: async (): Promise<PolicyDecision> => ({
          allowed: false,
          approval: "denied",
          reason: "approval denied",
          sandboxed: false,
        }),
      },
    }).str_replace_editor;
    await expect(
      execute(denied, { command: "create", path: join(workspace, "denied.txt"), file_text: "blocked" }),
    ).rejects.toThrow("approval denied");
  });
});
