import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IAgentScopeContext } from '@moonshot-ai/agent-core-v2/agent/scopeContext/scopeContext';
import { registerAgentToolService } from '@moonshot-ai/agent-core-v2/agent/toolRegistry/toolContribution';
import { resolveSubagentModelPool } from '@moonshot-ai/agent-core-v2/session/subagent/configSection';
import { ToolAccesses, type AgentTool, type ToolExecution } from '@moonshot-ai/agent-core-v2/tool/toolContract';
import { ROLE_NAMES, roleRoutingSchema, routingInstructions, type RoleRouting } from './config.js';

export class RoleRoutingTool implements AgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'RoleRouting';
  readonly description = 'Read or replace role/tier model routing and ordered alias fallback lists. Main agent only. Read before choosing a tier. A write replaces the entire roleRouting section in config.toml after normal permission approval; read first and preserve entries you want to keep. Never changes the subagent model pool. The returned current table supersedes any older startup mapping in this conversation.';
  readonly parameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'set'] },
      routing: { type: 'object', description: 'For set: complete roleRouting object. explore/coder: default, fast, hard; frontend: default, mid, high; plan/reviewer/consultant: default. fallback maps preferred alias to ordered alias arrays. Every alias must already be in the subagent pool.' },
    }, required: ['action'], additionalProperties: false,
  };

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {}

  resolveExecution(input: unknown): ToolExecution {
    if (this.scope.agentId !== 'main') return { isError: true, output: 'RoleRouting is available only to the main agent.' };
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return { isError: true, output: 'Expected action get or set.' };
    const args = input as { action?: unknown; routing?: unknown };
    if (Object.keys(args).some(key => key !== 'action' && key !== 'routing')) return { isError: true, output: 'Unknown RoleRouting argument.' };
    if (args.action === 'get' && args.routing === undefined) return {
      approvalRule: 'RoleRouting(get)', accesses: ToolAccesses.none(),
      execute: async () => ({ output: this.current() }),
    };
    if (args.action !== 'set' || args.routing === undefined) return { isError: true, output: 'Use get without routing, or set with the complete routing object.' };
    let routing: RoleRouting;
    try {
      routing = roleRoutingSchema.parse(args.routing);
      this.validatePool(routing);
    } catch (error) {
      return { isError: true, output: error instanceof Error ? error.message : 'Invalid routing.' };
    }
    return {
      approvalRule: 'RoleRouting(set)',
      description: 'Replace role routing and fallback lists in config.toml',
      accesses: ToolAccesses.all(),
      execute: async () => {
        this.validatePool(routing);
        await this.config.replace('roleRouting', routing);
        return { output: this.current() };
      },
    };
  }

  private validatePool(routing: RoleRouting): void {
    const pool = resolveSubagentModelPool(this.config);
    const aliases = ROLE_NAMES.flatMap(role => Object.values(routing[role] ?? {}));
    for (const [alias, fallback] of Object.entries(routing.fallback ?? {})) aliases.push(alias, ...fallback);
    for (const alias of aliases) {
      if (pool === undefined || !Object.hasOwn(pool.models, alias)) throw new Error(`Alias "${alias}" is not in secondary_model.models. Change the pool separately first.`);
    }
  }

  private current(): string {
    const routing = this.config.get<RoleRouting>('roleRouting');
    return `Current role routing (supersedes all previous tables):\n${JSON.stringify(routing, null, 2)}\n${routingInstructions(routing, this.config.get<{ force?: boolean }>('secondaryModel')?.force === true)}`;
  }
}

registerAgentToolService(createDecorator<RoleRoutingTool>('vspiRoleRoutingTool'), RoleRoutingTool, {
  name: 'RoleRouting', domain: 'vspiRoles',
  when: accessor => accessor.get(IAgentScopeContext).agentId === 'main',
});
