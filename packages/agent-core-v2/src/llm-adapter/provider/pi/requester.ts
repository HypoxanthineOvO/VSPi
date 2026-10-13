import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestControl,
  LlmRequester,
} from '#human/llm/requester/requester';
import { applyCredential } from '#human/credentials/credentials';
import {
  fromLlmMessage,
  toLlmMessage,
  type Message,
  type Tool,
  type StreamedMessagePart,
} from '#/llm-adapter/contract/message';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
} from '#/llm-adapter/contract/provider';
import { toLlmErrorMessage } from '#human/llm/errors';
import { errorFromLlmMessage, llmMessageFromError } from '#/llm-adapter/contract/errors';
import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type { ProtocolAdapterConfig } from '#/llm-adapter/protocol/protocol';
import type { Model } from '#/llm-adapter/model/catalog';
import { withScopedProxy } from '#/_base/utils/scopedProxy';
import { findPiModel } from './catalog';
import { PiChatProvider } from './piChatProvider';

export class PiLlmRequester implements LlmRequester {
  constructor(
    private readonly model: Model,
    private readonly fallback: LlmRequester,
    private readonly proxyForUrl: (
      url: string | undefined,
      fallback?: string,
    ) => string | undefined,
  ) {}

  async generate(
    config: LlmRequestConfig,
    content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<void> {
    const adapter: ProtocolAdapterConfig = {
      protocol: this.model.protocol,
      providerType: this.model.providerType,
      modelName: config.model.model,
      baseUrl: config.model.baseUrl,
      defaultHeaders: config.model.defaultHeaders,
      capabilities: this.model.capabilities,
      thinking: this.model.thinking,
      effortMapping: this.model.effortMapping,
      providerOptions: this.model.providerOptions,
    };
    const native = new NativeChatProvider(this.fallback, config);
    const pi = new PiChatProvider(
      adapter,
      findPiModel(adapter.providerType, adapter.modelName, adapter.protocol),
      native,
    );
    const proxy = this.proxyForUrl(config.model.baseUrl, config.model.proxyUrl);
    try {
      await withScopedProxy(proxy, async () => {
        const stream = await pi.generate(
          config.systemPrompt ?? '',
          [...(config.tools ?? [])],
          content.messages.map(fromLlmMessage),
          {
            signal: control.signal,
            auth: {
              apiKey: config.model.apiKey,
              headers: config.model.defaultHeaders,
              baseUrl: config.model.baseUrl,
              removeHeaders: config.model.removeHeaders,
            },
            thinking: config.thinking,
            responseFormat: config.responseFormat,
            maxCompletionTokens: config.maxCompletionTokens,
            maxContextTokens: config.maxContextTokens,
            usedContextTokens: content.usedContextTokens,
            cacheKey: config.cacheKey,
            sampling: {
              temperature:
                config.extraParams?.openai?.temperature ??
                config.extraParams?.responses?.temperature ??
                config.extraParams?.anthropic?.temperature ??
                config.extraParams?.googleGenai?.temperature,
              topP:
                config.extraParams?.openai?.top_p ??
                config.extraParams?.responses?.top_p ??
                config.extraParams?.anthropic?.top_p ??
                config.extraParams?.googleGenai?.topP,
            },
            onProtocolProgress: control.onProtocolProgress,
            onRequestSent: () => control.onEvent?.({ type: 'llm.sent' }),
            onTraceId: (id) => {
              if (id)
                control.onEvent?.({ type: 'llm.streaming.headers', headers: { 'x-trace-id': id } });
            },
          },
        );
        for await (const part of stream) control.onEvent?.({ type: 'llm.streaming.part', part });
        if (stream.usage) control.onEvent?.({ type: 'llm.streaming.usage', usage: stream.usage });
        if (stream.id)
          control.onEvent?.({ type: 'llm.streaming.message_id', messageId: stream.id });
        control.onEvent?.({
          type: 'llm.streaming.finish',
          finish: { finishReason: stream.finishReason, rawFinishReason: stream.rawFinishReason },
        });
        control.onEvent?.({ type: 'llm.done' });
      });
    } catch (error) {
      control.onEvent?.({
        type: 'llm.failed.remote',
        error: llmMessageFromError(error) ?? toLlmErrorMessage(error),
        rawError: error,
      });
    }
  }
}

export class NativeChatProvider implements ChatProvider {
  readonly name = 'native';
  readonly thinkingEffort = null;
  get modelName(): string {
    return this.config.model.model;
  }
  constructor(
    private readonly requester: LlmRequester,
    private readonly config: LlmRequestConfig,
  ) {}

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options: GenerateOptions = {},
  ): Promise<StreamedMessage> {
    const queue = new AsyncEventQueue<StreamedMessagePart>();
    const state: {
      id: string | null;
      usage: StreamedMessage['usage'];
      finishReason: StreamedMessage['finishReason'];
      rawFinishReason: string | null;
      traceId?: string | null;
    } = { id: null, usage: null, finishReason: null, rawFinishReason: null };
    void this.requester
      .generate(
        {
          ...this.config,
          model: applyCredential(this.config.model, options.auth),
          systemPrompt,
          tools,
          thinking: options.thinking ?? this.config.thinking,
          responseFormat: options.responseFormat ?? this.config.responseFormat,
          maxCompletionTokens: options.maxCompletionTokens ?? this.config.maxCompletionTokens,
          maxContextTokens: options.maxContextTokens ?? this.config.maxContextTokens,
          cacheKey: options.cacheKey ?? this.config.cacheKey,
        },
        { messages: history.map(toLlmMessage), usedContextTokens: options.usedContextTokens },
        {
          signal: options.signal ?? new AbortController().signal,
          onProtocolProgress: options.onProtocolProgress,
          onEvent: (event) => {
            switch (event.type) {
              case 'llm.sent':
                options.onRequestSent?.();
                break;
              case 'llm.streaming.headers':
                state.traceId = event.headers['x-trace-id'];
                options.onTraceId?.(state.traceId ?? null);
                break;
              case 'llm.streaming.part':
                queue.push(event.part);
                break;
              case 'llm.streaming.usage':
                state.usage = { ...state.usage, ...event.usage } as NonNullable<
                  StreamedMessage['usage']
                >;
                break;
              case 'llm.streaming.finish':
                state.finishReason = event.finish.finishReason;
                state.rawFinishReason = event.finish.rawFinishReason;
                break;
              case 'llm.streaming.message_id':
                state.id = event.messageId;
                break;
              case 'llm.failed.syntax':
                queue.fail(errorFromLlmMessage(event.error));
                break;
              case 'llm.failed.remote':
                queue.fail(event.rawError ?? errorFromLlmMessage(event.error));
                break;
            }
          },
        },
      )
      .then(
        () => queue.end(),
        (error) => queue.fail(error),
      );
    return {
      get id() {
        return state.id;
      },
      get usage() {
        return state.usage;
      },
      get finishReason() {
        return state.finishReason;
      },
      get rawFinishReason() {
        return state.rawFinishReason;
      },
      get traceId() {
        return state.traceId;
      },
      [Symbol.asyncIterator]: () => queue,
    };
  }
}
