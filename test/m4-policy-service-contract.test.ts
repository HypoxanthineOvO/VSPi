import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalResponse,
  createExecutionPolicyService,
  POLICY_LEVELS,
  type PolicyAction,
  type PolicyLevel,
  resolveEffectivePolicy,
} from "../src/policy/execution-policy.js";

describe("M1 Host approval policy", () => {
  it("orders Safe < Standard < YOLO < Auto and keeps every level on Host", () => {
    expect(POLICY_LEVELS).toEqual(["Safe", "Standard", "YOLO", "Auto"]);
    expect(resolveEffectivePolicy()).toMatchObject({
      policy: "Auto",
      boundary: "Host",
      sandboxed: false,
      recovery: false,
    });
    expect(resolveEffectivePolicy({ globalPolicy: "Auto", projectPolicy: "Standard" }).policy).toBe("Standard");
    expect(resolveEffectivePolicy({ globalPolicy: "Standard", projectPolicy: "Auto" }).policy).toBe("Standard");
    expect(resolveEffectivePolicy({ cliPolicy: "Auto", projectPolicy: "Safe" }).policy).toBe("Safe");
    expect(resolveEffectivePolicy({ cliPolicy: "Auto", recovery: true })).toMatchObject({
      policy: "Standard",
      boundary: "Host",
      sandboxed: false,
      recovery: true,
    });
  });

  it("uses simple per-level approval rules without claiming command-perfect safety", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-host-policy-"));
    const approval = vi.fn(async () => ({ type: "deny" }) as ApprovalResponse);

    const safe = createExecutionPolicyService({ workspace, policy: "Safe", approval });
    expect(await safe.evaluate({ kind: "file-read", target: join(workspace, "a.txt") })).toMatchObject({
      allowed: true,
      approval: "not-required",
      sandboxed: false,
    });
    expect(await safe.evaluate({ kind: "file-write", target: join(workspace, "a.txt") })).toMatchObject({
      allowed: false,
      approval: "denied",
    });

    const standard = createExecutionPolicyService({ workspace, policy: "Standard", approval });
    expect(await standard.evaluate({ kind: "file-write", target: join(workspace, "a.txt") })).toMatchObject({
      allowed: true,
      approval: "not-required",
    });
    expect(
      await standard.evaluate({ kind: "network", target: "https://example.test", category: "network" }),
    ).toMatchObject({
      allowed: false,
      approval: "denied",
    });

    const relaxed = createExecutionPolicyService({ workspace, policy: "YOLO", approval });
    expect(
      await relaxed.evaluate({ kind: "network", target: "https://example.test", category: "network" }),
    ).toMatchObject({
      allowed: true,
      approval: "not-required",
    });
    expect(await relaxed.evaluate({ kind: "process", risk: "high", category: "destructive" })).toMatchObject({
      allowed: false,
      approval: "denied",
    });

    const auto = createExecutionPolicyService({ workspace, policy: "Auto", approval });
    expect(await auto.evaluate({ kind: "process", risk: "high", category: "destructive" })).toMatchObject({
      allowed: true,
      approval: "not-required",
    });
  });

  it("supports allow-once, session category allow, rejection reasons and sufficient elevation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-approval-decisions-"));
    const responses: ApprovalResponse[] = [
      { type: "allow-once" },
      { type: "allow-session" },
      { type: "elevate", level: "Standard" },
      { type: "deny", reason: "不要连接生产环境" },
    ];
    const approval = vi.fn(async () => responses.shift() ?? { type: "deny" as const });
    const service = createExecutionPolicyService({ workspace, policy: "Safe", approval });
    const write: PolicyAction = { kind: "file-write", target: join(workspace, "a.txt"), category: "file-write" };

    expect(await service.evaluate(write)).toMatchObject({ allowed: true, approval: "granted" });
    expect(await service.evaluate(write)).toMatchObject({ allowed: true, approval: "granted" });
    expect(await service.evaluate(write)).toMatchObject({ allowed: true, approval: "not-required" });
    expect(approval).toHaveBeenCalledTimes(2);

    expect(
      await service.evaluate({ kind: "process", category: "process", operation: "bash", target: "npm test" }),
    ).toMatchObject({ allowed: true, approval: "granted" });
    expect(service.snapshot().policy).toBe("Standard");

    expect(
      await service.evaluate({ kind: "network", category: "ssh", operation: "bash", target: "ssh prod" }),
    ).toMatchObject({ allowed: false, approval: "denied", reason: "不要连接生产环境" });
  });

  it("elevates directly to the minimum policy that permits the current action", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-required-policy-"));
    const requests: Array<{ policy: PolicyLevel; requiredPolicy?: PolicyLevel }> = [];
    const approval = vi.fn(async (request) => {
      requests.push({ policy: request.policy, requiredPolicy: request.requiredPolicy });
      return { type: "elevate" as const, level: request.requiredPolicy };
    });

    const safeWrite = createExecutionPolicyService({ workspace, policy: "Safe", approval });
    await expect(
      safeWrite.evaluate({ kind: "file-write", category: "file-write", target: join(workspace, "a.txt") }),
    ).resolves.toMatchObject({ allowed: true, approval: "granted" });
    expect(requests.at(-1)).toEqual({ policy: "Safe", requiredPolicy: "Standard" });

    const standardSsh = createExecutionPolicyService({ workspace, policy: "Standard", approval });
    await expect(
      standardSsh.evaluate({ kind: "network", category: "ssh", target: "ssh build-host" }),
    ).resolves.toMatchObject({ allowed: true, approval: "granted" });
    expect(requests.at(-1)).toEqual({ policy: "Standard", requiredPolicy: "YOLO" });

    const standardDelete = createExecutionPolicyService({ workspace, policy: "Standard", approval });
    await expect(
      standardDelete.evaluate({ kind: "process", category: "destructive", risk: "high", target: "rm -rf build" }),
    ).resolves.toMatchObject({ allowed: true, approval: "granted" });
    expect(requests.at(-1)).toEqual({ policy: "Standard", requiredPolicy: "Auto" });
    expect(standardDelete.snapshot().policy).toBe("Auto");
  });

  it("switches approval level in memory without probing bwrap", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-policy-switch-"));
    const service = createExecutionPolicyService({ workspace });
    expect(service.snapshot().policy).toBe("Auto");
    await expect(service.switchPolicy("Safe")).resolves.toMatchObject({ policy: "Safe", boundary: "Host" });
    await expect(service.switchPolicy("Auto")).resolves.toMatchObject({ policy: "Auto", boundary: "Host" });
  });

  it.each(POLICY_LEVELS)("keeps Workflow authority independent under %s", async (policy: PolicyLevel) => {
    const workspace = await mkdtemp(join(tmpdir(), "vspi-workflow-authority-"));
    const authority = vi.fn(async () => false);
    const service = createExecutionPolicyService({ workspace, policy, workflowAuthority: authority });
    const decision = await service.evaluate({
      kind: "workflow-authority",
      operation: "release-with-token=WORKFLOW_SECRET_SENTINEL",
    });
    expect(decision.allowed).toBe(false);
    expect(authority).toHaveBeenCalledOnce();
    expect(JSON.stringify(service.auditLog())).not.toContain("WORKFLOW_SECRET_SENTINEL");
  });
});
