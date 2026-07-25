import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadStartupPolicyRuntimeModule } from "./m4-integration-contract.js";

async function startupModule() {
  const module = await loadStartupPolicyRuntimeModule();
  expect(module, "M4 startup must expose one broker-wired Policy runtime factory").toBeDefined();
  return module;
}

describe("M4 startup Policy composition", () => {
  it("injects config allowlist and approval broker for Standard while defaulting unavailable approval to deny", async () => {
    const module = await startupModule();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-startup-standard-"));
    const approvalBroker = vi.fn(async () => false);
    const service = await module.createStartupPolicyRuntime({
      workspace,
      security: { recovery: false, policy: "Standard", trustedProject: true },
      configService: {
        load: async () => ({
          globalPolicy: "Auto",
          projectPolicy: "Standard",
          effectivePolicy: "Standard",
          networkAllowlist: ["http://127.0.0.1:43210"],
          hash: "a".repeat(64),
          diagnostics: [],
        }),
      },
      approvalBroker,
      acknowledgeYolo: async () => false,
      workflowAuthority: async () => false,
    });
    expect(await service.evaluate({ kind: "process", risk: "high", target: "risky" })).toMatchObject({
      allowed: false,
      approval: "denied",
    });
    expect(approvalBroker).toHaveBeenCalledOnce();

    const unavailable = await module.createStartupPolicyRuntime({
      workspace,
      security: { recovery: false, policy: "Standard", trustedProject: false },
      configService: {
        load: async () => ({
          globalPolicy: "Standard",
          effectivePolicy: "Standard",
          networkAllowlist: [],
          hash: "d".repeat(64),
          diagnostics: [],
        }),
      },
      acknowledgeYolo: async () => false,
      workflowAuthority: async () => false,
    });
    expect(await unavailable.evaluate({ kind: "process", risk: "high", target: "risky" })).toMatchObject({
      allowed: false,
      approval: "denied",
    });
  });

  it("injects configured Auto networking without prompting and never turns Policy into Workflow authority", async () => {
    const module = await startupModule();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-startup-auto-"));
    const approvalBroker = vi.fn(async () => false);
    const workflowAuthority = vi.fn(async () => false);
    const service = await module.createStartupPolicyRuntime({
      workspace,
      security: { recovery: false, policy: "Auto", trustedProject: false },
      configService: {
        load: async () => ({
          globalPolicy: "Auto",
          effectivePolicy: "Auto",
          networkAllowlist: ["http://127.0.0.1:43210"],
          hash: "b".repeat(64),
          diagnostics: [],
        }),
      },
      approvalBroker,
      acknowledgeYolo: async () => false,
      workflowAuthority,
    });
    expect(await service.evaluate({ kind: "network", target: "http://127.0.0.1:43210/path" })).toMatchObject({
      allowed: true,
      approval: "not-required",
      sandboxed: false,
    });
    expect(approvalBroker).not.toHaveBeenCalled();
    expect(await service.evaluate({ kind: "workflow-authority", operation: "release" })).toMatchObject({
      allowed: false,
    });
    expect(workflowAuthority).toHaveBeenCalledOnce();
  });

  it("makes Recovery dominate config, allowlist, trust, approval, acknowledgement, and Workflow inputs", async () => {
    const module = await startupModule();
    if (!module) return;
    const workspace = await mkdtemp(join(tmpdir(), "vspi-m4-startup-recovery-"));
    const approvalBroker = vi.fn(async () => true);
    const acknowledgeYolo = vi.fn(async () => true);
    const service = await module.createStartupPolicyRuntime({
      workspace,
      security: { recovery: true, policy: "YOLO", trustedProject: true },
      configService: {
        load: async () => ({
          globalPolicy: "YOLO",
          projectPolicy: "YOLO",
          effectivePolicy: "YOLO",
          networkAllowlist: ["http://127.0.0.1:43210"],
          hash: "c".repeat(64),
          diagnostics: [],
        }),
      },
      approvalBroker,
      acknowledgeYolo,
      workflowAuthority: async () => true,
    });
    expect(service.snapshot()).toMatchObject({ policy: "Standard", boundary: "Host", recovery: true });
    expect(await service.evaluate({ kind: "network", target: "http://127.0.0.1:43210" })).toMatchObject({
      allowed: false,
    });
    await expect(service.switchPolicy("YOLO")).rejects.toThrow(/Recovery|恢复|拒绝/i);
    expect(approvalBroker).not.toHaveBeenCalled();
    expect(acknowledgeYolo).not.toHaveBeenCalled();
  });
});
