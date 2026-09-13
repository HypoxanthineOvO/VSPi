import type { Protocol } from '#/kosong/protocol/protocol';

type ResponseFormat = 'openai' | 'openai_responses' | 'anthropic' | 'html' | 'non_streaming_json';
const SAMPLE_BYTES = 64 * 1024;
const TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class ResponseDiagnostics {
  private readonly started = Date.now();
  private readonly decoder = new TextDecoder();
  private buffer = '';
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
    const size = Math.min(chunk.byteLength, SAMPLE_BYTES - this.sampledBytes);
    if (size <= 0) return;
    this.sampledBytes += size;
    this.buffer += this.decoder.decode(chunk.subarray(0, size), { stream: true });
    if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(this.buffer)) this.format = 'html';
    if (this.mediaType === 'application/json') return;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (line.startsWith('data:')) this.inspect(line.slice(5).trim(), true);
    }
  }

  end(): void {
    if (this.mediaType === 'application/json') this.inspect(this.buffer, false);
    else if (this.buffer.startsWith('data:')) this.inspect(this.buffer.slice(5).trim(), true);
    this.buffer = '';
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
    };
  }

  private inspect(text: string, streaming: boolean): void {
    if (text.length === 0 || text === '[DONE]') return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return; }
    const record = object(value);
    if (!record) return;
    if (!streaming) {
      this.format = 'non_streaming_json';
      return;
    }
    const type = record['type'];
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
