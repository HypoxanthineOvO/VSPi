import { describe, expect, it } from 'vitest';
import { getEventListeners } from 'node:events';
import { readRetryAfterMs, sleepForRetry } from '#/_base/utils/retry';

import {
  abortError,
  abortable,
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';

describe('userCancellationReason', () => {
  it('is recognised as a deliberate user cancellation', () => {
    expect(isUserCancellation(userCancellationReason())).toBe(true);
  });

  it('stays an AbortError so abort detection keeps treating it as an abort', () => {
    expect(isAbortError(userCancellationReason())).toBe(true);
  });

  it('is distinguishable from a generic abort, an ordinary error, and undefined', () => {
    expect(isUserCancellation(abortError())).toBe(false);
    expect(isUserCancellation(new Error('boom'))).toBe(false);
    expect(isUserCancellation(undefined)).toBe(false);
  });

  it('keeps custom system abort messages classified as AbortError', () => {
    expect(abortError('Session closed')).toMatchObject({
      name: 'AbortError',
      message: 'Session closed',
    });
  });
});

describe('abortable', () => {
  it('removes its abort listener when cancellation wins over an unfinished operation', async () => {
    const controller = new AbortController();
    const operation = abortable(new Promise<never>(() => {}), controller.signal);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('rejects with the signal reason when already aborted', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    controller.abort(reason);

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toBe(reason);
  });

  it('rejects with the signal reason when aborted while pending', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    const pending = new Promise<never>(() => {});
    const result = abortable(pending, controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it('normalizes the default AbortController reason to a generic AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
  });

  it('falls back to a generic AbortError when the signal reason is not an Error', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
  });
});

describe('retry waiting', () => {
  it('removes the timer and abort listener when a retry wait is cancelled', async () => {
    const controller = new AbortController();
    const before = process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
    const wait = sleepForRetry(1_800_000, controller.signal);
    controller.abort(userCancellationReason());
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(process.getActiveResourcesInfo().filter(type => type === 'Timeout')).toHaveLength(before);
  });

  it.each([Infinity, NaN, -1, 2 ** 31])('rejects invalid retry delay %s without creating a timer', async (delay) => {
    const before = process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
    await expect(sleepForRetry(delay)).rejects.toBeInstanceOf(RangeError);
    expect(process.getActiveResourcesInfo().filter(type => type === 'Timeout')).toHaveLength(before);
  });

  it.each([Infinity, NaN, -1, 0])('does not accept invalid Retry-After milliseconds %s', (retryAfterMs) => {
    expect(readRetryAfterMs({ retryAfterMs })).toBeNull();
  });
});
