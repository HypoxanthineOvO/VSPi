import { RPCError } from '../core/errors.js';

export const MAX_WIRE_BYTES = 64 * 1024 * 1024;
export const PAYLOAD_TOO_LARGE = 41301;

export function measureWire(value: unknown, maxBytes = MAX_WIRE_BYTES): number {
  let remaining = maxBytes;
  const ancestors = new Set<object>();
  const consume = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw new RPCError(PAYLOAD_TOO_LARGE, 'IPC frame exceeds byte limit; request a smaller page');
  };
  const string = (text: string) => {
    consume(text.length + 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) consume(1);
      else if (c < 32) consume(5);
      else if (c < 128) continue;
      else if (c < 2048) consume(1);
      else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { consume(2); i++; }
      else consume(c >= 0xd800 && c <= 0xdfff ? 5 : 2);
    }
  };
  const visit = (input: unknown, depth: number, key: string): void => {
    if (depth > 256) throw new RPCError(PAYLOAD_TOO_LARGE, 'IPC value exceeds nesting limit');
    if (input !== null && typeof input === 'object' && 'toJSON' in input && typeof input.toJSON === 'function') input = input.toJSON(key);
    if (typeof input === 'string') { string(input); return; }
    if (input === null || typeof input !== 'object') { consume(JSON.stringify(input)?.length ?? 4); return; }
    if (ancestors.has(input)) throw new TypeError('Circular IPC value');
    ancestors.add(input);
    consume(2);
    if (Array.isArray(input)) {
      consume(Math.max(0, input.length - 1));
      for (let index = 0; index < input.length; index++) visit(input[index], depth + 1, String(index));
    } else {
      let first = true;
      for (const name of Object.keys(input)) {
        const member = (input as Record<string, unknown>)[name];
        if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue;
        string(name); consume(first ? 1 : 2); first = false; visit(member, depth + 1, name);
      }
    }
    ancestors.delete(input);
  };
  visit(value, 0, '');
  return maxBytes - remaining;
}

export function stringifyWire(value: unknown, maxBytes = MAX_WIRE_BYTES): string {
  measureWire(value, maxBytes);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('IPC value is not JSON serializable');
  if (Buffer.byteLength(encoded) > maxBytes) throw new RPCError(PAYLOAD_TOO_LARGE, 'IPC frame exceeds byte limit');
  return encoded;
}
