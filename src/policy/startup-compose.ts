import { homedir } from "node:os";
import { createStartupWorkflowAdapter } from "../workflow/startup.js";
import type { WorkflowAdapter } from "../workflow/types.js";
import { createPolicyConfigService } from "./config-service.js";
import type { ExecutionPolicyService } from "./execution-policy.js";
import {
  createInteractiveApprovalBroker,
  createStartupPolicyRuntime,
  createYoloAcknowledgementBroker,
  type InteractiveApprovalBroker,
  type YoloAcknowledgementBroker,
} from "./startup-runtime.js";
import { resolveStartupSecurity, type StartupSecuritySnapshot } from "./startup-security.js";

/**
 * 入口共用的启动期 Policy 组合：interactive / render-once / exec 共享同一套
 * 安全快照、审批 broker 与 Workflow adapter 装配，避免多处漂移。
 */
export async function composeStartupPolicy(workspace: string): Promise<{
  security: StartupSecuritySnapshot;
  executionPolicy: ExecutionPolicyService;
  approvalBroker: InteractiveApprovalBroker;
  yoloAcknowledgementBroker: YoloAcknowledgementBroker;
  workflowAdapter: WorkflowAdapter;
}> {
  const argv = process.argv.slice(2);
  const preliminary = resolveStartupSecurity({ argv });
  const configService = createPolicyConfigService({
    cwd: workspace,
    home: process.env.HOME ?? homedir(),
    trustedProject: preliminary.trustedProject,
    recovery: preliminary.recovery,
  });
  const config = await configService.load();
  const security = resolveStartupSecurity({
    argv,
    globalPolicy: config.globalPolicy,
    ...(config.projectPolicy ? { projectPolicy: config.projectPolicy } : {}),
  });
  const yoloAcknowledgementBroker = createYoloAcknowledgementBroker();
  const approvalBroker = createInteractiveApprovalBroker();
  const workflowAdapter = await createStartupWorkflowAdapter({
    enabled: security.workflowAdapter,
    workspace,
    disabledReason: security.recovery ? "recovery" : "not-enabled",
  });
  const executionPolicy = await createStartupPolicyRuntime({
    workspace,
    security,
    configService: { load: async () => config },
    approvalBroker: (request, signal) => approvalBroker.request(request, signal),
    acknowledgeYolo: () => yoloAcknowledgementBroker.consume(),
    workflowAuthority: (action) => workflowAdapter.authorize(action),
  });
  return { security, executionPolicy, approvalBroker, yoloAcknowledgementBroker, workflowAdapter };
}
