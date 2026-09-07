import { createDecorator } from '#/_base/di/instantiation';
import type { CronTask, CronTaskInit } from '#/features/cron/cronTask';

export interface IAgentCronViewService {
  readonly _serviceBrand: undefined;
  list(): readonly CronTask[];
  create(init: CronTaskInit): CronTask;
  delete(id: string): boolean;
}

export const IAgentCronViewService = createDecorator<IAgentCronViewService>('agentCronViewService');
