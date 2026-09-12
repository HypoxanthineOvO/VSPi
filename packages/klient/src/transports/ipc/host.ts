/**
 * IPC host — serves one engine scope over a unix domain socket. Incoming
 * frames are bridged to the shared in-process dispatcher (the same code the
 * memory transport uses), so ipc and in-memory behavior are identical by
 * construction; only serialization separates them.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';

import type { EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import { PAYLOAD_TOO_LARGE, measureWire } from '../json.js';
import { createMemoryDispatcher, type ScopeLike } from '../memory/dispatcher.js';
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_MAX_FRAME_BYTES, MAX_HELLO_BYTES, encodeFrame, NdjsonDecoder, positiveLimit, type IpcFrame } from './codec.js';

const REQUEST_INVALID = 40001;
const UNAUTHORIZED = 40100;

export interface ServeKlientIpcOptions {
  /** A bootstrapped engine app scope (same value `createKlient({ scope })` takes). */
  readonly scope: ScopeLike;
  /** Unix socket path to listen on. A stale file at the path is removed first. */
  readonly socketPath: string;
  /** Optional token; when set, the client's `hello` must carry the same token. */
  readonly token?: string;
  /** Optional host metadata returned only after a successful authenticated hello. */
  readonly handshakeData?: unknown;
  readonly handshakeTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxConcurrentCalls?: number;
  readonly maxTotalCalls?: number;
  readonly control?: (method: string, args: readonly unknown[], peers: number, calls: number) => { data: unknown; afterReply?: () => Promise<void> };
}

export interface KlientIpcHost {
  readonly socketPath: string;
  close(): Promise<void>;
}

function scopeRefFromFrame(frame: IpcFrame): ScopeRef {
  const scope: { workspaceId?: string; sessionId?: string; agentId?: string } = {};
  if (typeof frame.workspaceId === 'string') scope.workspaceId = frame.workspaceId;
  if (typeof frame.sessionId === 'string') scope.sessionId = frame.sessionId;
  if (typeof frame.agentId === 'string') scope.agentId = frame.agentId;
  return scope;
}

function eventSourceFromFrame(frame: IpcFrame): EventSourceRef {
  if (typeof frame.service === 'string' && typeof frame.event === 'string') {
    return { kind: 'emitter', service: frame.service, event: frame.event };
  }
  if (typeof frame.event === 'string' && frame.event.length > 0) {
    return { kind: 'stream', name: frame.event };
  }
  throw new RPCError(REQUEST_INVALID, `unknown event stream: ${String(frame.event)}`);
}

export async function serveKlientIpc(options: ServeKlientIpcOptions): Promise<KlientIpcHost> {
  const dispatcher = createMemoryDispatcher(options.scope);
  const maxFrameBytes = positiveLimit(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
  const handshakeTimeoutMs = positiveLimit(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  const maxConcurrentCalls = positiveLimit(options.maxConcurrentCalls ?? 32);
  const maxTotalCalls = positiveLimit(options.maxTotalCalls ?? 128);
  let totalCalls = 0;
  let totalCallBytes = 0;
  let totalQueuedBytes = 0;
  let totalStreams = 0;
  let draining = false;

  // Best-effort cleanup of a stale socket file; ignore everything but a real
  // leftover (ENOENT = nothing to remove). Windows named pipes are not
  // filesystem objects, so there is never a stale file to remove there.
  if (!options.socketPath.startsWith('\\\\.\\pipe\\')) {
    try {
      await unlink(options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const connections = new Set<Socket>();

  const server: Server = createServer((socket) => {
    if (draining || connections.size >= 128) { socket.destroy(); return; }
    connections.add(socket);
    let pendingCalls = 0;
    let pendingBytes = 0;
    const decoder = new NdjsonDecoder(Math.min(MAX_HELLO_BYTES, maxFrameBytes));
    const listens = new Map<string, IDisposable>();
    const activeStreams = new Map<string, () => void>();
    let helloDone = false;
    const helloTimer = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
    helloTimer.unref();

    const send = (frame: IpcFrame): void => {
      if (socket.destroyed) return;
      try {
        const encoded = encodeFrame(frame, maxFrameBytes);
        const bytes = Buffer.byteLength(encoded);
        if (socket.writableLength + bytes > 2 * maxFrameBytes || totalQueuedBytes + bytes > 2 * maxFrameBytes) {
          socket.destroy();
          return;
        }
        totalQueuedBytes += bytes;
        socket.write(encoded, () => { totalQueuedBytes -= bytes; });
      } catch (error) {
        if (error instanceof RPCError && error.code === PAYLOAD_TOO_LARGE && frame.id && frame.type !== 'error' && frame.type !== 'stream_error') {
          send({ type: frame.type === 'stream_data' ? 'stream_error' : 'error', id: frame.id, code: PAYLOAD_TOO_LARGE, msg: error.message });
        } else socket.destroy();
      }
    };
    const sendError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({ type: 'error', id, code: error.code, msg: error.message });
      } else {
        send({
          type: 'error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const sendStreamError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({ type: 'stream_error', id, code: error.code, msg: error.message });
      } else {
        send({
          type: 'stream_error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const handleFrame = (frame: IpcFrame): void => {
      const id = typeof frame.id === 'string' ? frame.id : '';
      if (!helloDone && frame.type !== 'hello') {
        socket.destroy();
        return;
      }
      switch (frame.type) {
        case 'hello': {
          if (helloDone) { socket.destroy(); return; }
          if (options.token !== undefined && frame.token !== options.token) {
            send({ type: 'error', id: 'hello', code: UNAUTHORIZED, msg: 'unauthorized' });
            socket.end();
            return;
          }
          helloDone = true;
          clearTimeout(helloTimer);
          decoder.setMaxBytes(maxFrameBytes);
          send({ type: 'hello_result', id: 'hello', data: options.handshakeData });
          return;
        }
        case 'call': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          if (draining) { sendError(id, new RPCError(50301, 'Runtime is shutting down')); return; }
          if (frame.service === 'runtimeControl' && options.control) {
            try {
              const { data, afterReply } = options.control(String(frame.method), args, connections.size, totalCalls);
              if (!afterReply) { send({ type: 'result', id, data }); return; }
              draining = true;
              socket.write(encodeFrame({ type: 'result', id, data }, maxFrameBytes), () => {
                void afterReply().catch(() => { socket.destroy(); });
              });
            } catch (error) { sendError(id, error); }
            return;
          }
          const callBytes = measureWire(frame, maxFrameBytes);
          if (pendingCalls >= maxConcurrentCalls || totalCalls >= maxTotalCalls || pendingBytes + callBytes > maxFrameBytes || totalCallBytes + callBytes > 2 * maxFrameBytes) {
            sendError(id, new RPCError(42901, 'IPC request capacity reached; wait for pending operations'));
            return;
          }
          pendingCalls++;
          totalCalls++;
          pendingBytes += callBytes;
          totalCallBytes += callBytes;
          dispatcher
            .call(scopeRefFromFrame(frame), String(frame.service), String(frame.method), args)
            .then((data) => {
              send({ type: 'result', id, data });
            })
            .catch((error: unknown) => {
              sendError(id, error);
            }).finally(() => { pendingCalls--; totalCalls--; pendingBytes -= callBytes; totalCallBytes -= callBytes; });
          return;
        }
        case 'listen': {
          if (draining) { sendError(id, new RPCError(50301, 'Runtime is shutting down')); return; }
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          try {
            const source = eventSourceFromFrame(frame);
            listens.get(id)?.dispose();
            listens.delete(id);
            if (listens.size >= 256) { socket.destroy(); return; }
            const sub = dispatcher.listen(
              scopeRefFromFrame(frame),
              source,
              (data) => {
                send({ type: 'event', id, data });
              },
              (error) => {
                sendError(id, error);
              },
            );
            listens.set(id, sub);
            send({ type: 'listen_result', id });
          } catch (error) {
            sendError(id, error);
          }
          return;
        }
        case 'unlisten': {
          listens.get(id)?.dispose();
          listens.delete(id);
          return;
        }
        case 'stream': {
          if (draining) { sendStreamError(id, new RPCError(50301, 'Runtime is shutting down')); return; }
          if (!helloDone) {
            sendStreamError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          if (activeStreams.has(id) || activeStreams.size >= 64 || totalStreams >= 128) { sendStreamError(id, new RPCError(42901, 'IPC stream capacity reached')); return; }
          const streamBytes = measureWire(frame, maxFrameBytes);
          if (pendingBytes + streamBytes > maxFrameBytes || totalCallBytes + streamBytes > 2 * maxFrameBytes) { sendStreamError(id, new RPCError(42901, 'IPC argument capacity reached')); return; }
          pendingBytes += streamBytes;
          totalCallBytes += streamBytes;
          totalStreams++;
          const iterable = dispatcher.stream(
            scopeRefFromFrame(frame),
            String(frame.service),
            String(frame.method),
            args,
          );
          const iterator = iterable[Symbol.asyncIterator]();
          let cancelled = false;
          const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            void iterator.return?.().catch(() => {});
          };
          activeStreams.set(id, cancel);
          void (async () => {
            try {
              for (;;) {
                if (cancelled || socket.destroyed) break;
                const chunk = await iterator.next();
                if (cancelled || socket.destroyed || chunk.done) break;
                send({ type: 'stream_data', id, data: chunk.value });
              }
              if (!cancelled && !socket.destroyed) {
                send({ type: 'stream_end', id });
              }
            } catch (error) {
              if (!cancelled && !socket.destroyed) {
                sendStreamError(id, error);
              }
            } finally {
              totalStreams--;
              pendingBytes -= streamBytes;
              totalCallBytes -= streamBytes;
              cancel();
              if (activeStreams.get(id) === cancel) activeStreams.delete(id);
            }
          })();
          return;
        }
        case 'stream_cancel': {
          activeStreams.get(id)?.();
          return;
        }
        default:
          socket.destroy();
      }
    };

    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (socket.destroyed) break;
          handleFrame(frame);
        }
      } catch {
        socket.destroy();
      }
    });
    const teardown = (): void => {
      clearTimeout(helloTimer);
      decoder.clear();
      for (const sub of listens.values()) sub.dispose();
      listens.clear();
      for (const cancel of activeStreams.values()) cancel();
      activeStreams.clear();
      connections.delete(socket);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    send({ type: 'ready' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, resolve);
  });
  if (!options.socketPath.startsWith('\\\\.\\pipe\\')) {
    try {
      await chmod(options.socketPath, 0o600);
    } catch (error) {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await unlink(options.socketPath).catch(() => {});
      throw error;
    }
  }

  return {
    socketPath: options.socketPath,
    close: () => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      return new Promise<void>((resolve) => {
        server.close(() => {
          if (options.socketPath.startsWith('\\\\.\\pipe\\')) {
            resolve();
            return;
          }
          void unlink(options.socketPath).then(
            () => {
              resolve();
            },
            () => {
              resolve();
            },
          );
        });
      });
    },
  };
}
