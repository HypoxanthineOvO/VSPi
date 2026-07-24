import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const POLICY_LEVELS = ["Safe", "Standard", "Auto", "YOLO"] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

export interface PolicySnapshot {
  policy: PolicyLevel;
  boundary: "Sandboxed" | "Host";
  sandboxed: boolean;
  recovery: boolean;
}

export interface PolicyAction {
  kind: "file-read" | "file-write" | "process" | "network" | "shared" | "workflow-authority";
  target?: string;
  risk?: "low" | "high";
  operation?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  approval: "not-required" | "required" | "granted" | "denied";
  reason: string;
  sandboxed: boolean;
}

export interface PolicyExecutionResult {
  decision: PolicyDecision;
  started: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface PolicyExecutionInput {
  action: PolicyAction;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExecutionPolicyService {
  snapshot(): PolicySnapshot;
  evaluate(action: PolicyAction): Promise<PolicyDecision>;
  switchPolicy(policy: PolicyLevel): Promise<PolicySnapshot>;
  execute(input: PolicyExecutionInput): Promise<PolicyExecutionResult>;
  auditLog(): readonly unknown[];
}

export interface ExecutionPolicyServiceOptions {
  workspace: string;
  policy?: PolicyLevel;
  approval?: (action: PolicyAction) => Promise<boolean>;
  acknowledgeYolo?: () => Promise<boolean>;
  networkAllowlist?: string[];
  workflowAuthority?: (action: PolicyAction) => Promise<boolean>;
  recovery?: boolean;
}

interface AuditEntry {
  at: string;
  policy: PolicyLevel;
  action: PolicyAction;
  decision: PolicyDecision;
  execution?: { started: boolean; exitCode: number | null; command: string };
}

export function resolveEffectivePolicy(
  input: { globalPolicy?: PolicyLevel; cliPolicy?: PolicyLevel; projectPolicy?: PolicyLevel; recovery?: boolean } = {},
): PolicySnapshot {
  if (input.recovery) return snapshotFor("Standard", true);
  const requested = input.cliPolicy ?? input.globalPolicy ?? "Standard";
  const requestedIndex = POLICY_LEVELS.indexOf(requested);
  const projectIndex = input.projectPolicy ? POLICY_LEVELS.indexOf(input.projectPolicy) : requestedIndex;
  const effective = POLICY_LEVELS[Math.min(requestedIndex, projectIndex)] ?? "Standard";
  return snapshotFor(effective, false);
}

export function createExecutionPolicyService(options: ExecutionPolicyServiceOptions): ExecutionPolicyService {
  const workspace = resolve(options.workspace);
  const initialPolicy = options.recovery || options.policy === "YOLO" ? "Standard" : (options.policy ?? "Standard");
  let current = snapshotFor(initialPolicy, options.recovery ?? false);
  const entries: AuditEntry[] = [];
  const allowlist = (options.networkAllowlist ?? []).map(normalizeNetworkTarget);

  async function evaluate(action: PolicyAction): Promise<PolicyDecision> {
    let decision: PolicyDecision;
    if (action.kind === "workflow-authority") {
      const authorized = (await options.workflowAuthority?.(action)) ?? false;
      decision = decisionFor(
        authorized,
        "not-required",
        authorized ? "Workflow authority gate granted independently" : "Workflow authority gate denied",
        current.sandboxed,
      );
    } else if (current.policy === "YOLO") {
      decision = decisionFor(true, "not-required", "YOLO Host request allowed after acknowledgement", false);
    } else if (current.policy === "Safe") {
      decision = evaluateSafe(action, workspace);
    } else if (current.policy === "Auto") {
      decision = evaluateAuto(action, workspace, allowlist);
    } else {
      decision = await evaluateStandard(action, workspace, allowlist, options.approval);
    }
    entries.push({ at: new Date().toISOString(), policy: current.policy, action: redactAction(action), decision });
    return decision;
  }

  async function switchPolicy(policy: PolicyLevel): Promise<PolicySnapshot> {
    if (!POLICY_LEVELS.includes(policy)) throw new Error(`未知 Policy：${policy}`);
    if (policy === current.policy) return { ...current };
    if (current.recovery) throw new Error("Recovery 强制 Standard · Sandboxed，拒绝切换 Policy");
    const previous = current;
    try {
      if (policy === "YOLO") {
        const acknowledged = (await options.acknowledgeYolo?.()) ?? false;
        if (!acknowledged) throw new Error("YOLO Host 高风险模式需要不可跳过的明确确认 (acknowledge)");
      } else {
        const support = await inspectLinuxSandboxSupport();
        if (!support.supported) throw new Error(`Policy 切换失败：${support.diagnostic}`);
      }
      current = snapshotFor(policy, false);
      return { ...current };
    } catch (error) {
      current = previous;
      throw error;
    }
  }

  async function execute(input: PolicyExecutionInput): Promise<PolicyExecutionResult> {
    const decision = await evaluate(input.action);
    if (!decision.allowed) return { decision, started: false, exitCode: null, stdout: "", stderr: decision.reason };

    let result: Omit<PolicyExecutionResult, "decision" | "started">;
    if (current.policy === "YOLO") {
      result = await runChild(input.command, input.args, {
        cwd: input.cwd ?? workspace,
        env: { ...process.env, ...input.env },
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
    } else {
      const support = await inspectLinuxSandboxSupport();
      if (!support.supported) {
        const unavailable = decisionFor(false, "denied", support.diagnostic, true);
        entries.push({
          at: new Date().toISOString(),
          policy: current.policy,
          action: redactAction(input.action),
          decision: unavailable,
          execution: { started: false, exitCode: null, command: basename(input.command) },
        });
        return { decision: unavailable, started: false, exitCode: null, stdout: "", stderr: support.diagnostic };
      }
      const bwrap = buildBubblewrapArgs({
        workspace,
        writable: current.policy !== "Safe",
        network: input.action.kind === "network",
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        command: input.command,
        args: input.args,
      });
      result = await runChild("bwrap", bwrap, {
        cwd: workspace,
        env: process.env,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
    }
    entries.push({
      at: new Date().toISOString(),
      policy: current.policy,
      action: redactAction(input.action),
      decision,
      execution: { started: true, exitCode: result.exitCode, command: basename(input.command) },
    });
    return { decision, started: true, ...result };
  }

  return {
    snapshot: (): PolicySnapshot => ({ ...current }),
    evaluate,
    switchPolicy,
    execute,
    auditLog: (): readonly AuditEntry[] => structuredClone(entries),
  };
}

export async function inspectLinuxSandboxSupport(): Promise<{
  supported: boolean;
  backend: "bwrap" | "unsupported";
  diagnostic: string;
}> {
  if (process.platform !== "linux") {
    return { supported: false, backend: "unsupported", diagnostic: "bwrap Linux sandbox unsupported on this OS" };
  }
  try {
    const version = await runChild("bwrap", ["--version"], { env: process.env });
    if (version.exitCode !== 0 || !/bubblewrap/i.test(version.stdout))
      throw new Error(version.stderr || "invalid bwrap");
    const probe = await runChild(
      "bwrap",
      ["--die-with-parent", "--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"],
      { env: process.env },
    );
    if (probe.exitCode !== 0) throw new Error(probe.stderr || "user namespace probe failed");
    return {
      supported: true,
      backend: "bwrap",
      diagnostic: `${version.stdout.trim()} · user namespace available`,
    };
  } catch (error) {
    return {
      supported: false,
      backend: "unsupported",
      diagnostic: `bwrap/user namespace unsupported：${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

function evaluateSafe(action: PolicyAction, workspace: string): PolicyDecision {
  if (action.kind === "file-read" && insideWorkspace(action.target, workspace)) {
    return decisionFor(true, "not-required", "Safe permits workspace reads", true);
  }
  if (action.kind === "process" && action.risk !== "high") {
    return decisionFor(true, "not-required", "Safe permits a read-only sandboxed process", true);
  }
  return decisionFor(false, "not-required", "Safe is read-only and has no network/shared/Host authority", true);
}

async function evaluateStandard(
  action: PolicyAction,
  workspace: string,
  allowlist: string[],
  approval: ExecutionPolicyServiceOptions["approval"],
): Promise<PolicyDecision> {
  const routineWorkspace =
    (action.kind === "file-read" || action.kind === "file-write") && insideWorkspace(action.target, workspace);
  const routineProcess = action.kind === "process" && action.risk !== "high";
  if (routineWorkspace || routineProcess) {
    return decisionFor(true, "not-required", "Standard permits reversible workspace activity", true);
  }
  const approved = (await approval?.(action)) ?? false;
  if (!approved) return decisionFor(false, "denied", "Standard approval denied or unavailable", true);
  if (action.kind === "network" && !networkAllowed(action.target, allowlist)) {
    return decisionFor(false, "denied", "Standard network target is outside the configured allowlist", true);
  }
  return decisionFor(true, "granted", "Standard action explicitly approved", true);
}

function evaluateAuto(action: PolicyAction, workspace: string, allowlist: string[]): PolicyDecision {
  if (action.kind === "network") {
    return networkAllowed(action.target, allowlist)
      ? decisionFor(true, "not-required", "Auto network target is configured", true)
      : decisionFor(false, "not-required", "Auto network target is outside configured bounds", true);
  }
  if (action.kind === "file-read" || action.kind === "file-write") {
    return insideWorkspace(action.target, workspace)
      ? decisionFor(true, "not-required", "Auto permits workspace activity", true)
      : decisionFor(false, "not-required", "Auto remains confined to the workspace", true);
  }
  if (action.kind === "process") return decisionFor(true, "not-required", "Auto permits sandboxed processes", true);
  return decisionFor(false, "not-required", "Auto has no unconfigured shared-resource authority", true);
}

function decisionFor(
  allowed: boolean,
  approval: PolicyDecision["approval"],
  reason: string,
  sandboxed: boolean,
): PolicyDecision {
  return { allowed, approval, reason, sandboxed };
}

function snapshotFor(policy: PolicyLevel, recovery: boolean): PolicySnapshot {
  const sandboxed = policy !== "YOLO";
  return { policy, boundary: sandboxed ? "Sandboxed" : "Host", sandboxed, recovery };
}

function insideWorkspace(target: string | undefined, workspace: string): boolean {
  if (!target) return false;
  const candidate = resolve(workspace, target);
  const relation = relative(workspace, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function normalizeNetworkTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
  } catch {
    return value.replace(/\/$/, "");
  }
}

function networkAllowed(target: string | undefined, allowlist: string[]): boolean {
  if (!target) return false;
  const normalized = normalizeNetworkTarget(target);
  return allowlist.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function buildBubblewrapArgs(input: {
  workspace: string;
  writable: boolean;
  network: boolean;
  cwd?: string;
  env?: Record<string, string>;
  command: string;
  args: string[];
}): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (input.network) args.push("--share-net");
  args.push("--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp");
  for (const path of ["/usr", "/bin", "/lib", "/lib64", "/etc"]) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  if (isAbsolute(input.command) && !systemPath(input.command)) {
    for (const parent of destinationParents(input.command)) args.push("--dir", parent);
    args.push("--ro-bind", input.command, input.command);
  }
  for (const parent of destinationParents(input.workspace)) args.push("--dir", parent);
  args.push(input.writable ? "--bind" : "--ro-bind", input.workspace, input.workspace);
  const cwd = input.cwd && insideWorkspace(input.cwd, input.workspace) ? resolve(input.cwd) : input.workspace;
  args.push("--chdir", cwd);
  for (const [name, value] of Object.entries(input.env ?? {})) args.push("--setenv", name, value);
  args.push("--", input.command, ...input.args);
  return args;
}

function systemPath(path: string): boolean {
  return ["/usr", "/bin", "/lib", "/lib64", "/etc"].some((root) => path === root || path.startsWith(`${root}/`));
}

function destinationParents(path: string): string[] {
  const parents: string[] = [];
  let current = dirname(path);
  while (current !== "/" && current !== ".") {
    parents.push(current);
    current = dirname(current);
  }
  return parents.reverse().filter((entry) => entry !== "/tmp");
}

async function runChild(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("timeoutMs 必须是正的有限毫秒数");
  }
  if (options.signal?.aborted) return { exitCode: null, stdout: "", stderr: "Process aborted before spawn" };
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let termination: "abort" | "timeout" | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const kill = (reason: "abort" | "timeout") => {
      if (termination) return;
      termination = reason;
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => kill("abort");
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) timeout = setTimeout(() => kill("timeout"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (termination === "timeout") stderr = `${stderr}${stderr ? "\n" : ""}Process timed out`;
      if (termination === "abort") stderr = `${stderr}${stderr ? "\n" : ""}Process aborted`;
      resolveRun({ exitCode, stdout, stderr });
    });
  });
}

function redactAction(action: PolicyAction): PolicyAction {
  return Object.fromEntries(
    Object.entries(action).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]),
  ) as unknown as PolicyAction;
}

function redact(value: string): string {
  return value
    .replace(/((?:api[-_]?key|token|secret|password|credential)\s*[=:]\s*)[^\s&,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|pk|api)[-_][a-z0-9_-]{12,}\b/gi, "[REDACTED]");
}

function basename(command: string): string {
  return command.split(/[\\/]/).at(-1) || "process";
}
