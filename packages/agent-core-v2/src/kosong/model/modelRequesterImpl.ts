import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type { VideoURLPart } from '#/kosong/contract/message';
import { APIStatusError, APITimeoutError, isAbortError, VideoUploadUnsupportedError } from '#/kosong/contract/errors';
import { abortable, linkAbortSignal } from '#/_base/utils/abort';
import { generate, type GenerateResult } from '#/kosong/contract/generate';
import type {
  ChatProvider,
  GenerateOptions,
  ProviderRequestAuth,
  StreamDecodeStats,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import { translateProviderError } from '#/kosong/protocol/errors';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';

import type { AuthProvider, Model } from './catalog';
import type {
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
  ModelRequestTiming,
} from './modelRequester';

export class ModelRequesterImpl implements ModelRequester {
  private cachedChatProvider: ChatProvider | undefined;

  constructor(
    readonly model: Model,
    private readonly protocolRegistry: IProtocolAdapterRegistry,
  ) {}

  private resolveChatProvider(): ChatProvider {
    if (this.cachedChatProvider !== undefined) return this.cachedChatProvider;
    const model = this.model;
    this.cachedChatProvider = this.protocolRegistry.createChatProvider({
      protocol: model.protocol,
      capabilities: model.capabilities,
      thinking: model.thinking,
      effortMapping: model.effortMapping,
      providerType: model.providerType,
      baseUrl: model.baseUrl,
      modelName: model.name,
      defaultHeaders: model.headers,
      providerOptions: model.providerOptions,
    });
    return this.cachedChatProvider;
  }

  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent> {
    const queue = new AsyncEventQueue<ModelRequestEvent>();
    const controller = new AbortController();
    const unlink = signal === undefined ? () => {} : linkAbortSignal(signal, controller);
    const finished = this.runRequest(input, controller, queue, params).then(
      () => { queue.end(); },
      (error) => { queue.fail(error); },
    ).finally(unlink);
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => queue.next(),
          async return() {
            controller.abort();
            const result = await queue.return();
            await finished;
            return result;
          },
        };
      },
    };
  }

  async uploadVideo(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart> {
    const provider = this.resolveChatProvider();
    if (provider.uploadVideo === undefined) {
      throw new VideoUploadUnsupportedError(
        `Model "${this.model.id}" (protocol=${this.model.protocol}) does not support video upload`,
      );
    }
    const uploadVideo = provider.uploadVideo.bind(provider);
    return this.runWithAuthRefresh((auth) =>
      uploadVideo(input, { signal: options?.signal, auth }),
    );
  }

  private async runRequest(
    input: ModelRequestInput,
    controller: AbortController,
    queue: AsyncEventQueue<ModelRequestEvent>,
    params?: ModelRequestParams,
  ): Promise<void> {
    const signal = controller.signal;
    signal.throwIfAborted();
    const provider = this.resolveChatProvider();
    const idleTimeoutMs = params?.idleTimeoutMs;
    if (idleTimeoutMs !== undefined && (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2 ** 31 - 1)) throw new RangeError('Invalid model request idle timeout');
    const remaining = params?.deadlineAt === undefined ? undefined : Math.ceil(params.deadlineAt - Date.now());
    if (remaining !== undefined && (!Number.isSafeInteger(remaining) || remaining > 2 ** 31 - 1)) throw new RangeError('Invalid model request recovery deadline');
    if (remaining !== undefined && remaining <= 0) throw new APITimeoutError('Model retry recovery budget exhausted');
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let receivedBody = false;
    let stopped = false;
    const clearTimers = () => {
      stopped = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    };
    let deadlineTimer = remaining === undefined ? undefined : setTimeout(() => {
      controller.abort(new APITimeoutError('Model retry recovery budget exhausted'));
    }, remaining);
    deadlineTimer?.unref();
    const bodyReceived = () => {
      if (stopped || signal.aborted || receivedBody) return;
      receivedBody = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      params?.onProtocolProgress?.('body');
    };
    const progress = (stage: 'start' | 'headers' | 'body') => {
      if (stopped || signal.aborted) return;
      if (stage === 'body') bodyReceived();
      else params?.onProtocolProgress?.(stage);
      if (idleTimeoutMs === undefined) return;
      if (idleTimer !== undefined) { idleTimer.refresh(); return; }
      idleTimer = setTimeout(() => {
        controller.abort(new APITimeoutError(`Model request made no protocol progress for ${String(idleTimeoutMs)}ms`));
      }, idleTimeoutMs);
      idleTimer.unref();
    };
    signal.addEventListener('abort', clearTimers, { once: true });

    let requestStartedAt = Date.now();
    let requestSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let decodeStats: StreamDecodeStats | undefined;

    const options: GenerateOptions = {
      signal,
      cacheKey: params?.cacheKey,
      sampling: params?.sampling,
      thinking:
        params?.thinkingEffort === undefined
          ? undefined
          : { effort: params.thinkingEffort, keep: params.thinkingKeep },
      maxCompletionTokens: params?.maxCompletionTokens,
      usedContextTokens: params?.usedContextTokens,
      maxContextTokens: params?.maxContextTokens,
      onRequestStart: () => {
        requestStartedAt = Date.now();
      },
      onRequestSent: () => {
        requestSentAt = Date.now();
      },
      onStreamEnd: (stats) => {
        streamEndedAt = Date.now();
        decodeStats = stats;
      },
      onTraceId: params?.onTraceId,
      onProtocolProgress: idleTimeoutMs === undefined && remaining === undefined && params?.onProtocolProgress === undefined ? undefined : progress,
      responseFormat: input.responseFormat,
    };

    let result: GenerateResult;
    try {
      result = await abortable(this.runWithAuthRefresh((auth) => {
        requestStartedAt = Date.now();
        return generate(
          provider,
          input.systemPrompt,
          [...input.tools],
          [...input.messages],
          {
            onMessagePart: (part) => {
              bodyReceived();
              firstChunkAt ??= Date.now();
              queue.push({ type: 'part', part });
            },
          },
          { ...options, auth },
        );
      }), signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      throw translateProviderError(error);
    } finally {
      clearTimers();
      signal.removeEventListener('abort', clearTimers);
    }

    if (result.usage !== undefined && result.usage !== null) {
      queue.push({ type: 'usage', usage: result.usage, model: this.model.name });
    }
    queue.push({
      type: 'finish',
      message: result.message,
      providerFinishReason: result.finishReason ?? undefined,
      rawFinishReason: result.rawFinishReason ?? undefined,
      id: result.id ?? undefined,
      traceId: result.traceId ?? undefined,
    });
    if (firstChunkAt !== undefined) {
      queue.push({
        type: 'timing',
        ...buildStreamTiming(
          requestStartedAt,
          requestSentAt,
          firstChunkAt,
          streamEndedAt,
          decodeStats,
        ),
      });
    }
  }

  private async runWithAuthRefresh<T>(
    run: (auth: ProviderRequestAuth | undefined) => Promise<T>,
  ): Promise<T> {
    const auth = await this.authProvider.getAuth();
    try {
      return await run(auth);
    } catch (error) {
      if (!this.shouldForceRefresh(error)) throw error;
    }

    const refreshedAuth = await this.authProvider.getAuth({ force: true });
    try {
      return await run(refreshedAuth);
    } catch (error) {
      if (isUnauthorizedStatusError(error)) throw translateProviderError(error);
      throw error;
    }
  }

  private get authProvider(): AuthProvider {
    return this.model.authProvider;
  }

  private shouldForceRefresh(error: unknown): boolean {
    return this.authProvider.canRefresh === true && isUnauthorizedStatusError(error);
  }
}

function isUnauthorizedStatusError(error: unknown): error is APIStatusError {
  return error instanceof APIStatusError && error.statusCode === 401;
}

type MutableModelRequestTiming = { -readonly [K in keyof ModelRequestTiming]: ModelRequestTiming[K] };

export function buildStreamTiming(
  requestStartedAt: number,
  requestSentAt: number | undefined,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
  decodeStats: StreamDecodeStats | undefined,
): ModelRequestTiming {
  const outputEndedAt = streamEndedAt ?? Date.now();
  const timing: MutableModelRequestTiming = {
    firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
  if (requestSentAt !== undefined) {
    const sentAt = Math.min(Math.max(requestSentAt, requestStartedAt), firstChunkAt);
    timing.requestBuildMs = sentAt - requestStartedAt;
    timing.serverFirstTokenMs = firstChunkAt - sentAt;
  }
  if (decodeStats !== undefined) {
    timing.serverDecodeMs = Math.max(0, decodeStats.serverDecodeMs);
    timing.clientConsumeMs = Math.max(0, decodeStats.clientConsumeMs);
  }
  return timing;
}
