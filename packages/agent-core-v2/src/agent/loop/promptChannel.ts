import { createHash } from 'node:crypto';

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventService } from '#/app/event/event';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { contentPartSchema } from '#/human/agent/historySchema';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import { Error2, ErrorCodes } from '#/errors';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

import {
  IAgentLoopService,
  type PromptLaunchResult,
  type PromptPayload,
  type SteerPayload,
} from './loop';

export interface PromptSubmissionInput extends PromptPayload {
  readonly promptId: string;
  readonly mode?: 'queue' | 'steer';
}

export interface PromptSubmissionReceipt {
  readonly promptId: string;
  readonly state: 'accepted' | 'interrupted';
  readonly submittedAt: string;
}

interface StoredSubmission extends PromptSubmissionReceipt {
  readonly fingerprint: string;
  readonly phase: 'reserved' | 'submitted';
}

const submissionInputSchema = z.object({
  promptId: z.string().min(1).max(128),
  input: z.array(contentPartSchema).min(1).max(256),
  permissionMode: z.enum(['auto', 'manual', 'yolo']).optional(),
  mode: z.enum(['queue', 'steer']).optional(),
});

export interface IAgentPromptChannel {
  readonly _serviceBrand: undefined;
  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined>;
  submitOnce(input: PromptSubmissionInput): Promise<PromptSubmissionReceipt>;
  getSubmission(promptId: string): Promise<PromptSubmissionReceipt | undefined>;
}

export const IAgentPromptChannel = createDecorator<IAgentPromptChannel>('agentPromptService');

export class AgentPromptChannel implements IAgentPromptChannel {
  declare readonly _serviceBrand: undefined;

  private submissionChain: Promise<unknown> = Promise.resolve();
  private readonly submissions = new Map<
    string,
    { readonly fingerprint: string; readonly promise: Promise<PromptSubmissionReceipt> }
  >();

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {}

  async submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    await this.updateMetadata(promptMetadataTextFromContentParts(payload.input));
    const status = this.loop.snapshot();
    const { id } = this.loop.submit({
      message: { role: 'user', content: [...payload.input] },
      meta: { permissionMode: payload.permissionMode, promptId: payload.promptId, origin: { kind: 'user' }, tracked: true },
    });
    if (status.state === 'running' || status.paused || status.queue.length > 0) return undefined;
    return launchResult(this.loop, id);
  }

  async submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined> {
    this.telemetry.track2('input_steer', { parts: payload.input.length });
    await this.updateMetadata(promptMetadataTextFromContentParts(payload.input));
    const status = this.loop.snapshot();
    const { id } = this.loop.submit(
      {
        message: { role: 'user', content: [...payload.input] },
        meta: { promptId: payload.promptId, origin: { kind: 'user' }, tracked: true },
      },
      { steerIfActive: true },
    );
    if (status.state === 'running' && status.activePromptId === undefined) return undefined;
    return launchResult(this.loop, id);
  }

  private async updateMetadata(text: string | undefined): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    await applyPromptMetadataUpdate(
      {
        metadata: this.metadata,
        eventService: this.eventService,
        sessionId: this.sessionContext.sessionId,
      },
      text,
    );
  }

  async submitOnce(input: PromptSubmissionInput): Promise<PromptSubmissionReceipt> {
    const parsed = submissionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt submission input is invalid');
    }
    const data: PromptSubmissionInput = parsed.data;
    const promptId = data.promptId;
    const fingerprint = submissionFingerprint(data);
    const inFlight = this.submissions.get(promptId);
    if (inFlight !== undefined) {
      if (inFlight.fingerprint !== fingerprint) throw promptIdConflict();
      return inFlight.promise;
    }
    const promise = this.enqueueSubmission(() =>
      this.submitOnceDurable(data, promptId, fingerprint),
    );
    this.submissions.set(promptId, { fingerprint, promise });
    const release = (): void => {
      this.submissions.delete(promptId);
    };
    void promise.then(release, release);
    return promise;
  }

  async getSubmission(promptId: string): Promise<PromptSubmissionReceipt | undefined> {
    assertPromptId(promptId);
    const inFlight = this.submissions.get(promptId);
    if (inFlight !== undefined) await inFlight.promise.catch(() => undefined);
    const stored = await this.documents.get<StoredSubmission>(
      this.scopeContext.scope(),
      submissionKey(promptId),
    );
    if (stored === undefined) return undefined;
    return submissionReceipt(assertStoredSubmission(stored, promptId));
  }

  private enqueueSubmission(operation: () => Promise<PromptSubmissionReceipt>): Promise<PromptSubmissionReceipt> {
    const result = this.submissionChain.then(operation, operation);
    this.submissionChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async submitOnceDurable(
    input: PromptSubmissionInput,
    promptId: string,
    fingerprint: string,
  ): Promise<PromptSubmissionReceipt> {
    const scope = this.scopeContext.scope();
    const key = submissionKey(promptId);
    const existing = await this.documents.get<StoredSubmission>(scope, key);
    if (existing !== undefined) {
      const stored = assertStoredSubmission(existing, promptId);
      if (stored.fingerprint !== fingerprint) throw promptIdConflict();
      return submissionReceipt(stored);
    }
    const record: StoredSubmission = {
      promptId,
      fingerprint,
      phase: 'reserved',
      state: 'interrupted',
      submittedAt: new Date().toISOString(),
    };
    await this.documents.set(scope, key, record);
    await this.updateMetadata(promptMetadataTextFromContentParts(input.input));
    this.loop.submit(
      {
        message: { role: 'user', content: [...input.input] },
        meta: {
          promptId,
          permissionMode: input.permissionMode,
          origin: { kind: 'user' },
          tracked: true,
        },
      },
      { steerIfActive: input.mode === 'steer' },
    );
    await this.documents.set(scope, key, { ...record, phase: 'submitted', state: 'accepted' });
    return { promptId, state: 'accepted', submittedAt: record.submittedAt };
  }
}

const SUBMISSION_KEY_PREFIX = 'desktop-submissions/';

function submissionKey(promptId: string): string {
  return `${SUBMISSION_KEY_PREFIX}${createHash('sha256').update(promptId).digest('hex')}.json`;
}

function submissionFingerprint(input: PromptSubmissionInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        input: input.input,
        permissionMode: input.permissionMode ?? null,
        mode: input.mode ?? 'queue',
      }),
    )
    .digest('hex');
}

function assertPromptId(promptId: string): string {
  if (typeof promptId !== 'string' || promptId.length === 0 || promptId.length > 128) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'promptId must be a non-empty string of at most 128 characters',
    );
  }
  return promptId;
}

function promptIdConflict(): Error2 {
  return new Error2(
    ErrorCodes.PROMPT_ID_CONFLICT,
    'Prompt ID was already used with different content',
  );
}

function assertStoredSubmission(record: StoredSubmission, promptId: string): StoredSubmission {
  if (
    record === null ||
    typeof record !== 'object' ||
    record.promptId !== promptId ||
    typeof record.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    (record.phase !== 'reserved' && record.phase !== 'submitted') ||
    (record.state !== 'accepted' && record.state !== 'interrupted') ||
    (record.phase === 'reserved') !== (record.state === 'interrupted') ||
    typeof record.submittedAt !== 'string' ||
    Number.isNaN(Date.parse(record.submittedAt))
  ) {
    throw new StorageError(
      StorageErrors.codes.STORAGE_CORRUPTED,
      'Stored prompt submission record is malformed',
    );
  }
  return record;
}

function submissionReceipt(record: StoredSubmission): PromptSubmissionReceipt {
  return {
    promptId: record.promptId,
    state: record.phase === 'submitted' ? 'accepted' : 'interrupted',
    submittedAt: record.submittedAt,
  };
}

async function launchResult(
  loop: IAgentLoopService,
  id: string,
): Promise<PromptLaunchResult | undefined> {
  const turn = await loop.promptHandle(id)?.launched;
  if (turn === undefined) return undefined;
  await turn.ready.catch(() => undefined);
  return turn.id === undefined ? undefined : { turn_id: turn.id };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptChannel,
  AgentPromptChannel,
  ScopeActivation.OnDemand,
  'prompt',
);
