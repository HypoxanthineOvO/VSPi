import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadExecutionPolicyModule, type PolicyLevel } from "./m4-contract.js";

async function policyModule() {
  const module = await loadExecutionPolicyModule();
  expect(module, "M4 must expose the observable execution-policy service boundary").toBeDefined();
  return module;
}

describe("M4 execution policy resolution and authority", () => {
  it("orders Safe < Standard < Auto < YOLO, defaults Standard, and lets project policy only lower", async () => {
    const module = await policyModule();
    if (!module) return;
    expect(module.POLICY_LEVELS).toEqual(["Safe", "Standard", "Auto", "YOLO"]);
    expect(module.resolveEffectivePolicy()).toMatchObject({
      policy: "Standard",
      boundary: "Sandboxed",
      sandboxed: true,
      recovery: false,
    });
    expect(module.resolveEffectivePolicy({ globalPolicy: "Standard", projectPolicy: "YOLO" }).policy).toBe("Standard");
    expect(module.resolveEffectivePolicy({ globalPolicy: "Standard", projectPolicy: "Auto" }).policy).toBe("Standard");
    expect(module.resolveEffectivePolicy({ cliPolicy: "Auto", projectPolicy: "YOLO" }).policy).toBe("Auto");
    expect(module.resolveEffectivePolicy({ cliPolicy: "YOLO", projectPolicy: "Safe" }).policy).toBe("Safe");
    expect(module.resolveEffectivePolicy({ globalPolicy: "Auto", projectPolicy: "Standard" }).policy).toBe("Standard");
    expect(module.resolveEffectivePolicy({ cliPolicy: "YOLO", recovery: true })).toMatchObject({
      policy: "Standard",
      boundary: "Sandboxed",
      recovery: true,
    });
  });

  it("applies Standard approvals while Safe denies and Auto avoids VSPi prompts inside configured bounds", async () => {
    const module = await policyModule();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-decisions-"));
    const approval = vi.fn(async () => false);
    const standard = module.createExecutionPolicyService({ workspace, policy: "Standard", approval });
    expect(await standard.evaluate({ kind: "file-write", target: join(workspace, "allowed.txt") })).toMatchObject({
      allowed: true,
      approval: "not-required",
      sandboxed: true,
    });
    for (const action of [
      { kind: "file-write" as const, target: join(workspace, "..", "outside.txt") },
      { kind: "shared" as const, target: "shared-resource" },
      { kind: "process" as const, target: "risky-command", risk: "high" as const },
      { kind: "network" as const, target: "http://127.0.0.1:9" },
    ]) {
      expect(await standard.evaluate(action)).toMatchObject({ allowed: false, approval: "denied", sandboxed: true });
    }
    expect(approval).toHaveBeenCalledTimes(4);

    const safeApproval = vi.fn(async () => true);
    const safe = module.createExecutionPolicyService({ workspace, policy: "Safe", approval: safeApproval });
    expect(await safe.evaluate({ kind: "file-write", target: join(workspace, "denied.txt") })).toMatchObject({
      allowed: false,
      approval: "not-required",
      sandboxed: true,
    });
    expect(safeApproval).not.toHaveBeenCalled();

    const autoApproval = vi.fn(async () => false);
    const auto = module.createExecutionPolicyService({
      workspace,
      policy: "Auto",
      approval: autoApproval,
      networkAllowlist: ["http://127.0.0.1:43210"],
    });
    expect(await auto.evaluate({ kind: "file-write", target: join(workspace, "auto.txt") })).toMatchObject({
      allowed: true,
      approval: "not-required",
      sandboxed: true,
    });
    expect(await auto.evaluate({ kind: "network", target: "http://127.0.0.1:43210/path" })).toMatchObject({
      allowed: true,
      approval: "not-required",
      sandboxed: true,
    });
    expect(autoApproval).not.toHaveBeenCalled();
  });

  it("requires an explicit YOLO acknowledgement and rolls back a failed atomic switch", async () => {
    const module = await policyModule();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-policy-switch-"));
    const deniedAck = vi.fn(async () => false);
    const denied = module.createExecutionPolicyService({ workspace, acknowledgeYolo: deniedAck });
    await expect(denied.switchPolicy("YOLO")).rejects.toThrow(/acknowledge|确认|YOLO|Host|风险/i);
    expect(denied.snapshot()).toMatchObject({ policy: "Standard", boundary: "Sandboxed", sandboxed: true });
    expect(deniedAck).toHaveBeenCalledOnce();

    const acceptedAck = vi.fn(async () => true);
    const accepted = module.createExecutionPolicyService({ workspace, acknowledgeYolo: acceptedAck });
    await expect(accepted.switchPolicy("YOLO")).resolves.toMatchObject({
      policy: "YOLO",
      boundary: "Host",
      sandboxed: false,
    });
    expect(acceptedAck).toHaveBeenCalledOnce();
  });

  it("keeps the previous snapshot when a sandbox capability check fails", async () => {
    const module = await policyModule();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-capability-rollback-"));
    const service = module.createExecutionPolicyService({ workspace });
    vi.stubEnv("PATH", "/vspi-test-no-bwrap");
    try {
      await expect(service.switchPolicy("Safe")).rejects.toThrow(/bwrap|sandbox|capability|不支持|失败/i);
      expect(service.snapshot()).toMatchObject({ policy: "Standard", boundary: "Sandboxed", sandboxed: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["Safe", "Standard", "Auto", "YOLO"] as PolicyLevel[])(
    "records secret-safe decisions and never bypasses Workflow authority under %s",
    async (policy) => {
      const module = await policyModule();
      if (!module) return;
      const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-workflow-authority-"));
      const authority = vi.fn(async () => false);
      const service = module.createExecutionPolicyService({
        workspace,
        workflowAuthority: authority,
        acknowledgeYolo: async () => true,
      });
      if (policy !== "Standard") await service.switchPolicy(policy);
      const decision = await service.evaluate({
        kind: "workflow-authority",
        operation: "release-with-token=WORKFLOW_SECRET_SENTINEL",
      });
      expect(decision.allowed).toBe(false);
      expect(authority).toHaveBeenCalledOnce();
      const serialized = JSON.stringify(service.auditLog());
      expect(serialized).not.toContain("WORKFLOW_SECRET_SENTINEL");
      expect(serialized).toMatch(/workflow|authority|deny|拒绝/i);
    },
  );
});
