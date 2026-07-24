import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { type ExecutionPolicyService, loadExecutionPolicyModule } from "./m4-contract.js";

const execFile = promisify(execFileCallback);

async function policyModule() {
  const module = await loadExecutionPolicyModule();
  expect(module, "M4 must expose the Linux sandbox execution boundary").toBeDefined();
  return module;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vspi-m4-linux-probe-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(workspace), mkdir(outside)]));
  const workspaceRead = join(workspace, "read.txt");
  const outsideSensitive = join(outside, "sensitive.txt");
  await writeFile(workspaceRead, "WORKSPACE_READ_OK");
  await writeFile(outsideSensitive, "OUTSIDE_SENSITIVE_SENTINEL");
  return { root, workspace, outside, workspaceRead, outsideSensitive };
}

function nodeScript(script: string, ...args: string[]) {
  return { command: process.execPath, args: ["-e", script, ...args] };
}

async function run(
  service: ExecutionPolicyService,
  script: string,
  args: string[],
  action: { kind: "process" | "network"; target?: string; risk?: "low" | "high" },
) {
  const command = nodeScript(script, ...args);
  return service.execute({ ...command, action });
}

describe("M4 real Linux sandbox probes", () => {
  it("reports real bubblewrap/user-namespace support or an explicit unsupported diagnostic", async () => {
    const hostHasBwrap = await execFile("bwrap", ["--version"])
      .then(({ stdout }) => /bubblewrap/i.test(stdout))
      .catch(() => false);
    const module = await policyModule();
    if (!module) return;
    const support = await module.inspectLinuxSandboxSupport();
    if (!hostHasBwrap) {
      expect(support).toMatchObject({ supported: false, backend: "unsupported" });
      expect(support.diagnostic).toMatch(/bwrap|user namespace|unsupported|不支持/i);
      return;
    }
    expect(support).toMatchObject({ supported: true, backend: "bwrap" });
    expect(support.diagnostic).toMatch(/bwrap|bubblewrap|user namespace/i);
  });

  it("runs Safe as read-only: workspace read succeeds while writes, outside read, and loopback fail", async () => {
    const module = await policyModule();
    if (!module) return;
    const paths = await fixture();
    const service = module.createExecutionPolicyService({ workspace: paths.workspace, policy: "Safe" });
    const reader = "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))";
    const writer = "require('node:fs').writeFileSync(process.argv[1], 'MUTATED')";
    const workspaceRead = await run(service, reader, [paths.workspaceRead], { kind: "process", risk: "low" });
    expect(workspaceRead).toMatchObject({ started: true, exitCode: 0, decision: { sandboxed: true } });
    expect(workspaceRead.stdout).toContain("WORKSPACE_READ_OK");

    const workspaceWritePath = join(paths.workspace, "safe-write.txt");
    expect((await run(service, writer, [workspaceWritePath], { kind: "process", risk: "low" })).exitCode).not.toBe(0);
    await expect(access(workspaceWritePath)).rejects.toThrow();
    expect((await run(service, reader, [paths.outsideSensitive], { kind: "process", risk: "low" })).exitCode).not.toBe(
      0,
    );
    expect(await readFile(paths.outsideSensitive, "utf8")).toBe("OUTSIDE_SENSITIVE_SENTINEL");
    expect(
      await service.evaluate({ kind: "file-write", target: join(paths.outside, "safe-denied.txt") }),
    ).toMatchObject({
      allowed: false,
      sandboxed: true,
    });
    expect(await service.evaluate({ kind: "network", target: "http://127.0.0.1:9" })).toMatchObject({
      allowed: false,
      sandboxed: true,
    });
  });

  it("lets Standard mutate workspace but defaults outside, shared, risky, and network actions to deny", async () => {
    const module = await policyModule();
    if (!module) return;
    const paths = await fixture();
    const approval = vi.fn(async () => false);
    const service = module.createExecutionPolicyService({ workspace: paths.workspace, policy: "Standard", approval });
    const workspaceWritePath = join(paths.workspace, "standard-write.txt");
    const writer = "require('node:fs').writeFileSync(process.argv[1], 'STANDARD_WRITE_OK')";
    expect((await run(service, writer, [workspaceWritePath], { kind: "process", risk: "low" })).exitCode).toBe(0);
    expect(await readFile(workspaceWritePath, "utf8")).toBe("STANDARD_WRITE_OK");
    for (const action of [
      { kind: "file-read" as const, target: paths.outsideSensitive },
      { kind: "file-write" as const, target: join(paths.outside, "denied.txt") },
      { kind: "shared" as const, target: "shared-resource" },
      { kind: "process" as const, target: "risky", risk: "high" as const },
      { kind: "network" as const, target: "http://127.0.0.1:9" },
    ]) {
      expect(await service.evaluate(action)).toMatchObject({ allowed: false, approval: "denied", sandboxed: true });
    }
    expect(approval).toHaveBeenCalledTimes(5);
  });

  it("lets approved Standard and configured Auto reach loopback while Auto stays filesystem-sandboxed without prompts", async () => {
    const module = await policyModule();
    if (!module) return;
    const paths = await fixture();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("LOOPBACK_OK");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server did not bind");
    const url = `http://127.0.0.1:${address.port}/probe`;
    const networkScript = "fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t))";
    try {
      const standardApproval = vi.fn(async () => true);
      const standard = module.createExecutionPolicyService({
        workspace: paths.workspace,
        policy: "Standard",
        approval: standardApproval,
        networkAllowlist: [url],
      });
      const approved = await run(standard, networkScript, [url], { kind: "network", target: url });
      expect(approved).toMatchObject({ started: true, exitCode: 0, decision: { approval: "granted" } });
      expect(approved.stdout).toContain("LOOPBACK_OK");

      const autoApproval = vi.fn(async () => false);
      const auto = module.createExecutionPolicyService({
        workspace: paths.workspace,
        policy: "Auto",
        approval: autoApproval,
        networkAllowlist: [url],
      });
      const automatic = await run(auto, networkScript, [url], { kind: "network", target: url });
      expect(automatic).toMatchObject({
        started: true,
        exitCode: 0,
        decision: { approval: "not-required", sandboxed: true },
      });
      expect(autoApproval).not.toHaveBeenCalled();
      const outsideReader = "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))";
      expect(
        (await run(auto, outsideReader, [paths.outsideSensitive], { kind: "process", risk: "low" })).exitCode,
      ).not.toBe(0);
      const outsideWrite = join(paths.outside, "auto-denied.txt");
      const outsideWriter = "require('node:fs').writeFileSync(process.argv[1], 'AUTO_MUST_NOT_ESCAPE')";
      expect((await run(auto, outsideWriter, [outsideWrite], { kind: "process", risk: "low" })).exitCode).not.toBe(0);
      await expect(access(outsideWrite)).rejects.toThrow();
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("runs YOLO on Host only after acknowledgement and bypasses VSPi approval and sandbox", async () => {
    const module = await policyModule();
    if (!module) return;
    const paths = await fixture();
    const approval = vi.fn(async () => false);
    const acknowledgeYolo = vi.fn(async () => true);
    const service = module.createExecutionPolicyService({ workspace: paths.workspace, approval, acknowledgeYolo });
    await service.switchPolicy("YOLO");
    const outsideWrite = join(paths.outside, "yolo-write.txt");
    const writer = "require('node:fs').writeFileSync(process.argv[1], 'YOLO_HOST_WRITE_OK')";
    const result = await run(service, writer, [outsideWrite], { kind: "process", risk: "high" });
    expect(result).toMatchObject({
      started: true,
      exitCode: 0,
      decision: { allowed: true, approval: "not-required", sandboxed: false },
    });
    expect(await readFile(outsideWrite, "utf8")).toBe("YOLO_HOST_WRITE_OK");
    expect(acknowledgeYolo).toHaveBeenCalledOnce();
    expect(approval).not.toHaveBeenCalled();
  });
});
