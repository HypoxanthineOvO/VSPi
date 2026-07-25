import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExecutionPolicyService } from "../src/policy/execution-policy.js";

describe("M1 Host execution boundary", () => {
  it("runs approved commands directly as the current Host user", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-host-execute-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const approval = vi.fn(async () => ({ type: "allow-once" as const }));
    const service = createExecutionPolicyService({ workspace, policy: "Safe", approval });
    const script = "require('node:fs').writeFileSync(process.argv[1], 'HOST_WRITE_OK')";
    const result = await service.execute({
      action: { kind: "process", target: script, risk: "high", category: "destructive" },
      command: process.execPath,
      args: ["-e", script, outside],
    });
    expect(result).toMatchObject({
      started: true,
      exitCode: 0,
      decision: { allowed: true, approval: "granted", sandboxed: false },
    });
    expect(await readFile(outside, "utf8")).toBe("HOST_WRITE_OK");
    expect(approval).toHaveBeenCalledOnce();
  });

  it("does not start a rejected Host command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-host-deny-"));
    const target = join(workspace, "denied.txt");
    const service = createExecutionPolicyService({
      workspace,
      policy: "Safe",
      approval: async () => ({ type: "deny", reason: "用户拒绝" }),
    });
    const result = await service.execute({
      action: { kind: "file-write", target, category: "file-write" },
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'NO')", target],
    });
    expect(result).toMatchObject({ started: false, decision: { allowed: false, reason: "用户拒绝" } });
    await expect(access(target)).rejects.toThrow();
  });

  it("lets Auto execute without an approval callback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-host-auto-"));
    const target = join(workspace, "auto.txt");
    const approval = vi.fn(async () => ({ type: "deny" as const }));
    const service = createExecutionPolicyService({ workspace, policy: "Auto", approval });
    const result = await service.execute({
      action: { kind: "process", target: "write", risk: "high", category: "destructive" },
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'AUTO_OK')", target],
    });
    expect(result).toMatchObject({ started: true, exitCode: 0, decision: { approval: "not-required" } });
    expect(await readFile(target, "utf8")).toBe("AUTO_OK");
    expect(approval).not.toHaveBeenCalled();
  });
});
