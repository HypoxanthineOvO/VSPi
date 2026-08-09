import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceBashOperations } from "../src/agents/workspace-tools.js";
import { createExecutionPolicyService } from "../src/policy/execution-policy.js";
import { createPolicyToolOverrides } from "../src/policy/pi-policy-tools.js";

describe("Subagent workspace boundary", () => {
  it("rejects a symlink that escapes the workspace before the native read tool runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-agent-boundary-"));
    const outside = await mkdtemp(join(tmpdir(), "vspi-agent-secret-"));
    await writeFile(join(outside, "credential.txt"), "secret");
    await symlink(join(outside, "credential.txt"), join(workspace, "escaped.txt"));
    const tools = createPolicyToolOverrides({
      workspace,
      executionPolicy: createExecutionPolicyService({ workspace, policy: "Auto" }),
      workspaceBoundary: true,
    });
    await expect(
      tools.read.execute("read-1", { path: "escaped.txt" }, undefined, undefined, {} as never),
    ).rejects.toThrow("symbolic links");
  });

  it("rejects an absolute path outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-agent-absolute-"));
    const outside = await mkdtemp(join(tmpdir(), "vspi-agent-outside-"));
    const target = join(outside, "credential.txt");
    await writeFile(target, "secret");
    const tools = createPolicyToolOverrides({
      workspace,
      executionPolicy: createExecutionPolicyService({ workspace, policy: "Auto" }),
      workspaceBoundary: true,
    });
    await expect(
      tools.read.execute("read-absolute", { path: target }, undefined, undefined, {} as never),
    ).rejects.toThrow("outside the workspace");
  });

  it("keeps .vspi control files read-only even when an indirect Bash command evades text classification", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-agent-control-files-"));
    await mkdir(join(workspace, ".vspi"));
    const config = join(workspace, ".vspi", "agents.json");
    await writeFile(config, "trusted\n");
    const output: Buffer[] = [];
    const result = await createWorkspaceBashOperations(workspace).exec(
      `node -e "require('node:fs').writeFileSync(process.cwd()+'/.vspi/'+'agents.json','pwned')"`,
      workspace,
      { onData: (data) => output.push(data) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(config, "utf8")).toBe("trusted\n");
    expect(Buffer.concat(output).toString("utf8")).toMatch(
      /read-only|permission denied|no permissions to create new namespace/i,
    );
  });
});
