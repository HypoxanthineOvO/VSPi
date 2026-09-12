import { abortError } from '#/_base/utils/abort';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;

export interface RetryBackoffOptions {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export function retryBackoffDelay(
  attemptIndex: number,
  options: RetryBackoffOptions = {},
): number {
  const initialDelayMs = options.initialDelayMs ?? BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;
  const base = Math.min(initialDelayMs * Math.pow(RETRY_FACTOR, attemptIndex), maxDelayMs);
  return base + Math.random() * JITTER_FACTOR * base;
}

export function retryBackoffDelays(
  maxAttempts: number,
  options: RetryBackoffOptions = {},
): number[] {
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    delays.push(retryBackoffDelay(i, options));
  }
  return delays;
}

export function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export async function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2 ** 31 - 1) throw new RangeError('Retry delay exceeds the supported timer range');
  await new Promise<void>((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(signal?.reason ?? abortError()); };
    const timer = setTimeout(finish, delayMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const details = (error as { details?: unknown }).details;
  if (details !== null && typeof details === 'object') {
    const detailsStatus = (details as { statusCode?: unknown }).statusCode;
    if (typeof detailsStatus === 'number') return detailsStatus;
  }
  return undefined;
}
