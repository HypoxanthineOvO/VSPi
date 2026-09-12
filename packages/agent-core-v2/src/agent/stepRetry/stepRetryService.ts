/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelay,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { isRetryableGenerateError, isTransientGenerateError } from '#/kosong/contract/errors';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { AgentEvent2 } from '#/app/event/event2';
import { unwrapErrorCause } from '#/errors';
import {
  IAgentLoopService,
  LoopError,
  type LoopErrorContext,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { LoopErrors } from '#/agent/loop/errors';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentStepRetryService, stepRetryRecoveryDeadlineKey } from './stepRetry';

export interface TurnStepRetryingPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export class TurnStepRetrying extends AgentEvent2<TurnStepRetryingPayload> {
  static override readonly type = 'turn.step.retrying';
  static override readonly observable = true;
}
export interface TurnStepRetrying extends TurnStepRetryingPayload {}

export const stepRetryLastFailedDriverIdKey = defineState<string | undefined>(
  'stepRetry.lastFailedDriverId',
  () => undefined as string | undefined,
);
export const stepRetryFailedAttemptsKey = defineState<number>(
  'stepRetry.failedAttempts',
  () => 0,
);

export class AgentStepRetryService extends Disposable implements IAgentStepRetryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
    @IEventBus private readonly eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(stepRetryLastFailedDriverIdKey);
    this.states.contributeState(stepRetryFailedAttemptsKey);
    this.states.contributeState(stepRetryRecoveryDeadlineKey);
    this._register(
      this.loopService.registerLoopErrorHandler({
        id: 'step-retry',
        match: (context) => this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.retryBudgetMs === undefined
          ? isRetryableGenerateError(unwrapErrorCause(context.error))
          : isTransientGenerateError(unwrapErrorCause(context.error)),
        handle: (context) => this.recover(context),
      }),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('step-retry', async (_ctx, next) => {
        this.resetAttempts();
        await next();
      }),
    );
    this._register(this.eventBus.subscribe(TurnStarted, () => this.resetAttempts()));
  }

  private get lastFailedDriverId(): string | undefined {
    return this.states.get(stepRetryLastFailedDriverIdKey);
  }

  private set lastFailedDriverId(value: string | undefined) {
    this.states.set(stepRetryLastFailedDriverIdKey, value);
  }

  private get failedAttempts(): number {
    return this.states.get(stepRetryFailedAttemptsKey);
  }

  private set failedAttempts(value: number) {
    this.states.set(stepRetryFailedAttemptsKey, value);
  }

  private resetAttempts(): void {
    this.lastFailedDriverId = undefined;
    this.failedAttempts = 0;
    this.states.set(stepRetryRecoveryDeadlineKey, undefined);
  }

  private async recover(context: LoopErrorContext): Promise<boolean> {
    const driver = context.failedDriver;
    if (driver === undefined || context.step === undefined) return false;

    if (this.lastFailedDriverId !== driver.id) {
      this.resetAttempts();
      this.lastFailedDriverId = driver.id;
    }
    this.failedAttempts += 1;

    const loopControl = this.config.get<LoopControl>(LOOP_CONTROL_SECTION);
    if (loopControl?.retryBudgetMs !== undefined && this.states.get(stepRetryRecoveryDeadlineKey) === undefined) {
      this.states.set(stepRetryRecoveryDeadlineKey, Date.now() + loopControl.retryBudgetMs);
    }
    const deadline = this.states.get(stepRetryRecoveryDeadlineKey);
    if (deadline !== undefined && Date.now() >= deadline) {
      this.resetAttempts();
      throw new LoopError(LoopErrors.codes.LOOP_RETRY_BUDGET_EXCEEDED, 'Provider retry recovery budget exhausted; this turn has stopped.', { cause: context.error });
    }
    const maxAttempts = Math.max(
      loopControl?.maxAttemptsPerStep ?? DEFAULT_MAX_RETRY_ATTEMPTS,
      1,
    );
    if (this.failedAttempts >= maxAttempts) {
      this.resetAttempts();
      return false;
    }

    const error = unwrapErrorCause(context.error);
    const delayMs = readRetryAfterMs(error) ?? retryBackoffDelay(this.failedAttempts - 1, {
        initialDelayMs: loopControl?.retryInitialDelayMs,
        maxDelayMs: loopControl?.retryMaxDelayMs,
      });
    if (deadline !== undefined && delayMs >= deadline - Date.now()) {
      this.resetAttempts();
      throw new LoopError(LoopErrors.codes.LOOP_RETRY_BUDGET_EXCEEDED, 'Provider retry delay exceeds the remaining recovery budget; this turn has stopped without retrying early.', { cause: error });
    }
    void this.dispatcher.dispatch(
      new TurnStepRetrying({
        agentId: this.scopeContext.agentId,
        turnId: context.turnId,
        step: context.step,
        stepId: context.stepId,
        failedAttempt: this.failedAttempts,
        nextAttempt: this.failedAttempts + 1,
        maxAttempts,
        delayMs,
        ...retryErrorFields(error),
      }),
    );
    await sleepForRetry(delayMs, context.signal);

    if (context.currentStep?.signal.aborted === true) return false;
    if (deadline !== undefined && Date.now() >= deadline) {
      this.resetAttempts();
      throw new LoopError(LoopErrors.codes.LOOP_RETRY_BUDGET_EXCEEDED, 'Provider retry recovery budget exhausted; this turn has stopped.', { cause: error });
    }
    context.retry(driver, { at: 'head' });
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStepRetryService,
  AgentStepRetryService,
  ScopeActivation.OnScopeCreated,
  'stepRetry',
);
