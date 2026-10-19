import { gunzipSync, gzipSync } from 'node:zlib';
import { APIIncompleteStreamError, APIProtocolError, APIStatusError, parseRetryAfterMs } from '#/llm-adapter/contract/errors';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
type Value = number | Buffer;
export type Proto = Map<number, Value[]>;

function varint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new APIProtocolError('Invalid Devin protobuf integer.');
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value > 0 ? 128 : 0)); } while (value > 0);
  return Buffer.from(bytes);
}

export function field(no: number, value: string | number | boolean | Uint8Array | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  if (typeof value === 'number' || typeof value === 'boolean') return Buffer.concat([varint(no * 8), varint(Number(value))]);
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([varint(no * 8 + 2), varint(bytes.length), bytes]);
}

export function double(no: number, value: number): Buffer {
  const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value);
  return Buffer.concat([varint(no * 8 + 1), bytes]);
}

export function message(...fields: Uint8Array[]): Buffer { return Buffer.concat(fields); }

export function decode(bytes: Uint8Array): Proto {
  const data = Buffer.from(bytes);
  const result: Proto = new Map();
  let offset = 0;
  const read = () => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (offset >= data.length) throw new APIProtocolError('Truncated Devin protobuf varint.');
      const byte = data[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new APIProtocolError('Invalid Devin protobuf varint.');
  };
  while (offset < data.length) {
    const tag = read();
    const no = Math.floor(tag / 8);
    if (no === 0) throw new APIProtocolError('Invalid Devin protobuf field.');
    let value: Value;
    switch (tag % 8) {
      case 0: value = read(); break;
      case 1:
        if (offset + 8 > data.length) throw new APIProtocolError('Truncated Devin protobuf double.');
        value = data.readDoubleLE(offset); offset += 8; break;
      case 2: {
        const length = read();
        if (!Number.isSafeInteger(length) || length > data.length - offset) throw new APIProtocolError('Truncated Devin protobuf bytes.');
        value = data.subarray(offset, offset + length); offset += length; break;
      }
      case 5:
        if (offset + 4 > data.length) throw new APIProtocolError('Truncated Devin protobuf float.');
        value = data.readFloatLE(offset); offset += 4; break;
      default: throw new APIProtocolError('Unsupported Devin protobuf wire type.');
    }
    const values = result.get(no) ?? []; values.push(value); result.set(no, values);
  }
  return result;
}

export function text(proto: Proto, no: number): string {
  const value = proto.get(no)?.[0]; return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}
export function number(proto: Proto, no: number): number {
  const value = proto.get(no)?.[0]; return typeof value === 'number' ? value : 0;
}
export function children(proto: Proto, no: number): Proto[] {
  return (proto.get(no) ?? []).filter((v): v is Buffer => Buffer.isBuffer(v)).map(decode);
}
export function child(proto: Proto, no: number): Proto { return children(proto, no)[0] ?? new Map(); }

export function connectFrame(payload: Uint8Array, flags = 0): Buffer {
  const body = flags & 1 ? gzipSync(payload) : Buffer.from(payload);
  const header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export class ConnectDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Uint8Array): { flags: number; payload: Buffer }[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: { flags: number; payload: Buffer }[] = [];
    while (this.pending.length >= 5) {
      const flags = this.pending[0]!;
      const size = this.pending.readUInt32BE(1);
      if ((flags & ~3) !== 0 || size > MAX_FRAME_BYTES) throw new APIProtocolError('Invalid or oversized Devin Connect frame.');
      if (this.pending.length < size + 5) break;
      const bytes = this.pending.subarray(5, size + 5);
      frames.push({ flags, payload: flags & 1 ? gunzipSync(bytes, { maxOutputLength: MAX_FRAME_BYTES }) : bytes });
      this.pending = this.pending.subarray(size + 5);
    }
    return frames;
  }
  finish(): void { if (this.pending.length > 0) throw new APIIncompleteStreamError('Devin returned a truncated Connect frame.'); }
}

export function checkTrailer(payload: Uint8Array, headers: Headers = new Headers()): void {
  let trailer: { error?: { code?: string; message?: string }; metadata?: Record<string, string[]> };
  try { trailer = JSON.parse(Buffer.from(payload).toString('utf8')); }
  catch { throw new APIProtocolError('Invalid Devin Connect end-stream trailer.'); }
  if (!trailer || typeof trailer !== 'object') throw new APIProtocolError('Invalid Devin Connect trailer.');
  if (!trailer.error) return;
  const code = trailer.error.code;
  const status = code === 'unauthenticated' ? 401 : code === 'permission_denied' ? 403 : code === 'resource_exhausted' ? 429 : code === 'unavailable' ? 503 : 400;
  const metadata = new Headers(headers);
  for (const [key, values] of Object.entries(trailer.metadata ?? {})) if (Array.isArray(values)) metadata.set(key, values.join(','));
  throw new APIStatusError(status, `Devin ${code ?? 'stream error'}: ${trailer.error.message ?? 'Request failed.'}`, undefined, retryDelay(metadata));
}

export function retryDelay(headers: Headers): number | null {
  const retry = parseRetryAfterMs(headers);
  if (retry !== null) return retry;
  for (const name of ['x-ratelimit-reset', 'x-rate-limit-reset']) {
    const value = headers.get(name);
    if (value) {
      const timestamp = Number(value);
      const delay = Number.isFinite(timestamp) ? (timestamp > 1e12 ? timestamp : timestamp * 1000) - Date.now() : Date.parse(value) - Date.now();
      if (Number.isFinite(delay)) return Math.max(0, delay);
    }
  }
  return null;
}

export function decodeUnary(bytes: Uint8Array): Proto {
  if (bytes.length >= 5 && bytes[0]! <= 3 && Buffer.from(bytes).readUInt32BE(1) === bytes.length - 5) {
    const decoder = new ConnectDecoder();
    const frames = decoder.push(bytes); decoder.finish();
    const frame = frames[0]!;
    if (frame.flags & 2) { checkTrailer(frame.payload); return new Map(); }
    return decode(frame.payload);
  }
  return decode(bytes);
}
