import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentCron, type CronRuntime } from '#/features/cron/cronAgentRuntime';
import type { CronTask, CronTaskInit } from '#/features/cron/cronTask';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { IAgentCronViewService } from './cronView';

export class AgentCronViewService implements IAgentCronViewService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly manager: IAgentLifecycleService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {}

  list(): readonly CronTask[] {
    return this.cron.list();
  }

  create(init: CronTaskInit): CronTask {
    return this.cron.addTask(init);
  }

  delete(id: string): boolean {
    return this.cron.removeTasks([id]).length > 0;
  }

  private get cron(): CronRuntime {
    return this.manager.resolve(this.scope.agentContext, AgentCron);
  }
}
