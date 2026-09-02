import {
  type ApprovalRequest,
  type ApprovalResponse,
  createExecutionPolicyService,
  type ExecutionPolicyService,
  type PolicyAction,
  type PolicyLevel,
} from "./execution-policy.js";

export interface InteractiveApprovalBroker {
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResponse>;
  setHandler(
    handler: ((request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalResponse>) | undefined,
  ): void;
}

export function createInteractiveApprovalBroker(): InteractiveApprovalBroker {
  let handler: ((request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalResponse>) | undefined;
  return {
    request(request, signal) {
      return handler?.(request, signal) ?? Promise.resolve({ type: "deny", reason: "Approval UI is unavailable" });
    },
    setHandler(next) {
      handler = next;
    },
  };
}

export type YoloAcknowledgementSource = "tui" | "cli-startup";

export interface YoloAcknowledgementBroker {
  grantOnce(source: YoloAcknowledgementSource): void;
  consume(): Promise<boolean>;
  cancel(): void;
}

export function createYoloAcknowledgementBroker(
  options: { startupAuthorized?: boolean } = {},
): YoloAcknowledgementBroker {
  let pending: YoloAcknowledgementSource | undefined = options.startupAuthorized ? "cli-startup" : undefined;
  return {
    grantOnce(source) {
      pending = source;
    },
    async consume() {
      const granted = pending !== undefined;
      pending = undefined;
      return granted;
    },
    cancel() {
      pending = undefined;
    },
  };
}

export async function createStartupPolicyRuntime(options: {
  workspace: string;
  security: { recovery: boolean; policy: PolicyLevel; trustedProject: boolean };
  configService: {
    load(): Promise<{
      effectivePolicy: PolicyLevel;
      networkAllowlist: string[];
    }>;
  };
  approvalBroker?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalResponse | boolean>;
  acknowledgeYolo?: () => Promise<boolean>;
  workflowAuthority?: (action: PolicyAction) => Promise<boolean>;
}): Promise<ExecutionPolicyService> {
  const config = await options.configService.load();
  const recovery = options.security.recovery;
  const policy = recovery ? "Standard" : options.security.policy;
  const service = createExecutionPolicyService({
    workspace: options.workspace,
    recovery,
    policy,
    networkAllowlist: recovery ? [] : config.networkAllowlist,
    approval: recovery
      ? async () => ({ type: "deny", reason: "Recovery does not grant elevated tool approval" })
      : async (request, signal) =>
          (await options.approvalBroker?.(request, signal)) ?? {
            type: "deny",
            reason: "Approval UI is unavailable",
          },
    acknowledgeYolo: recovery ? async () => false : async () => (await options.acknowledgeYolo?.()) ?? false,
    workflowAuthority: recovery
      ? async () => false
      : async (action) => (await options.workflowAuthority?.(action)) ?? false,
  });
  return service;
}

export type StartupApprovalBroker = (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => Promise<ApprovalResponse | boolean>;
