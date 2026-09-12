/**
 * IPC wire framing — newline-delimited JSON over a `node:net` stream. One
 * socket multiplexes RPC `call`s and event `listen`s: `hello`/`call`/
 * `listen`/`unlisten` go out, `ready`/`result`/`error`/`listen_result`/
 * `event` come back.
 */

/** One NDJSON message. `type` discriminates; other fields depend on it. */
import { stringifyWire } from '../json.js';

export interface IpcFrame {
  readonly type: string;
  readonly id?: string;
  readonly scope?: string;
  readonly service?: string;
  readonly method?: string;
  readonly arg?: unknown;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly event?: string;
  readonly token?: string;
  readonly code?: number;
  readonly msg?: string;
  readonly data?: unknown;
}

export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_HELLO_BYTES = 16 * 1024;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1) {
    throw new RangeError('IPC limit must be a positive integer below 2^31');
  }
  return value;
}

export function encodeFrame(frame: IpcFrame, maxBytes = DEFAULT_MAX_FRAME_BYTES): string {
  return `${stringifyWire(frame, maxBytes)}\n`;
}

function parseFrame(bytes: Buffer): IpcFrame {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid IPC frame');
  }
  const frame = parsed as Record<string, unknown>;
  for (const field of ['type', 'id', 'scope', 'service', 'method', 'workspaceId', 'sessionId', 'agentId', 'event', 'token', 'msg']) {
    if (frame[field] !== undefined && typeof frame[field] !== 'string') throw new Error('Invalid IPC frame field');
  }
  if (frame['code'] !== undefined && !Number.isSafeInteger(frame['code'])) throw new Error('Invalid IPC error code');
  const required = (...fields: string[]) => {
    if (fields.some((field) => typeof frame[field] !== 'string' || frame[field] === '')) throw new Error('Missing IPC frame field');
  };
  switch (frame['type']) {
    case 'hello': case 'ready': case 'hello_result': break;
    case 'call': case 'stream': required('id', 'service', 'method'); break;
    case 'listen': required('id', 'event'); break;
    case 'result': case 'error': case 'listen_result': case 'unlisten': case 'event':
    case 'stream_data': case 'stream_end': case 'stream_error': case 'stream_cancel': required('id'); break;
    default: throw new Error('Unknown IPC frame type');
  }
  return parsed as IpcFrame;
}

/** Buffer complete NDJSON lines before decoding UTF-8; bound partial frames too. */
export class NdjsonDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private bytes = 0;
  private maxBytes: number;

  constructor(maxBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.maxBytes = positiveLimit(maxBytes);
  }

  setMaxBytes(maxBytes: number): void {
    this.maxBytes = positiveLimit(maxBytes);
  }

  *push(chunk: Buffer): Iterable<IpcFrame> {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, end === -1 ? chunk.length : end);
      if (this.bytes + part.length > this.maxBytes) {
        this.clear();
        throw new Error('IPC frame exceeds byte limit');
      }
      if (this.bytes === 0 && end !== -1) {
        offset = end + 1;
        if (part.length > 0) yield parseFrame(part);
        continue;
      }
      if (part.length > 0) {
        if (this.bytes + part.length > this.buffer.length) {
          const size = Math.min(this.maxBytes, Math.max(4096, this.buffer.length * 2, this.bytes + part.length));
          const next = Buffer.allocUnsafe(size);
          this.buffer.copy(next, 0, 0, this.bytes);
          this.buffer = next;
        }
        part.copy(this.buffer, this.bytes);
        this.bytes += part.length;
      }
      if (end === -1) return;
      offset = end + 1;
      const bytes = this.buffer.subarray(0, this.bytes);
      this.clear();
      if (bytes.length > 0) yield parseFrame(bytes);
    }
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
  }
}
