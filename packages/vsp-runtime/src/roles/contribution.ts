import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { registerScopedService } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { LifecycleScope } from '@moonshot-ai/agent-core-v2/app/scopes';
import { AgentProfileContribution, AGENT_PROFILE_SOURCE_PRIORITY } from '@moonshot-ai/agent-core-v2/app/agentProfileCatalog/agentProfileContribution';
import { IBuiltinAgentProfileLoader } from '@moonshot-ai/agent-core-v2/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { SubagentDefaultBindingContribution } from '@moonshot-ai/agent-core-v2/session/subagent/subagentService';
import { createRoleProfiles } from './profiles.js';
import { type RoleName, type RoleRouting } from './config.js';

class RolePresetContribution extends Service {
  constructor(
    @IBuiltinAgentProfileLoader builtin: IBuiltinAgentProfileLoader,
    @IConfigService config: IConfigService,
  ) {
    super();
    this.provide(AgentProfileContribution, {
      sourceId: 'vspi', priority: AGENT_PROFILE_SOURCE_PRIORITY.plugin,
      contribution: { profiles: createRoleProfiles(builtin, config) },
    });
    this.provide(SubagentDefaultBindingContribution, {
      resolveModel: role => config.get<RoleRouting>('roleRouting')[role as RoleName]?.default,
    });
  }
}

registerScopedService(LifecycleScope.App, createDecorator<RolePresetContribution>('vspiRolePresets'), RolePresetContribution);
