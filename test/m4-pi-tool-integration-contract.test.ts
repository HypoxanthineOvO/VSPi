import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createExecutionPolicyService } from "../src/policy/execution-policy.js";
import { classifyBash, createPolicyToolOverrides } from "../src/policy/pi-policy-tools.js";

function execute(tool: unknown, input: unknown, signal?: AbortSignal) {
  const definition = tool as {
    execute(id: string, input: unknown, signal?: AbortSignal, update?: unknown, context?: unknown): Promise<unknown>;
  };
  return definition.execute("test-call", input, signal, undefined, undefined) as Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: { diff?: string; patch?: string };
  }>;
}

describe("M1 Pi-native policy tool integration", () => {
  it("provides the complete native file/folder/search catalog with unchanged schemas", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-native-tool-schema-"));
    const policy = createExecutionPolicyService({ workspace, policy: "Auto" });
    const tools = createPolicyToolOverrides({ workspace, executionPolicy: policy });
    expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    const native = {
      read: createReadTool(workspace),
      ls: createLsTool(workspace),
      find: createFindTool(workspace),
      grep: createGrepTool(workspace),
      bash: createBashTool(workspace),
      edit: createEditTool(workspace),
      write: createWriteTool(workspace),
    };
    for (const name of Object.keys(native) as Array<keyof typeof native>) {
      expect(tools[name]).toMatchObject({
        name,
        label: native[name].label,
        description: native[name].description,
        parameters: native[name].parameters,
      });
    }
  });

  it("delegates read, ls, find, grep, write and edit to Pi native behavior", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-native-files-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "a.ts"), "export const oldValue = 1;\n");
    const tools = createPolicyToolOverrides({
      workspace,
      executionPolicy: createExecutionPolicyService({ workspace, policy: "Auto" }),
    });

    expect((await execute(tools.read, { path: "src/a.ts" })).content[0]?.text).toContain("oldValue");
    expect((await execute(tools.ls, { path: "src" })).content[0]?.text).toContain("a.ts");
    expect((await execute(tools.find, { pattern: "*.ts", path: "src" })).content[0]?.text).toContain("a.ts");
    expect((await execute(tools.grep, { pattern: "oldValue", path: "src" })).content[0]?.text).toContain("oldValue");
    await execute(tools.write, { path: "created.txt", content: "created\n" });
    const edited = await execute(tools.edit, {
      path: "src/a.ts",
      edits: [{ oldText: "oldValue", newText: "newValue" }],
    });
    expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("created\n");
    expect(await readFile(join(workspace, "src", "a.ts"), "utf8")).toContain("newValue");
    expect(edited.details?.diff).toContain("newValue");
    expect(edited.details?.patch).toContain("newValue");
  });

  it("preserves Pi native image reading", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-native-image-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(workspace, "pixel.png"), png);
    const tools = createPolicyToolOverrides({
      workspace,
      executionPolicy: createExecutionPolicyService({ workspace, policy: "Auto" }),
    });
    const result = await execute(tools.read, { path: "pixel.png" });
    expect(result.content.some((item) => item.type === "image")).toBe(true);
  });

  it("preserves Pi timeout units, streaming updates and AbortSignal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-native-bash-"));
    const tools = createPolicyToolOverrides({
      workspace,
      executionPolicy: createExecutionPolicyService({ workspace, policy: "Auto" }),
    });
    const updates = vi.fn();
    const started = Date.now();
    const result = await tools.bash.execute(
      "bash-timeout",
      { command: "printf native-ok", timeout: 10 },
      undefined,
      updates,
      undefined as never,
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("native-ok") });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(updates).toHaveBeenCalled();

    const controller = new AbortController();
    const running = tools.bash.execute(
      "bash-abort",
      { command: "sleep 10", timeout: 30 },
      controller.signal,
      undefined,
      undefined as never,
    );
    setTimeout(() => controller.abort(), 30);
    await expect(running).rejects.toThrow(/abort/i);
  });

  it("uses intentionally coarse Bash categories for the first usable cycle", () => {
    expect(classifyBash("rg -n TODO src")).toMatchObject({ category: "bash-read", risk: "low" });
    expect(classifyBash("ssh prod uptime")).toMatchObject({ category: "ssh" });
    expect(classifyBash("git push origin main")).toMatchObject({ category: "git-write" });
    expect(classifyBash("docker stop api")).toMatchObject({ category: "container", risk: "high" });
    expect(classifyBash("rm -rf build")).toMatchObject({ category: "destructive", risk: "high" });
  });
});
