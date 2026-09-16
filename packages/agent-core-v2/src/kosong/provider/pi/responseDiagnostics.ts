import type { Protocol } from '#/kosong/protocol/protocol';
import { APIProtocolError, APIStreamParseError } from '#/kosong/contract/errors';
import { providerErrorDetail, type ProviderErrorDetail } from './providerErrors';

type ResponseFormat = 'openai' | 'openai_responses' | 'anthropic' | 'html' | 'non_streaming_json';
const SAMPLE_BYTES = 64 * 1024;
const EVENT_BYTES = 4 * 1024 * 1024;
const TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class ResponseDiagnostics {
  error: ProviderErrorDetail | undefined;
  private readonly started = Date.now();
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private line = '';
  private lineBytes = 0;
  private eventData: string[] = [];
  private eventBytes = 0;
  private eventType = 'message';
  private eventIndex = 0;
  private skipLf = false;
  private failureType: 'invalid_json' | 'event_too_large' | undefined;
  private parseOffset: number | undefined;
  private prefix = '';
  private done = false;
  private ended = false;
  private terminal = false;
  private sampledBytes = 0;
  private bytesReceived = 0;
  private firstByteMs: number | undefined;
  private lastByteMs: number | undefined;
  private format: ResponseFormat | undefined;
  private mediaType: string | undefined;
  private transportCode: string | undefined;
  private status: number | undefined;
  private requestId: string | undefined;
  private traceId: string | undefined;

  constructor(readonly expectedProtocol: Protocol) {}

  headers(response: Response): void {
    this.status = response.status;
    const identifier = (value: string | null): string | undefined => value !== null && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : undefined;
    this.requestId = identifier(response.headers.get('x-request-id') ?? response.headers.get('request-id'));
    this.traceId = identifier(response.headers.get('x-trace-id'));
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    this.mediaType = ['text/event-stream', 'application/json', 'text/html', 'text/plain'].includes(type ?? '') ? type : 'other';
  }

  receive(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.bytesReceived = Math.min(Number.MAX_SAFE_INTEGER, this.bytesReceived + chunk.byteLength);
    const elapsed = Math.max(0, Date.now() - this.started);
    this.firstByteMs ??= elapsed;
    this.lastByteMs = elapsed;
    const sampleSize = Math.min(chunk.byteLength, SAMPLE_BYTES - this.sampledBytes);
    this.sampledBytes += sampleSize;
    if (this.mediaType === 'application/json') {
      if (sampleSize > 0) this.buffer += this.decoder.decode(chunk.subarray(0, sampleSize), { stream: true });
      return;
    }
    for (let offset = 0; offset < chunk.length; offset += SAMPLE_BYTES) {
      const text = this.decoder.decode(chunk.subarray(offset, offset + SAMPLE_BYTES), { stream: true });
      if (this.prefix.length < 128) this.prefix += text.slice(0, 128 - this.prefix.length);
      if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(this.prefix)) { this.format = 'html'; return; }
      if (this.status === undefined || this.status < 200 || this.status >= 300 || !['openai', 'openai_responses', 'anthropic'].includes(this.expectedProtocol)) continue;
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (this.skipLf) {
          this.skipLf = false;
          if (char === '\n') { start = i + 1; continue; }
        }
        if (char !== '\r' && char !== '\n') continue;
        this.appendLine(text.slice(start, i));
        this.processLine();
        this.skipLf = char === '\r';
        start = i + 1;
      }
      this.appendLine(text.slice(start));
    }
  }

  end(): void {
    this.ended = true;
    if (this.mediaType === 'application/json') this.inspect(this.buffer, false);
    this.buffer = '';
    this.line = '';
    this.lineBytes = 0;
    this.eventData = [];
  }

  private appendLine(text: string): void {
    if (this.done) return;
    this.lineBytes += Buffer.byteLength(text);
    if (this.lineBytes + this.eventBytes > EVENT_BYTES) {
      this.failureType = 'event_too_large';
      this.line = '';
      this.eventData = [];
      throw new APIProtocolError('Provider SSE event exceeds the supported byte limit.', this.snapshot());
    }
    this.line += text;
  }

  private processLine(): void {
    if (this.done) return;
    const line = this.line;
    this.eventBytes += this.lineBytes + 1;
    this.line = '';
    this.lineBytes = 0;
    if (line.length === 0) {
      if (this.eventData.length > 0) {
        this.eventIndex = Math.min(Number.MAX_SAFE_INTEGER, this.eventIndex + 1);
        const data = this.eventData.join('\n');
        this.eventData = [];
        if (data.trim() === '[DONE]') this.done = true;
        else {
          let parsed: unknown;
          try { parsed = JSON.parse(data); }
          catch (error) {
            this.failureType = 'invalid_json';
            const offset = /position (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
            this.parseOffset = offset === undefined ? undefined : Number(offset);
            throw new APIStreamParseError(this.snapshot());
          }
          this.classify(parsed, true);
        }
      }
      this.eventBytes = 0;
      this.eventType = 'message';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.eventData.push(value);
    else if (field === 'event') this.eventType = /^(?:message(?:_start|_delta|_stop)?|content_block_(?:start|delta|stop)|response\.(?:created|in_progress|output_text\.delta|output_item\.added|completed|failed|incomplete)|ping|error)$/u.test(value) ? value : 'other';
  }

  get parseFailure(): 'invalid_json' | 'event_too_large' | undefined { return this.failureType; }

  get incomplete(): boolean {
    return this.ended && !this.terminal && this.error === undefined && this.mediaType === 'text/event-stream' &&
      this.status !== undefined && this.status >= 200 && this.status < 300 &&
      ['openai', 'openai_responses', 'anthropic'].includes(this.expectedProtocol);
  }

  failure(error: unknown): void {
    let value = error;
    for (let depth = 0; depth < 5; depth++) {
      const record = object(value);
      if (!record) break;
      const code = record['code'];
      if (typeof code === 'string' && TRANSPORT_CODES.has(code)) {
        this.transportCode = code;
        return;
      }
      value = record['cause'];
    }
  }

  get mismatch(): ResponseFormat | undefined {
    if (this.status === undefined || this.status < 200 || this.status >= 300) return undefined;
    return this.format !== this.expectedProtocol ? this.format : undefined;
  }

  get transportFailure(): string | undefined { return this.transportCode; }

  snapshot(): Readonly<Record<string, unknown>> {
    return {
      expectedProtocol: this.expectedProtocol,
      observedFormat: this.format,
      contentType: this.mediaType,
      statusCode: this.status,
      requestId: this.requestId,
      traceId: this.traceId,
      bytesReceived: this.bytesReceived,
      sampledBytes: this.sampledBytes,
      sampleLimitBytes: SAMPLE_BYTES,
      firstByteMs: this.firstByteMs,
      lastByteMs: this.lastByteMs,
      transportCode: this.transportCode,
      parseStage: this.failureType === undefined ? undefined : 'sse_event',
      parseFailure: this.failureType,
      parseOffset: this.parseOffset,
      eventIndex: this.eventIndex,
      eventType: this.eventType,
      eventBytes: this.eventBytes + this.lineBytes,
      eventLimitBytes: EVENT_BYTES,
    };
  }

  private inspect(text: string, streaming: boolean): void {
    if (text.length === 0 || text === '[DONE]') return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return; }
    this.classify(value, streaming);
  }

  private classify(value: unknown, streaming: boolean): void {
    const record = object(value);
    if (!record) return;
    const error = record['error'] ?? object(record['response'])?.['error'] ?? record['base_resp'] ?? (record['type'] === 'error' ? record : undefined);
    if (error !== undefined) this.error = providerErrorDetail(error) ?? { message: 'Provider returned an unrecognized error envelope.' };
    if (!streaming) {
      this.format = 'non_streaming_json';
      return;
    }
    const type = record['type'];
    if (type === 'message_stop' || type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed' ||
      (Array.isArray(record['choices']) && record['choices'].some(choice => {
        const reason = object(choice)?.['finish_reason'];
        return typeof reason === 'string' && reason.length > 0;
      })))
      this.terminal = true;
    if (typeof type === 'string' && ['response.created', 'response.in_progress', 'response.output_text.delta', 'response.output_item.added', 'response.completed', 'response.failed', 'response.incomplete'].includes(type)) {
      this.format = 'openai_responses';
    } else if (typeof type === 'string' && ['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop'].includes(type)) {
      this.format = 'anthropic';
    } else if (Array.isArray(record['choices']) && record['choices'].some(choice => {
      const item = object(choice);
      return item !== undefined && ('delta' in item || 'finish_reason' in item);
    })) {
      this.format = 'openai';
    }
  }
}
