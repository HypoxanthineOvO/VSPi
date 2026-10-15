import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IEventService } from '#/app/event/event';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IAgentLoopService } from '#/agent/loop/loop';
import {
  AgentPromptChannel,
  type PromptSubmissionInput,
} from '#/agent/loop/promptChannel';

const SCOPE = 'session:test/agent:main';

function memoryStore(): IAtomicDocumentStore {
  const data = new Map<string, unknown>();
  return {
    _serviceBrand: undefined,
    get: async <T>(scope: string, key: string) => data.get(`${scope}/${key}`) as T | undefined,
    set: async (scope: string, key: string, value: unknown) => {
      data.set(`${scope}/${key}`, value);
    },
    delete: async (scope: string, key: string) => {
      data.delete(`${scope}/${key}`);
    },
    list: async (scope: string, prefix = '') =>
      [...data.keys()]
        .filter((k) => k.startsWith(`${scope}/${prefix}`))
        .map((k) => k.slice(scope.length + 1)),
    acquire: (): IDisposable => ({ dispose() {} }),
  };
}

function submissionKey(promptId: string): string {
  return `desktop-submissions/${createHash('sha256').update(promptId).digest('hex')}.json`;
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

function subInput(promptId: string, text = 'hello'): PromptSubmissionInput {
  return { promptId, input: [{ type: 'text', text }] };
}

function setup(
  store: IAtomicDocumentStore = memoryStore(),
  overrides: { metadata?: Partial<ISessionMetadata> } = {},
) {
  const loop = {
    submit: vi.fn(() => ({ id: 'entry-1' })),
  } as unknown as IAgentLoopService;
  const metadata = {
    read: vi.fn(async () => ({ title: undefined, titleKind: undefined })),
    update: vi.fn(async () => undefined),
    ...overrides.metadata,
  } as unknown as ISessionMetadata;
  const eventService = { publish: vi.fn() } as unknown as IEventService;
  const channel = new AgentPromptChannel(
    loop,
    {
      agentId: 'main',
      scope: (subKey?: string) => (subKey === undefined ? SCOPE : `${SCOPE}/${subKey}`),
    } as unknown as IAgentScopeContext,
    metadata,
    eventService,
    { sessionId: 'session-test' } as unknown as ISessionContext,
    { track2: vi.fn() } as unknown as ITelemetryService,
    store,
  );
  return { channel, loop, metadata, eventService, store };
}

describe('AgentPromptChannel.submitOnce', () => {
  it('deduplicates concurrent identical submissions into one loop submit', async () => {
    const { channel, loop } = setup();
    const [first, second] = await Promise.all([
      channel.submitOnce(subInput('p1')),
      channel.submitOnce(subInput('p1')),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ promptId: 'p1', state: 'accepted' });
    expect(loop.submit).toHaveBeenCalledTimes(1);
  });

  it('returns the stored receipt on retry after the service is rebuilt', async () => {
    const store = memoryStore();
    const first = setup(store);
    const submitted = await first.channel.submitOnce(subInput('p1'));
    const second = setup(store);
    const receipt = await second.channel.submitOnce(subInput('p1'));
    expect(receipt).toEqual(submitted);
    expect(second.loop.submit).not.toHaveBeenCalled();
  });

  it('rejects a reused prompt id with different content and does not submit', async () => {
    const { channel, loop } = setup();
    await channel.submitOnce(subInput('p1'));
    await expect(channel.submitOnce(subInput('p1', 'different'))).rejects.toMatchObject({
      code: 'prompt.id_conflict',
    });
    expect(loop.submit).toHaveBeenCalledTimes(1);
  });

  it('reports interrupted for a submission reserved before a crash', async () => {
    const store = memoryStore();
    const input = subInput('p-crash');
    await store.set(SCOPE, submissionKey(input.promptId), {
      promptId: input.promptId,
      fingerprint: submissionFingerprint(input),
      phase: 'reserved',
      state: 'interrupted',
      submittedAt: new Date().toISOString(),
    });
    const { channel, loop } = setup(store);
    const receipt = await channel.submitOnce(input);
    expect(receipt.state).toBe('interrupted');
    expect(loop.submit).not.toHaveBeenCalled();
  });

  it('rejects a malformed stored record without submitting', async () => {
    const store = memoryStore();
    await store.set(SCOPE, submissionKey('p1'), { bogus: true });
    const { channel, loop } = setup(store);
    await expect(channel.submitOnce(subInput('p1'))).rejects.toThrow();
    expect(loop.submit).not.toHaveBeenCalled();
  });

  it('does not submit when the reservation write fails', async () => {
    const store = memoryStore();
    vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('disk full'));
    const { channel, loop } = setup(store);
    await expect(channel.submitOnce(subInput('p1'))).rejects.toThrow('disk full');
    expect(loop.submit).not.toHaveBeenCalled();
  });

  it('keeps a reserved record after a metadata failure so retry stays ambiguous', async () => {
    const store = memoryStore();
    const { channel, loop } = setup(store, {
      metadata: { update: vi.fn(async () => { throw new Error('meta boom'); }) },
    });
    await expect(channel.submitOnce(subInput('p1'))).rejects.toThrow('meta boom');
    expect(loop.submit).not.toHaveBeenCalled();
    const retry = await channel.submitOnce(subInput('p1'));
    expect(retry.state).toBe('interrupted');
    expect(loop.submit).not.toHaveBeenCalled();
  });

  it('passes steerIfActive for steer mode only', async () => {
    const { channel, loop } = setup();
    await channel.submitOnce({ ...subInput('p-steer'), mode: 'steer' });
    await channel.submitOnce(subInput('p-queue'));
    await channel.submitOnce({ ...subInput('p-default') });
    expect(vi.mocked(loop.submit).mock.calls[0]?.[1]).toEqual({ steerIfActive: true });
    expect(vi.mocked(loop.submit).mock.calls[1]?.[1]).toEqual({ steerIfActive: false });
    expect(vi.mocked(loop.submit).mock.calls[2]?.[1]).toEqual({ steerIfActive: false });
  });

  it('serializes submissions across prompt ids', async () => {
    const { channel, loop } = setup();
    await Promise.all([channel.submitOnce(subInput('a')), channel.submitOnce(subInput('b'))]);
    const submittedIds = vi
      .mocked(loop.submit)
      .mock.calls.map(([entry]) => (entry.meta as { promptId?: string } | undefined)?.promptId);
    expect(submittedIds).toEqual(['a', 'b']);
  });

  it('rejects malformed submission input before any store write', async () => {
    const store = memoryStore();
    const { channel, loop } = setup(store);
    const invalid: unknown[] = [
      null,
      { promptId: 'x' },
      { promptId: 'x', input: [] },
      { promptId: 'x', input: [{ type: 'bogus-part' }] },
      { promptId: 'x', input: [{ type: 'text', text: 42 }] },
      { promptId: 'x', input: [{ type: 'text', text: 'a' }], permissionMode: 'root' },
      { promptId: 'x', input: [{ type: 'text', text: 'a' }], mode: 'bogus' },
    ];
    for (const input of invalid) {
      await expect(
        channel.submitOnce(input as PromptSubmissionInput),
      ).rejects.toMatchObject({ code: 'request.invalid' });
    }
    expect(loop.submit).not.toHaveBeenCalled();
    await expect(store.list(SCOPE, 'desktop-submissions/')).resolves.toEqual([]);
  });

  it('executes the parsed snapshot even when the caller mutates the input after the call', async () => {
    const { channel, loop } = setup();
    const input = {
      promptId: 'p-mut',
      input: [{ type: 'text' as const, text: 'original' }],
    };
    const promise = channel.submitOnce(input);
    input.input[0]!.text = 'mutated';
    input.input.push({ type: 'text', text: 'extra' });
    const receipt = await promise;
    expect(receipt.state).toBe('accepted');
    const submitted = vi.mocked(loop.submit).mock.calls[0]?.[0];
    expect(
      (submitted?.message as { content: Array<{ type: string; text: string }> }).content,
    ).toEqual([{ type: 'text', text: 'original' }]);
    const retry = await channel.submitOnce({
      promptId: 'p-mut',
      input: [{ type: 'text', text: 'original' }],
    });
    expect(retry).toEqual(receipt);
    await expect(
      channel.submitOnce({ promptId: 'p-mut', input: [{ type: 'text', text: 'mutated' }] }),
    ).rejects.toMatchObject({ code: 'prompt.id_conflict' });
    expect(loop.submit).toHaveBeenCalledTimes(1);
  });

  it('keeps a reserved record when the final receipt write fails so retry does not re-execute', async () => {
    const store = memoryStore();
    const realSet = store.set.bind(store);
    let writes = 0;
    vi.spyOn(store, 'set').mockImplementation(async (scope, key, value) => {
      writes += 1;
      if (writes === 2) throw new Error('receipt write failed');
      return realSet(scope, key, value);
    });
    const { channel, loop } = setup(store);
    await expect(channel.submitOnce(subInput('p1'))).rejects.toThrow('receipt write failed');
    expect(loop.submit).toHaveBeenCalledTimes(1);
    const retry = await channel.submitOnce(subInput('p1'));
    expect(retry.state).toBe('interrupted');
    expect(loop.submit).toHaveBeenCalledTimes(1);
  });

  it('rejects a stored record with inconsistent phase or state', async () => {
    const input = subInput('p1');
    const base = {
      promptId: 'p1',
      fingerprint: submissionFingerprint(input),
      submittedAt: new Date().toISOString(),
    };
    for (const record of [
      { ...base, phase: 'submitted', state: 'interrupted' },
      { ...base, phase: 'reserved', state: 'accepted' },
      { ...base, fingerprint: 'not-a-sha', phase: 'reserved', state: 'interrupted' },
    ]) {
      const store = memoryStore();
      await store.set(SCOPE, submissionKey('p1'), record);
      const { channel, loop } = setup(store);
      await expect(channel.submitOnce(input)).rejects.toThrow();
      expect(loop.submit).not.toHaveBeenCalled();
    }
  });

  it('validates prompt id bounds', async () => {
    const { channel, loop } = setup();
    await expect(channel.submitOnce(subInput(''))).rejects.toMatchObject({
      code: 'request.invalid',
    });
    await expect(
      channel.submitOnce(subInput('x'.repeat(129))),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(loop.submit).not.toHaveBeenCalled();
  });

  it('getSubmission returns undefined for an unknown prompt id and the durable receipt otherwise', async () => {
    const { channel } = setup();
    await expect(channel.getSubmission('missing')).resolves.toBeUndefined();
    const submitted = await channel.submitOnce(subInput('p1'));
    await expect(channel.getSubmission('p1')).resolves.toEqual(submitted);
  });

  it('getSubmission waits for an in-flight submission of the same id', async () => {
    const { channel } = setup();
    const submitted = channel.submitOnce(subInput('p1'));
    await expect(channel.getSubmission('p1')).resolves.toMatchObject({
      promptId: 'p1',
      state: 'accepted',
    });
    await submitted;
  });
});
