import { createDecorator } from '#/_base/di/instantiation';
import { defineState } from '#/state/state';

export const stepRetryRecoveryDeadlineKey = defineState<number | undefined>(
  'stepRetry.recoveryDeadline',
  () => undefined as number | undefined,
);

export interface IAgentStepRetryService {
  readonly _serviceBrand: undefined;
}

export const IAgentStepRetryService = createDecorator<IAgentStepRetryService>(
  'agentStepRetryService',
);
