import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export const POLICY_LEVELS = ["Safe", "Standard", "YOLO", "Auto"] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

export type ApprovalCategory =
  | "file-read"
  | "file-write"
  | "bash-read"
  | "process"
  | "network"
  | "ssh"
  | "git-write"
  | "destructive"
  | "container"
  | "system"
  | "shared";

export interface PolicySnapshot {
  policy: PolicyLevel;
  boundary: "Host";
  sandboxed: false;
  recovery: boolean;
  sessionAllowlist: ApprovalCategory[];
  persistenceWarning?: string;
}

export interface PolicyAction {
  kind: "file-read" | "file-write" | "process" | "network" | "shared" | "workflow-authority";
  target?: string;
  risk?: "low" | "medium" | "high";
  operation?: string;
  category?: ApprovalCategory;
}

export interface ApprovalRequest {
  action: PolicyAction;
  category: ApprovalCategory;
  policy: PolicyLevel;
  requiredPolicy?: PolicyLevel;
}

export type ApprovalResponse =
  | { type: "allow-once" }
  | { type: "allow-session"; category?: ApprovalCategory }
  | { type: "elevate"; level?: PolicyLevel }
  | { type: "deny"; reason?: string };

export interface PolicyDecision {
  allowed: boolean;
  approval: "not-required" | "required" | "granted" | "denied";
  reason: string;
  sandboxed: false;
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
  evaluate(action: PolicyAction, signal?: AbortSignal): Promise<PolicyDecision>;
  switchPolicy(policy: PolicyLevel): Promise<PolicySnapshot>;
  execute(input: PolicyExecutionInput): Promise<PolicyExecutionResult>;
  auditLog(): readonly unknown[];
}

export interface ExecutionPolicyServiceOptions {
  workspace: string;
  policy?: PolicyLevel;
  approval?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalResponse | boolean>;
  workflowAuthority?: (action: PolicyAction) => Promise<boolean>;
  recovery?: boolean;
  /** Retained for source compatibility with v0.1 callers. */
  acknowledgeYolo?: () => Promise<boolean>;
  /** Retained for config compatibility; M1 no longer treats it as a sandbox boundary. */
  networkAllowlist?: string[];
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
  if (input.recovery) return snapshotFor("Standard", true, new Set());
  const requested = input.cliPolicy ?? input.globalPolicy ?? "Auto";
  const requestedIndex = POLICY_LEVELS.indexOf(requested);
  const projectIndex = input.projectPolicy ? POLICY_LEVELS.indexOf(input.projectPolicy) : requestedIndex;
  const effective = POLICY_LEVELS[Math.min(requestedIndex, projectIndex)] ?? "Auto";
  return snapshotFor(effective, false, new Set());
}

export function createExecutionPolicyService(options: ExecutionPolicyServiceOptions): ExecutionPolicyService {
  const workspace = resolve(options.workspace);
  let policy: PolicyLevel = options.recovery ? "Standard" : (options.policy ?? "Auto");
  const recovery = options.recovery ?? false;
  const sessionAllowlist = new Set<ApprovalCategory>();
  const entries: AuditEntry[] = [];

  async function evaluate(action: PolicyAction, signal?: AbortSignal): Promise<PolicyDecision> {
    let decision: PolicyDecision;
    if (action.kind === "workflow-authority") {
      const authorized = (await options.workflowAuthority?.(action)) ?? false;
      decision = decisionFor(
        authorized,
        "not-required",
        authorized ? "Workflow authority gate granted independently" : "Workflow authority gate denied",
      );
    } else {
      const category = categoryFor(action);
      if (sessionAllowlist.has(category)) {
        decision = decisionFor(true, "not-required", `Session allows ${category}`);
      } else if (!requiresApproval(policy, action, workspace)) {
        decision = decisionFor(true, "not-required", `${policy} permits ${category} on Host`);
      } else {
        decision = await requestApproval(action, category, signal);
      }
    }
    entries.push({ at: new Date().toISOString(), policy, action: redactAction(action), decision });
    return decision;
  }

  async function requestApproval(
    action: PolicyAction,
    category: ApprovalCategory,
    signal?: AbortSignal,
  ): Promise<PolicyDecision> {
    if (signal?.aborted) throw abortError();
    const requiredPolicy = requiredPolicyFor(policy, action, workspace);
    const raw = await options.approval?.(
      { action: structuredClone(action), category, policy, ...(requiredPolicy ? { requiredPolicy } : {}) },
      signal,
    );
    const response = normalizeApprovalResponse(raw);
    if (response.type === "allow-once") return decisionFor(true, "granted", `Approved ${category} once`);
    if (response.type === "allow-session") {
      const allowedCategory = response.category ?? category;
      sessionAllowlist.add(allowedCategory);
      return decisionFor(true, "granted", `Approved ${allowedCategory} for this session`);
    }
    if (response.type === "elevate") {
      const level = response.level ?? requiredPolicy;
      if (!level || level !== requiredPolicy || requiresApproval(level, action, workspace)) {
        return decisionFor(false, "denied", "Approval level does not permit the requested action");
      }
      if (recovery) return decisionFor(false, "denied", "Recovery keeps Standard approval level");
      policy = level;
      return decisionFor(true, "granted", `Approval level raised to ${level} for this session`);
    }
    return decisionFor(false, "denied", response.reason?.trim() || `${category} was rejected by the user`);
  }

  async function switchPolicy(next: PolicyLevel): Promise<PolicySnapshot> {
    if (!POLICY_LEVELS.includes(next)) throw new Error(`未知 Policy：${next}`);
    if (recovery && next !== "Standard") throw new Error("Recovery 强制 Standard · Host，拒绝切换 Policy");
    policy = next;
    return snapshotFor(policy, recovery, sessionAllowlist);
  }

  async function execute(input: PolicyExecutionInput): Promise<PolicyExecutionResult> {
    const decision = await evaluate(input.action, input.signal);
    if (!decision.allowed) return { decision, started: false, exitCode: null, stdout: "", stderr: decision.reason };
    const result = await runChild(input.command, input.args, {
      cwd: input.cwd ?? workspace,
      env: { ...process.env, ...input.env },
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    entries.push({
      at: new Date().toISOString(),
      policy,
      action: redactAction(input.action),
      decision,
      execution: { started: true, exitCode: result.exitCode, command: basename(input.command) },
    });
    return { decision, started: true, ...result };
  }

  return {
    snapshot: () => snapshotFor(policy, recovery, sessionAllowlist),
    evaluate,
    switchPolicy,
    execute,
    auditLog: (): readonly AuditEntry[] => structuredClone(entries),
  };
}

function requiresApproval(policy: PolicyLevel, action: PolicyAction, workspace: string): boolean {
  if (policy === "Auto") return false;
  const category = categoryFor(action);
  if (policy === "Safe") return category !== "file-read" && category !== "bash-read";
  if (policy === "Standard") {
    if (action.risk === "high") return true;
    if (category === "file-read" || category === "bash-read") return false;
    if (category === "file-write") return !insideWorkspace(action.target, workspace);
    return ["network", "ssh", "git-write", "destructive", "container", "system", "shared"].includes(category);
  }
  return action.risk === "high" || ["destructive", "container", "system"].includes(category);
}

function categoryFor(action: PolicyAction): ApprovalCategory {
  if (action.category) return action.category;
  if (action.kind === "file-read") return "file-read";
  if (action.kind === "file-write") return "file-write";
  if (action.kind === "network") return "network";
  if (action.kind === "shared") return "shared";
  return action.operation === "read" ? "bash-read" : "process";
}

function requiredPolicyFor(current: PolicyLevel, action: PolicyAction, workspace: string): PolicyLevel | undefined {
  const currentIndex = POLICY_LEVELS.indexOf(current);
  return POLICY_LEVELS.slice(currentIndex + 1).find((candidate) => !requiresApproval(candidate, action, workspace));
}

function normalizeApprovalResponse(value: ApprovalResponse | boolean | undefined): ApprovalResponse {
  if (value === true) return { type: "allow-once" };
  if (!value) return { type: "deny" };
  return value;
}

function decisionFor(allowed: boolean, approval: PolicyDecision["approval"], reason: string): PolicyDecision {
  return { allowed, approval, reason, sandboxed: false };
}

function snapshotFor(policy: PolicyLevel, recovery: boolean, sessionAllowlist: Set<ApprovalCategory>): PolicySnapshot {
  return { policy, boundary: "Host", sandboxed: false, recovery, sessionAllowlist: [...sessionAllowlist].sort() };
}

function insideWorkspace(target: string | undefined, workspace: string): boolean {
  if (!target) return false;
  const candidate = resolve(workspace, target);
  const relation = relative(workspace, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
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

function abortError(): Error {
  const error = new Error("Approval cancelled");
  error.name = "AbortError";
  return error;
}
