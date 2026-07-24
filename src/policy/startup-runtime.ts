import {
  createExecutionPolicyService,
  type ExecutionPolicyService,
  type PolicyAction,
  type PolicyLevel,
} from "./execution-policy.js";

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
  approvalBroker?: (action: unknown) => Promise<boolean>;
  acknowledgeYolo?: () => Promise<boolean>;
  workflowAuthority?: (action: PolicyAction) => Promise<boolean>;
}): Promise<ExecutionPolicyService> {
  const config = await options.configService.load();
  const recovery = options.security.recovery;
  const policy = recovery ? "Standard" : options.security.policy;
  const service = createExecutionPolicyService({
    workspace: options.workspace,
    recovery,
    policy: policy === "YOLO" ? "Standard" : policy,
    networkAllowlist: recovery ? [] : config.networkAllowlist,
    approval: recovery ? async () => false : async (action) => (await options.approvalBroker?.(action)) ?? false,
    acknowledgeYolo: recovery ? async () => false : async () => (await options.acknowledgeYolo?.()) ?? false,
    workflowAuthority: recovery
      ? async () => false
      : async (action) => (await options.workflowAuthority?.(action)) ?? false,
  });
  if (policy === "YOLO" && !recovery) await service.switchPolicy("YOLO");
  return service;
}

export type StartupApprovalBroker = (action: PolicyAction) => Promise<boolean>;
