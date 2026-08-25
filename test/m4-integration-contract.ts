import type { ExecutionPolicyService, PolicyLevel } from "./m4-contract.js";

export interface AgentToolLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (value: unknown) => void,
  ): Promise<unknown>;
}

export interface PolicyToolModule {
  createPolicyToolOverrides(options: {
    workspace: string;
    executionPolicy: ExecutionPolicyService;
  }): Record<"read" | "bash" | "powershell" | "edit" | "write", AgentToolLike>;
}

export interface PolicyConfigSnapshot {
  globalPolicy: PolicyLevel;
  projectPolicy?: PolicyLevel;
  effectivePolicy: PolicyLevel;
  networkAllowlist: string[];
  hash: string;
  diagnostics: string[];
}

export interface PolicyConfigService {
  load(): Promise<PolicyConfigSnapshot>;
  save(
    scope: "global" | "project",
    value: { policy: PolicyLevel; networkAllowlist?: string[]; [key: string]: unknown },
    options: { expectedHash: string },
  ): Promise<{ hash: string; path: string }>;
}

export interface PolicyConfigModule {
  createPolicyConfigService(options: {
    cwd: string;
    home: string;
    trustedProject: boolean;
    recovery?: boolean;
  }): PolicyConfigService;
}

export interface StartupPolicyRuntimeModule {
  createYoloAcknowledgementBroker(options?: { startupAuthorized?: boolean }): {
    grantOnce(source: "tui" | "cli-startup"): void;
    consume(): Promise<boolean>;
    cancel(): void;
  };
  createStartupPolicyRuntime(options: {
    workspace: string;
    security: { recovery: boolean; policy: PolicyLevel; trustedProject: boolean };
    configService: Pick<PolicyConfigService, "load">;
    approvalBroker?: (action: unknown) => Promise<boolean>;
    acknowledgeYolo?: () => Promise<boolean>;
    workflowAuthority?: (action: unknown) => Promise<boolean>;
  }): Promise<ExecutionPolicyService>;
}

export async function loadPolicyToolModule(): Promise<PolicyToolModule | undefined> {
  const specifier = "../src/policy/pi-policy-tools.js";
  return import(specifier).catch(() => undefined) as Promise<PolicyToolModule | undefined>;
}

export async function loadPolicyConfigModule(): Promise<PolicyConfigModule | undefined> {
  const specifier = "../src/policy/config-service.js";
  return import(specifier).catch(() => undefined) as Promise<PolicyConfigModule | undefined>;
}

export async function loadStartupPolicyRuntimeModule(): Promise<StartupPolicyRuntimeModule | undefined> {
  const specifier = "../src/policy/startup-runtime.js";
  return import(specifier).catch(() => undefined) as Promise<StartupPolicyRuntimeModule | undefined>;
}
