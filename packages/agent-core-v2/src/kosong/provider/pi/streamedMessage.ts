import { isDeepStrictEqual } from 'node:util';

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolCall as PiToolCall,
} from '@earendil-works/pi-ai';

import {
  APIConnectionError,
  APIEmptyResponseError,
  ChatProviderError,
  classifyBaseApiError,
  createAbortError,
  isAbortError,
  normalizeAPIStatusError,
  ImageFormatProviderError,
  isImageFormatMessage,
} from '#/kosong/contract/errors';
import type { StreamedMessagePart } from '#/kosong/contract/message';
import type { FinishReason, StreamedMessage } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';

import { encodePiSignature } from './messages';

export interface PiResponseState {
  status?: number;
  headers?: Record<string, string>;
}

function structuredErrorStatus(message: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const error = (parsed as Record<string, unknown>)['error'];
    if (typeof error !== 'object' || error === null) return undefined;
    const code = (error as Record<string, unknown>)['code'];
    if (typeof code === 'number' && code >= 400 && code <= 599) return code;
    const status = (error as Record<string, unknown>)['status'];
    const statuses: Record<string, number> = { INVALID_ARGUMENT: 400, UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404, RESOURCE_EXHAUSTED: 429, INTERNAL: 500, UNAVAILABLE: 503 };
    if (typeof status === 'string' && Object.hasOwn(statuses, status)) return statuses[status];
    return (error as Record<string, unknown>)['type'] === 'invalid_request_error' ? 400 : undefined;
  } catch {
    return undefined;
  }
}

export function convertPiError(error: unknown, response: PiResponseState = {}): Error {
  if (isAbortError(error)) return createAbortError();
  if (error instanceof ChatProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/^Provider finish_reason: content_filter$/.test(message))
    return new APIEmptyResponseError(message, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const directStatus = record?.['status'] ?? record?.['statusCode'];
  const status =
    typeof directStatus === 'number'
      ? directStatus
      : response.status !== undefined && response.status >= 400
        ? response.status
        : (structuredErrorStatus(message) ??
          (Number(/^(?:Error:\s*)?(\d{3})(?:\s|:|$)/.exec(message)?.[1]) || undefined));
  if (status !== undefined) {
    const headers = new Headers(response.headers);
    const retryAfter = headers.get('retry-after');
    const retrySeconds = retryAfter === null ? NaN : Number(retryAfter);
    return normalizeAPIStatusError(
      status,
      message,
      headers.get('x-request-id') ?? headers.get('request-id'),
      Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds * 1000) : undefined,
      headers.get('x-trace-id'),
    );
  }
  try {
    const payload: unknown = JSON.parse(message);
    if (typeof payload === 'object' && payload !== null) {
      const detail = (payload as Record<string, unknown>)['error'];
      const text = typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>)['message'] : undefined;
      if (typeof text === 'string' && isImageFormatMessage(text)) return new ImageFormatProviderError(text);
    }
  } catch {}
  return classifyBaseApiError(message);
}

interface ToolState {
  arguments: string;
  extras: Record<string, unknown>;
}

export class PiStreamedMessage implements StreamedMessage {
  id: string | null = null;
  usage: TokenUsage | null = null;
  finishReason: FinishReason | null = null;
  rawFinishReason: string | null = null;
  private readonly toolStates = new Map<number, ToolState>();
  private readonly textLengths = new Map<number, number>();
  private readonly thinkingLengths = new Map<number, number>();
  private readonly endedBlocks = new Set<number>();
  private readonly iterator: AsyncGenerator<StreamedMessagePart>;

  constructor(
    private readonly source: AssistantMessageEventStream,
    private readonly controller: AbortController,
    private readonly signal: AbortSignal,
    private readonly response: PiResponseState,
    private readonly convertError: (error: Error) => Error = (error) => error,
  ) {
    this.iterator = this.iterate();
  }

  get traceId(): string | null {
    return new Headers(this.response.headers).get('x-trace-id');
  }

  cancel(): void {
    this.controller.abort();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    return this.iterator;
  }

  private update(message: AssistantMessage): void {
    this.id = message.responseId ?? this.id;
    this.usage = {
      inputOther: message.usage.input,
      output: message.usage.output,
      inputCacheRead: message.usage.cacheRead,
      inputCacheCreation: message.usage.cacheWrite,
    };
  }

  private *startTool(index: number, call: PiToolCall): Generator<StreamedMessagePart> {
    if (this.toolStates.has(index)) return;
    const state: ToolState = { arguments: '', extras: {} };
    this.toolStates.set(index, state);
    yield {
      type: 'function',
      id: call.id,
      name: call.name,
      arguments: '',
      extras: state.extras,
      _streamIndex: index,
    };
  }

  private *endTool(
    index: number,
    call: PiToolCall,
    message: AssistantMessage,
  ): Generator<StreamedMessagePart> {
    if (this.endedBlocks.has(index)) return;
    yield* this.startTool(index, call);
    const state = this.toolStates.get(index)!;
    if (call.thoughtSignature !== undefined)
      state.extras['thought_signature_b64'] = encodePiSignature(message, call.thoughtSignature);
    if (call.namespace !== undefined) state.extras['namespace'] = call.namespace;
    if (state.arguments.length === 0) {
      const args = JSON.stringify(call.arguments);
      yield { type: 'tool_call_part', argumentsPart: args, index };
      state.arguments = args;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(state.arguments);
      } catch (error) {
        throw new ChatProviderError(
          `Provider returned incomplete arguments for tool '${call.name}'.`,
          undefined,
          { cause: error },
        );
      }
      if (!isDeepStrictEqual(parsed, call.arguments))
        throw new ChatProviderError(
          `Provider changed completed arguments for tool '${call.name}'.`,
        );
    }
    this.endedBlocks.add(index);
  }

  private *endContent(index: number, message: AssistantMessage): Generator<StreamedMessagePart> {
    if (this.endedBlocks.has(index)) return;
    const block = message.content[index];
    if (block === undefined) return;
    if (block.type === 'toolCall') {
      yield* this.endTool(index, block, message);
      return;
    }
    if (block.type === 'text') {
      const text = block.text.slice(this.textLengths.get(index) ?? 0);
      if (text.length > 0 || block.textSignature !== undefined)
        yield {
          type: 'text',
          text,
          _streamIndex: index,
          textSignature:
            block.textSignature === undefined
              ? undefined
              : encodePiSignature(message, block.textSignature),
        };
    } else {
      const think = block.thinking.slice(this.thinkingLengths.get(index) ?? 0);
      if (think.length > 0 || block.thinkingSignature !== undefined)
        yield {
          type: 'think',
          think,
          _streamIndex: index,
          encrypted:
            block.thinkingSignature === undefined
              ? undefined
              : encodePiSignature(message, block.thinkingSignature, block.redacted),
        };
    }
    this.endedBlocks.add(index);
  }

  private *decode(event: AssistantMessageEvent): Generator<StreamedMessagePart> {
    if ('partial' in event) this.update(event.partial);
    switch (event.type) {
      case 'text_delta':
        this.textLengths.set(
          event.contentIndex,
          (this.textLengths.get(event.contentIndex) ?? 0) + event.delta.length,
        );
        yield { type: 'text', text: event.delta, _streamIndex: event.contentIndex };
        break;
      case 'thinking_delta':
        this.thinkingLengths.set(
          event.contentIndex,
          (this.thinkingLengths.get(event.contentIndex) ?? 0) + event.delta.length,
        );
        yield { type: 'think', think: event.delta, _streamIndex: event.contentIndex };
        break;
      case 'text_end':
      case 'thinking_end':
        yield* this.endContent(event.contentIndex, event.partial);
        break;
      case 'toolcall_start':
      case 'toolcall_delta': {
        const call = event.partial.content[event.contentIndex];
        if (call?.type !== 'toolCall')
          throw new ChatProviderError('Provider emitted a tool event without a tool call.');
        yield* this.startTool(event.contentIndex, call);
        if (event.type === 'toolcall_delta' && event.delta.length > 0) {
          this.toolStates.get(event.contentIndex)!.arguments += event.delta;
          yield { type: 'tool_call_part', argumentsPart: event.delta, index: event.contentIndex };
        }
        break;
      }
      case 'toolcall_end':
        yield* this.endTool(event.contentIndex, event.toolCall, event.partial);
        break;
      case 'done':
        this.update(event.message);
        if (event.reason === 'deferred')
          throw new ChatProviderError(
            'Deferred provider responses are not supported by this agent runtime.',
          );
        this.rawFinishReason = event.message.rawStopReason ?? event.reason;
        this.finishReason =
          event.reason === 'length'
            ? 'truncated'
            : event.reason === 'toolUse'
              ? 'tool_calls'
              : 'completed';
        for (const index of event.message.content.keys())
          yield* this.endContent(index, event.message);
        break;
      case 'error':
        this.update(event.error);
        this.rawFinishReason = event.error.rawStopReason ?? event.reason;
        if (event.reason === 'aborted') throw createAbortError();
        if (
          [
            'content_filter',
            'SAFETY',
            'RECITATION',
            'BLOCKLIST',
            'PROHIBITED_CONTENT',
            'SPII',
          ].includes(this.rawFinishReason)
        )
          throw new APIEmptyResponseError(
            event.error.errorMessage ?? 'Provider filtered the response.',
            { finishReason: 'filtered', rawFinishReason: this.rawFinishReason },
          );
        throw convertPiError(event.error.errorMessage ?? 'Provider stream failed.', this.response);
    }
  }

  private async *iterate(): AsyncGenerator<StreamedMessagePart> {
    let completed = false;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(createAbortError());
      this.signal.addEventListener('abort', abortListener, { once: true });
    });
    const iterator = this.source[Symbol.asyncIterator]();
    try {
      while (true) {
        if (this.signal.aborted) throw createAbortError();
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        const event = next.value;
        yield* this.decode(event);
        if (event.type === 'done') {
          completed = true;
          return;
        }
      }
      if (this.signal.aborted) throw createAbortError();
      throw new APIConnectionError('Provider stream ended without a completion event.');
    } catch (error) {
      if (this.signal.aborted) throw createAbortError();
      throw this.convertError(convertPiError(error, this.response));
    } finally {
      if (abortListener !== undefined) this.signal.removeEventListener('abort', abortListener);
      if (!completed) this.controller.abort();
    }
  }
}
