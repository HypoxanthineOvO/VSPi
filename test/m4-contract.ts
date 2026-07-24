export type PolicyLevel = "Safe" | "Standard" | "Auto" | "YOLO";

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

export interface ExecutionPolicyService {
  snapshot(): PolicySnapshot;
  evaluate(action: PolicyAction): Promise<PolicyDecision>;
  switchPolicy(policy: PolicyLevel): Promise<PolicySnapshot>;
  execute(input: {
    action: PolicyAction;
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<PolicyExecutionResult>;
  auditLog(): readonly unknown[];
}

export interface ExecutionPolicyModule {
  POLICY_LEVELS: readonly PolicyLevel[];
  resolveEffectivePolicy(input?: {
    globalPolicy?: PolicyLevel;
    cliPolicy?: PolicyLevel;
    projectPolicy?: PolicyLevel;
    recovery?: boolean;
  }): PolicySnapshot;
  createExecutionPolicyService(options: {
    workspace: string;
    policy?: PolicyLevel;
    approval?: (action: PolicyAction) => Promise<boolean>;
    acknowledgeYolo?: () => Promise<boolean>;
    networkAllowlist?: string[];
    workflowAuthority?: (action: PolicyAction) => Promise<boolean>;
  }): ExecutionPolicyService;
  inspectLinuxSandboxSupport(): Promise<{
    supported: boolean;
    backend: "bwrap" | "unsupported";
    diagnostic: string;
  }>;
}

export interface StartupSecurityModule {
  resolveStartupSecurity(input: { argv: string[]; globalPolicy?: PolicyLevel; projectPolicy?: PolicyLevel }): {
    recovery: boolean;
    policy: PolicyLevel;
    boundary: "Sandboxed" | "Host";
    trustedProject: boolean;
    resourceScope: "workspace" | "global-only";
    projectSettings: boolean;
    extensions: boolean;
    workflowAdapter: boolean;
  };
}

export async function loadExecutionPolicyModule(): Promise<ExecutionPolicyModule | undefined> {
  const specifier = "../src/policy/execution-policy.js";
  return import(specifier).catch(() => undefined) as Promise<ExecutionPolicyModule | undefined>;
}

export async function loadStartupSecurityModule(): Promise<StartupSecurityModule | undefined> {
  const specifier = "../src/policy/startup-security.js";
  return import(specifier).catch(() => undefined) as Promise<StartupSecurityModule | undefined>;
}
