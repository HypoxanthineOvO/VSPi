import type { AgentHistoryUpdate } from './history';

export type WatchQueueEntry =
  | { readonly kind: 'event'; readonly update: AgentHistoryUpdate; readonly bytes: number }
  | { readonly kind: 'reset' };

const MAX_QUEUE_ENTRIES = 1024;

export function historyWatchResyncError(): Error {
  return new Error('History watch fell behind; resubscribe with the last applied cursor');
}

export class WatchQueue {
  private entries: WatchQueueEntry[] = [];
  private bytes = 0;
  private failure: unknown;
  private finished = false;
  private readonly waiters: Array<{
    resolve(result: IteratorResult<WatchQueueEntry>): void;
    reject(error: unknown): void;
  }> = [];
  private resolveClosed!: () => void;
  readonly closed: Promise<void> = new Promise((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    private readonly maxBytes: number,
    private readonly onTerminated: () => void,
  ) {}

  get terminated(): boolean {
    return this.failure !== undefined || this.finished;
  }

  push(entry: WatchQueueEntry): void {
    if (this.terminated) return;
    if (entry.kind === 'reset' && this.entries.at(-1)?.kind === 'reset') return;
    if (
      this.entries.length >= MAX_QUEUE_ENTRIES ||
      (entry.kind === 'event' && (entry.bytes > this.maxBytes || this.bytes + entry.bytes > this.maxBytes))
    ) {
      this.fail(historyWatchResyncError());
      return;
    }
    if (entry.kind === 'event') this.bytes += entry.bytes;
    this.entries.push(entry);
    this.flush();
  }

  fail(error: unknown): void {
    if (this.terminated) return;
    this.failure = error;
    this.entries = [];
    this.bytes = 0;
    this.terminate();
  }

  finish(): void {
    if (this.terminated) return;
    this.finished = true;
    this.entries = [];
    this.bytes = 0;
    this.terminate();
  }

  next(): Promise<IteratorResult<WatchQueueEntry>> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const entry = this.entries.shift();
    if (entry !== undefined) {
      if (entry.kind === 'event') this.bytes -= entry.bytes;
      return Promise.resolve({ done: false, value: entry });
    }
    if (this.finished) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private terminate(): void {
    const waiters = this.waiters.splice(0);
    this.onTerminated();
    this.resolveClosed();
    for (const waiter of waiters) {
      if (this.failure !== undefined) waiter.reject(this.failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  private flush(): void {
    while (this.waiters.length > 0 && this.entries.length > 0) {
      const waiter = this.waiters.shift()!;
      const entry = this.entries.shift()!;
      if (entry.kind === 'event') this.bytes -= entry.bytes;
      waiter.resolve({ done: false, value: entry });
    }
  }
}

const MAX_MEASURE_DEPTH = 128;

export function measureHistoryValue(value: unknown, limit: number): number {
  const seen = new WeakSet<object>();
  let total = 0;
  const visit = (input: unknown, depth: number): boolean => {
    if (depth > MAX_MEASURE_DEPTH) return false;
    if (typeof input === 'string') {
      total += input.length + 2;
      if (total > limit) return false;
      total += input.length * 5;
      return total <= limit;
    }
    if (typeof input === 'number') {
      total += 24;
      return total <= limit;
    }
    if (typeof input === 'boolean' || input === null || input === undefined) {
      total += 5;
      return total <= limit;
    }
    if (typeof input === 'object') {
      if (seen.has(input)) return false;
      seen.add(input);
      total += 2;
      if (Array.isArray(input)) {
        total += Math.max(0, input.length - 1);
        for (const item of input) {
          if (!visit(item, depth + 1)) return false;
        }
      } else {
        for (const key of Object.keys(input)) {
          const member = (input as Record<string, unknown>)[key];
          if (member === undefined || typeof member === 'function' || typeof member === 'symbol')
            continue;
          total += (key.length + 3) * 6;
          if (!visit(member, depth + 1)) return false;
        }
      }
      seen.delete(input);
      return total <= limit;
    }
    total += 8;
    return total <= limit;
  };
  if (!visit(value, 0)) return limit + 1;
  return total;
}
