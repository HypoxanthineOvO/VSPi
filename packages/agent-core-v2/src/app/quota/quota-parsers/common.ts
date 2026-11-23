import { setTimeout as delay } from 'node:timers/promises';
import type { QuotaBalanceItem, QuotaErrorReason, QuotaWindowItem } from '../quota-contract';

export type Failure = QuotaErrorReason | 'network';

export class QuotaError extends Error {
  constructor(readonly reason: Failure) { super(reason); }
}

export function failure(error: unknown): Failure {
  if (error instanceof QuotaError) return error.reason;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'timeout';
  return 'network';
}

export function checkStatus(status: number): void {
  if (Number.isInteger(status) && status >= 200 && status < 300) return;
  throw new QuotaError(status === 401 ? 'auth_expired' : status === 403 ? 'forbidden'
    : status === 429 ? 'rate_limited' : status === 408 ? 'timeout'
    : status >= 500 && status <= 599 ? 'network' : status === 404 || status === 405 ? 'unsupported'
    : 'schema_mismatch');
}

export function temporary(reason: Failure): boolean {
  return reason === 'network' || reason === 'timeout' || reason === 'rate_limited';
}

export async function retry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (attempt === 2 || !temporary(failure(error))) throw error;
      await delay(150 * (attempt + 1));
    }
  }
}

export type RequestQuota = (url: URL | string, init?: { headers?: Record<string, string>; body?: unknown }) => Promise<unknown>;

export interface Reading {
  windows: QuotaWindowItem[];
  balances: QuotaBalanceItem[];
}

export function reading(): Reading { return { windows: [], balances: [] }; }

export function requireReading(result: Reading): Reading {
  if (result.windows.length === 0 && result.balances.length === 0) throw new QuotaError('schema_mismatch');
  return result;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function percent(value: unknown): number | undefined {
  const n = numeric(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}

export function instant(value: unknown, encoding: 's' | 'ms' | 'auto' = 'auto'): number | undefined {
  const n = numeric(value);
  const t = n === undefined ? typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN
    : n * (encoding === 's' || (encoding === 'auto' && n < 1e12) ? 1000 : 1);
  return Number.isFinite(t) && t >= 0 && t <= 8.64e15 ? t : undefined;
}

export function window(result: Reading, id: string, label: string, remaining: number | undefined, reset?: unknown, modelIds?: string[], start?: unknown): void {
  if (remaining === undefined || result.windows.some(item => item.id === id)) return;
  const resetAt = instant(reset), startAt = instant(start);
  if (reset !== null && reset !== undefined && resetAt === undefined || start !== null && start !== undefined && startAt === undefined ||
      startAt !== undefined && resetAt !== undefined && startAt >= resetAt) return;
  result.windows.push({ id, label, remainingPercent: remaining, resetAt, modelIds });
}

export function usedWindow(result: Reading, id: string, label: string, used: unknown, reset?: unknown, modelIds?: string[]): void {
  const n = percent(used);
  window(result, id, label, n === undefined ? undefined : 100 - n, reset, modelIds);
}

export function balance(id: string, currency: string, amount: number, options?: { label?: string; limit?: number; multiplier?: number; unlimited?: boolean }): QuotaBalanceItem {
  const multiplier = options?.multiplier;
  const equivalent = multiplier !== undefined && multiplier > 0 && !options?.unlimited ? amount / multiplier : undefined;
  return {
    id, currency, amount, label: options?.label, limit: options?.limit, unlimited: options?.unlimited,
    multiplier: multiplier !== undefined && multiplier > 0 && Number.isFinite(multiplier) ? multiplier : undefined,
    equivalentAmount: equivalent !== undefined && Number.isFinite(equivalent) ? equivalent : undefined,
  };
}

export function bearer(token: string): Record<string, string> {
  if (!token || !/^[\x21-\x7E]+$/.test(token)) throw new QuotaError('no_credential');
  return { authorization: `Bearer ${token}` };
}

export function managementRoot(base: string | undefined, management: string | undefined): URL {
  let url: URL;
  try { url = new URL(management ?? base ?? ''); }
  catch { throw new QuotaError('unsupported'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:') || url.username || url.password || url.search || url.hash) {
    throw new QuotaError('unsupported');
  }
  return new URL(management === undefined ? `${url.origin}/` : `${url.origin}${url.pathname.replace(/\/+$/, '')}/`);
}
