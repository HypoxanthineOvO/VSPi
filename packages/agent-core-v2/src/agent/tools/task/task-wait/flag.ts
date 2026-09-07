import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const WAIT_FOR_FLAG_ID = 'wait_for';
export const WAIT_FOR_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_WAIT_FOR';

export const waitForFlag: FlagDefinitionInput = {
  id: WAIT_FOR_FLAG_ID,
  title: 'WaitFor tool',
  description:
    'Give the model the WaitFor tool so it can wait for background tasks inside the current turn instead of ending the turn and being re-invoked. Off by default: models overuse it to hold turns open, so the default execution model is to end the turn and be resumed by the task notification.',
  env: WAIT_FOR_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(waitForFlag);
