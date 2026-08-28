import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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

  it("runs Subagent Bash on the Host with the parent HOME and environment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-agent-host-shell-"));
    const previous = process.env.VSPI_SUBAGENT_PARENT_CREDENTIAL;
    process.env.VSPI_SUBAGENT_PARENT_CREDENTIAL = "inherited-credential";
    try {
      const tools = createPolicyToolOverrides({
        workspace,
        executionPolicy: createExecutionPolicyService({ workspace, policy: "Auto" }),
        workspaceBoundary: true,
      });
      const result = await tools.bash.execute(
        "host-shell",
        { command: `printf '%s|%s|%s' "$VSPI_SUBAGENT_PARENT_CREDENTIAL" "$HOME" "$PWD"` },
        undefined,
        undefined,
        { sessionManager: SessionManager.inMemory(workspace) } as never,
      );
      expect(JSON.stringify(result)).toContain(`inherited-credential|${process.env.HOME}|${workspace}`);
    } finally {
      if (previous === undefined) delete process.env.VSPI_SUBAGENT_PARENT_CREDENTIAL;
      else process.env.VSPI_SUBAGENT_PARENT_CREDENTIAL = previous;
    }
  });
});
