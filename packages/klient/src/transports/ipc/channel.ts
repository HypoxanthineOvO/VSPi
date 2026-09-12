/**
 * IPC client channel — connects to a `serveKlientIpc` host over a unix
 * domain socket. Calls are correlated by client-chosen ids with a per-call
 * deadline; event subscriptions are registered before the handshake
 * completes and flushed once it does. There is no automatic reconnect: a
 * broken socket rejects in-flight calls and stays closed (the WS transport
 * owns the resumable-connection story).
 */

import { createConnection, type Socket } from 'node:net';

import type {
  CallOptions,
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import { PAYLOAD_TOO_LARGE } from '../json.js';
import { trimTrailingUndefined } from '../args.js';
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_MAX_FRAME_BYTES, encodeFrame, NdjsonDecoder, positiveLimit, type IpcFrame } from './codec.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export interface IpcChannelOptions {
  readonly socketPath: string;
  readonly token?: string;
  /** Per-call deadline (ms). Default `30000`; `0` disables. */
  readonly callTimeoutMs?: number;
  /** Deadline for connecting and completing hello, independently of RPC deadlines. */
  readonly handshakeTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

interface PendingCall {
  readonly resolve: (data: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Async queue for streaming responses. The server pushes chunks via
 * `stream_data` frames; slow consumers are cancelled when the bounded queue fills.
 */
interface PendingStream {
  push(chunk: unknown): void;
  end(): void;
  error(err: Error): void;
}

function scopeKindOf(scope: ScopeRef): 'core' | 'workspace' | 'session' | 'agent' {
  if (scope.agentId !== undefined) return 'agent';
  if (scope.sessionId !== undefined) return 'session';
  if (scope.workspaceId !== undefined) return 'workspace';
  return 'core';
}

export class IpcChannel implements KlientChannel {
  private readonly socket: Socket;
  private readonly decoder: NdjsonDecoder;
  private readonly maxFrameBytes: number;
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;
  private readonly callTimeoutMs: number;
  private readonly pending = new Map<string, PendingCall>();
  private readonly streams = new Map<string, PendingStream>();
  private readonly listens = new Map<
    string,
    { handler: (data: unknown) => void; onError?: (error: Error) => void }
  >();
  private readonly ready: Promise<unknown>;
  private resolveReady!: (data: unknown) => void;
  private rejectReady!: (error: Error) => void;
  private closed = false;
  private seq = 0;
  private readonly idPrefix = `i${Date.now().toString(36)}`;

  constructor(options: IpcChannelOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const handshakeTimeoutMs = positiveLimit(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.maxFrameBytes = positiveLimit(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    this.decoder = new NdjsonDecoder(this.maxFrameBytes);
    this.socket = createConnection(options.socketPath);
    this.ready = new Promise<unknown>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.socket.once('connect', () => {
      this.send({ type: 'hello', token: options.token });
    });
    this.ready.catch(() => {});
    this.handshakeTimer = setTimeout(() => {
      this.terminate(new Error(`IPC handshake timed out after ${handshakeTimeoutMs}ms`));
    }, handshakeTimeoutMs);
    this.handshakeTimer.unref();

    this.socket.on('data', (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          if (this.closed || this.socket.destroyed) break;
          this.onFrame(frame);
        }
      } catch (error) {
        this.terminate(error instanceof Error ? error : new Error('Invalid IPC response'));
      }
    });
    this.socket.on('close', () => {
      const unexpected = !this.closed;
      this.closed = true;
      clearTimeout(this.handshakeTimer);
      this.decoder.clear();
      const error = new Error('ipc closed');
      this.rejectReady(error);
      this.failAll(error);
      if (unexpected) {
        const listeners = [...this.listens.values()];
        this.listens.clear();
        for (const listener of listeners) {
          try { listener.onError?.(error); } catch {}
        }
      }
      this.listens.clear();
    });
    this.socket.on('error', () => {
      // 'close' always follows; teardown lives there.
    });
  }

  async call(
    scope: ScopeRef,
    service: string,
    method: string,
    args: unknown[],
    options?: CallOptions,
  ): Promise<unknown> {
    await this.ready;
    if (this.closed || this.socket.destroyed) throw new Error('ipc closed');
    if (this.pending.size >= 32) throw new RPCError(42901, 'IPC request capacity reached; wait for pending operations');
    const timeoutMs = options?.timeoutMs ?? this.callTimeoutMs;
    const id = this.nextId();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RPCError(50001, `call timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({
      type: 'call',
      id,
      scope: scopeKindOf(scope),
      service,
      method,
      // NDJSON is JSON: trailing optional args would cross as `null` and
      // defeat the host's default parameters — trim them.
      arg: trimTrailingUndefined(args),
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
    });
    return promise;
  }

  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => {
        // Simple queue: push/pull with deferred promises. `buffer` holds
        // already-received chunks waiting for a `next()` call; `waiters`
        // holds unresolved `next()` calls waiting for a chunk.
        const buffer: Array<{ result: IteratorResult<unknown>; bytes: number }> = [];
        let bufferedBytes = 0;
        const waiters: Array<{
          resolve: (result: IteratorResult<unknown>) => void;
          reject: (err: Error) => void;
        }> = [];
        let done = false;
        let streamId: string | undefined;

        const pending: PendingStream = {
          push: (chunk: unknown) => {
            if (done) return;
            const result: IteratorResult<unknown> = { done: false, value: chunk };
            const waiter = waiters.shift();
            if (waiter !== undefined) {
              waiter.resolve(result);
            } else {
              const bytes = Buffer.byteLength(JSON.stringify(chunk) ?? 'null');
              if (bufferedBytes + bytes > this.maxFrameBytes || buffer.length >= 1024) {
                if (streamId !== undefined) this.send({ type: 'stream_cancel', id: streamId });
                pending.error(new Error('IPC stream buffer limit exceeded'));
                return;
              }
              bufferedBytes += bytes;
              buffer.push({ result, bytes });
            }
          },
          end: () => {
            if (done) return;
            done = true;
            if (streamId !== undefined) this.streams.delete(streamId);
            const terminal: IteratorResult<unknown> = { done: true, value: undefined };
            const waiter = waiters.shift();
            if (waiter !== undefined) {
              waiter.resolve(terminal);
            } else {
              buffer.push({ result: terminal, bytes: 0 });
            }
            // Resolve remaining waiters with done
            for (const w of waiters) {
              w.resolve({ done: true, value: undefined });
            }
            waiters.length = 0;
          },
          error: (err: Error) => {
            if (done) return;
            done = true;
            if (streamId !== undefined) this.streams.delete(streamId);
            buffer.length = 0;
            bufferedBytes = 0;
            const waiter = waiters.shift();
            if (waiter !== undefined) {
              waiter.reject(err);
            } else {
              // Store as a throwing result
              buffer.push({ result: { done: true, value: err }, bytes: 0 });
            }
            for (const w of waiters) {
              w.reject(err);
            }
            waiters.length = 0;
          },
        };

        // Start the stream after the handshake is done.
        let started = false;
        const ensureStarted = (): void => {
          if (started) return;
          started = true;
          void this.ready.then(() => {
            if (done) return;
            if (this.closed) {
              pending.error(new Error('ipc closed'));
              return;
            }
            streamId = this.nextId();
            this.streams.set(streamId, pending);
            this.send({
              type: 'stream',
              id: streamId,
              scope: scopeKindOf(scope),
              service,
              method,
              arg: trimTrailingUndefined(args),
              workspaceId: scope.workspaceId,
              sessionId: scope.sessionId,
              agentId: scope.agentId,
            });
          }, (error: Error) => { pending.error(error); });
        };

        return {
          next(): Promise<IteratorResult<unknown>> {
            ensureStarted();
            const buffered = buffer.shift();
            if (buffered !== undefined) {
              // Check if this is an error stored as { done: true, value: Error }
              bufferedBytes -= buffered.bytes;
              if (buffered.result.done && buffered.result.value instanceof Error) {
                return Promise.reject(buffered.result.value);
              }
              return Promise.resolve(buffered.result);
            }
            if (done) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return: (): Promise<IteratorResult<unknown>> => {
            buffer.length = 0;
            bufferedBytes = 0;
            if (!done) {
              done = true;
              if (streamId !== undefined) {
                this.streams.delete(streamId);
                this.send({ type: 'stream_cancel', id: streamId });
              }
              // Resolve any pending waiters
              for (const w of waiters) {
                w.resolve({ done: true, value: undefined });
              }
              waiters.length = 0;
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable {
    const id = this.nextId();
    this.listens.set(id, { handler, onError });
    const base = {
      type: 'listen',
      id,
      scope: scopeKindOf(scope),
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
    };
    const frame: IpcFrame =
      source.kind === 'stream'
        ? { ...base, event: source.name }
        : { ...base, service: source.service, event: source.event };
    const failed = (error: unknown) => {
      const listener = this.listens.get(id);
      this.listens.delete(id);
      listener?.onError?.(error instanceof Error ? error : new Error(String(error)));
    };
    void this.ready.then(() => {
      if (!this.listens.has(id)) return;
      if (this.closed) { failed(new Error('ipc closed')); return; }
      this.send(frame);
    }, failed).catch(() => {});
    return {
      dispose: () => {
        if (!this.listens.delete(id)) return;
        void this.ready.then(() => {
          if (!this.closed) this.send({ type: 'unlisten', id });
        }).catch(() => {});
      },
    };
  }

  handshake(): Promise<unknown> {
    return this.ready;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.decoder.clear();
    const error = new Error('ipc closed');
    this.rejectReady(error);
    this.failAll(error);
    this.listens.clear();
    this.socket.destroy();
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------

  private nextId(): string {
    this.seq += 1;
    return `${this.idPrefix}_${this.seq}`;
  }

  private onFrame(frame: IpcFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : '';
    switch (frame.type) {
      case 'ready':
        return;
      case 'hello_result':
        clearTimeout(this.handshakeTimer);
        this.resolveReady(frame.data);
        return;
      case 'result': {
        const p = this.take(id);
        p?.resolve(frame.data);
        return;
      }
      case 'error': {
        const error = new RPCError(
          typeof frame.code === 'number' ? frame.code : 50001,
          frame.msg ?? 'error',
        );
        if (id === 'hello') {
          this.terminate(error);
          return;
        }
        const p = this.take(id);
        if (p !== undefined) {
          p.reject(error);
          return;
        }
        const sub = this.listens.get(id);
        if (sub !== undefined) {
          this.listens.delete(id);
          sub.onError?.(error);
        }
        return;
      }
      case 'listen_result':
        return;
      case 'event': {
        this.listens.get(id)?.handler(frame.data);
        return;
      }
      case 'stream_data': {
        this.streams.get(id)?.push(frame.data);
        return;
      }
      case 'stream_end': {
        this.streams.get(id)?.end();
        return;
      }
      case 'stream_error': {
        const s = this.streams.get(id);
        if (s !== undefined) {
          s.error(
            new RPCError(
              typeof frame.code === 'number' ? frame.code : 50001,
              frame.msg ?? 'stream error',
            ),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private take(id: string): PendingCall | undefined {
    const p = this.pending.get(id);
    if (p !== undefined) {
      this.pending.delete(id);
      if (p.timer !== undefined) clearTimeout(p.timer);
    }
    return p;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      if (p.timer !== undefined) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const s of this.streams.values()) {
      s.error(err);
    }
    this.streams.clear();
  }

  private send(frame: IpcFrame): void {
    if (this.closed || this.socket.destroyed) return;
    try {
      const encoded = encodeFrame(frame, this.maxFrameBytes);
      if (this.socket.writableLength + Buffer.byteLength(encoded) > 2 * this.maxFrameBytes) {
        throw new Error('IPC write buffer limit exceeded');
      }
      this.socket.write(encoded);
    } catch (error) {
      if (error instanceof RPCError && error.code === PAYLOAD_TOO_LARGE && frame.id) {
        this.take(frame.id)?.reject(error);
        this.streams.get(frame.id)?.error(error);
        return;
      }
      this.terminate(error instanceof Error ? error : new Error('IPC write failed'));
    }
  }

  private terminate(error: Error): void {
    clearTimeout(this.handshakeTimer);
    this.rejectReady(error);
    this.failAll(error);
    this.socket.destroy();
  }
}
