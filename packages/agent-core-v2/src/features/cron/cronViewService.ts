import { IAgentCronService } from '#/features/cron/cronService';
import type { CronTask, CronTaskInit } from '#/features/cron/cronTask';
import type { IAgentCronViewService } from './cronView';

export class AgentCronViewService implements IAgentCronViewService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentCronService private readonly cron: IAgentCronService) {}

  list(): readonly CronTask[] {
    return this.cron.list();
  }

  create(init: CronTaskInit): CronTask {
    return this.cron.addTask(init);
  }

  delete(id: string): boolean {
    return this.cron.removeTasks([id]).length > 0;
  }

}
