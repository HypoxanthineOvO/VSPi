/**
 * The aggregated klient contract — service wire name → method → zod
 * input/output schemas, across the core/session/agent scopes. The klient
 * factory validates every call against this table; transports never see it.
 * Event registrations live in the per-scope `events.ts` files alongside
 * their payload schemas.
 */

import { z } from 'zod';
import { noResult } from './helpers.js';
import type { KlientContract } from './types.js';
import {
  agentCommandContract,
  agentCronContract,
  agentContextMemoryContract,
  agentHistoryContract,
  agentActivityContract,
  agentFullCompactionContract,
  agentGoalContract,
  agentLoopContract,
  agentMcpContract,
  agentPermissionModeContract,
  agentPlanContract,
  agentRuntimeBindingContract,
  agentProfileContract,
  agentPromptContract,
  agentShellCommandContract,
  agentSkillContract,
  agentTaskContract,
  agentTowerContract,
  agentTokenCountingContract,
  agentUsageContract,
} from './agent/services.js';
import { authContract, authSummaryContract } from './global/auth.js';
import { capabilitiesContract } from './global/capabilities.js';
import { catalogContract } from './global/catalog.js';
import { providerDiscoveryContract } from './global/providerDiscovery.js';
import { registryImportContract } from './global/registryImport.js';
import { configContract } from './global/config.js';
import { envContract } from './global/env.js';
import { filesContract } from './global/files.js';
import { flagsContract } from './global/flags.js';
import { hostFsContract } from './global/hostFs.js';
import { modelsContract } from './global/models.js';
import { mcpManagementContract } from './global/mcpManagement.js';
import { pluginsContract } from './global/plugins.js';
import { providersContract } from './global/providers.js';
import { sessionsContract } from './global/sessions.js';
import { workspacesContract } from './global/workspaces.js';
import { sessionApprovalContract } from './session/approval.js';
import { sessionActivityViewContract } from './session/activity.js';
import { sessionInteractionContract } from './session/interaction.js';
import { sessionManagerContract } from './session/lifecycle.js';
import { sessionMetadataContract } from './session/metadata.js';
import { sessionQuestionContract } from './session/question.js';
import { sessionSkillCatalogContract } from './session/skills.js';
import { sessionTitleContract } from './session/title.js';

export const globalContract: KlientContract = {
  // core (app scope)
  sessionIndex: sessionsContract,
  workspaceService: workspacesContract,
  configService: configContract,
  providerService: providersContract,
  modelService: modelsContract,
  modelResolver: catalogContract,
  providerDiscovery: providerDiscoveryContract,
  modelsDevImport: registryImportContract,
  oauthService: authContract,
  authSummaryService: authSummaryContract,
  flagService: flagsContract,
  pluginService: pluginsContract,
  capabilityService: capabilitiesContract,
  hostFolderBrowser: hostFsContract,
  bootstrapService: envContract,
  fileService: filesContract,
  mcpManagementService: mcpManagementContract,
  sessionManager: sessionManagerContract,
  // session scope
  sessionMetadata: sessionMetadataContract,
  sessionBtwService: { start: { input: z.tuple([]), output: z.string() }, close: { input: z.tuple([z.string().min(1)]), output: noResult } },
  sessionInteractionService: sessionInteractionContract,
  sessionApprovalService: sessionApprovalContract,
  sessionQuestionService: sessionQuestionContract,
  sessionSkillCatalog: sessionSkillCatalogContract,
  sessionTitleService: sessionTitleContract,
  sessionActivityView: sessionActivityViewContract,
  // agent scope
  agentPromptService: agentPromptContract,
  agentSkillService: agentSkillContract,
  agentLoopService: agentLoopContract,
  agentPermissionModeService: agentPermissionModeContract,
  agentCommandService: agentCommandContract,
  agentRuntimeBindingService: agentRuntimeBindingContract,
  agentContextMemoryService: agentContextMemoryContract,
  agentHistoryService: agentHistoryContract,
  agentActivityView: agentActivityContract,
  agentTokenCountingService: agentTokenCountingContract,
  agentShellCommandService: agentShellCommandContract,
  agentProfileService: agentProfileContract,
  agentUsageService: agentUsageContract,
  agentPlanService: agentPlanContract,
  agentTaskService: agentTaskContract,
  agentTowerService: agentTowerContract,
  agentMcpService: agentMcpContract,
  agentFullCompactionService: agentFullCompactionContract,
  agentCronViewService: agentCronContract,
  agentGoalViewService: agentGoalContract,
};

export type { KlientContract, ProcedureContract, ServiceContract, StreamingProcedureContract } from './types.js';
export { isStreamingContract } from './types.js';
