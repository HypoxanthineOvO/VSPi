import {
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  lazyApi,
  type Api,
  type Model,
  type Provider,
  type ProviderStreamOptions,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

import { thinkingEffortsForProvider } from '#/kosong/contract/capability';
import {
  APIStatusError,
  ChatProviderError,
  createAbortError,
  VideoUploadUnsupportedError,
} from '#/kosong/contract/errors';
import type { Message, VideoURLPart } from '#/kosong/contract/message';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import { resolveProviderEndpoint } from '#/kosong/provider/providerDefinition';
import { classifyKimiQuotaError } from '#/kosong/provider/providers/kimi/kimi-errors';
import { kimiOpenAITrait, kimiAnthropicTrait } from '#/kosong/provider/providers/kimi/kimi.contrib';

import { toLegacyHistory, toPiContext } from './messages';
import { convertPiError, PiStreamedMessage, type PiResponseState } from './streamedMessage';

const API_BY_PROTOCOL: Record<ProtocolAdapterConfig['protocol'], Api> = {
  openai: 'openai-completions',
  openai_responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  'google-genai': 'google-generative-ai',
};

const BASE_URL_BY_PROTOCOL: Record<ProtocolAdapterConfig['protocol'], string> = {
  openai: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'google-genai': 'https://generativelanguage.googleapis.com/v1beta',
};

const providers = builtinProviders();

function providerForModel(model: Model<Api>): Provider {
  const builtin = providers.find((provider) => provider.id === model.provider);
  if (builtin?.getModels().some((candidate) => candidate.api === model.api)) return builtin;
  const api = lazyApi(async () => {
    switch (model.api) {
      case 'openai-completions':
        return import('@earendil-works/pi-ai/api/openai-completions');
      case 'openai-responses':
        return import('@earendil-works/pi-ai/api/openai-responses');
      case 'openai-codex-responses':
        return import('@earendil-works/pi-ai/api/openai-codex-responses');
      case 'azure-openai-responses':
        return import('@earendil-works/pi-ai/api/azure-openai-responses');
      case 'anthropic-messages':
        return import('@earendil-works/pi-ai/api/anthropic-messages');
      case 'google-generative-ai':
        return import('@earendil-works/pi-ai/api/google-generative-ai');
      case 'google-vertex':
        return import('@earendil-works/pi-ai/api/google-vertex');
      default:
        throw new ChatProviderError(`Unsupported provider API '${model.api}'.`);
    }
  });
  return createProvider({
    id: model.provider,
    name: model.provider,
    auth: builtin?.auth ?? { apiKey: envApiKeyAuth('API key', []) },
    models: [model],
    api,
  });
}

function isThinkingLevel(effort: string): effort is ThinkingLevel {
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ChatProviderError('Provider payload must be an object.');
  return value as Record<string, unknown>;
}

function responseFormatPayload(
  payload: Record<string, unknown>,
  api: Api,
  options: GenerateOptions,
): void {
  const format = options.responseFormat;
  if (format === undefined) return;
  const schema = format.type === 'json_schema' ? format.jsonSchema : undefined;
  if (api === 'openai-completions') {
    payload['response_format'] =
      schema === undefined
        ? { type: 'json_object' }
        : {
            type: 'json_schema',
            json_schema: {
              name: schema.name,
              description: schema.description,
              schema: schema.schema,
              strict: schema.strict,
            },
          };
  } else if (
    ['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(api)
  ) {
    payload['text'] = {
      ...(payload['text'] === undefined ? {} : object(payload['text'])),
      format:
        schema === undefined
          ? { type: 'json_object' }
          : {
              type: 'json_schema',
              name: schema.name,
              description: schema.description,
              schema: schema.schema,
              strict: schema.strict,
            },
    };
  } else if (api === 'anthropic-messages') {
    payload['output_config'] = {
      ...(payload['output_config'] === undefined ? {} : object(payload['output_config'])),
      format: {
        type: 'json_schema',
        schema: schema?.schema ?? { type: 'object', additionalProperties: true },
      },
    };
  } else if (api === 'google-generative-ai' || api === 'google-vertex') {
    payload['config'] = {
      ...(payload['config'] === undefined ? {} : object(payload['config'])),
      responseMimeType: 'application/json',
      responseJsonSchema: schema?.schema,
    };
  } else {
    throw new ChatProviderError(`Structured response formats are not supported for '${api}'.`);
  }
}

function rawThinkingOptions(api: Api, effort: string): ProviderStreamOptions {
  if (api === 'anthropic-messages')
    return { thinkingEnabled: effort !== 'off', effort: effort === 'off' ? undefined : effort };
  if (api === 'google-generative-ai' || api === 'google-vertex') {
    const budget = Number(effort);
    return {
      thinking: {
        enabled: effort !== 'off',
        level: Number.isFinite(budget) ? undefined : effort,
        budgetTokens: Number.isFinite(budget) ? budget : undefined,
      },
    };
  }
  if (api === 'bedrock-converse-stream') return { reasoning: effort };
  return { reasoningEffort: effort === 'off' ? undefined : effort };
}

export class PiChatProvider implements ChatProvider {
  readonly name: string;
  readonly modelName: string;
  readonly thinkingEffort = null;
  readonly maxCompletionTokens: number;
  private readonly model: Model<Api>;
  private readonly provider: Provider;
  private compatibilityProvider: ChatProvider | undefined;

  constructor(
    private readonly config: ProtocolAdapterConfig,
    model?: Model<Api>,
    private readonly legacyCompat?: ChatProvider | (() => ChatProvider),
  ) {
    this.name = config.providerType ?? model?.provider ?? config.protocol;
    this.modelName = config.modelName;
    this.maxCompletionTokens =
      config.providerOptions?.defaultMaxTokens ?? model?.maxTokens ?? 32768;
    const thinkingLevelMap: ThinkingLevelMap = { ...model?.thinkingLevelMap, ...config.effortMapping };
    if (config.thinking !== undefined) {
      const efforts = thinkingEffortsForProvider(config.thinking, config.providerType);
      for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        if (efforts.length > 0)
          thinkingLevelMap[level] = efforts.includes(level)
            ? (config.effortMapping && Object.hasOwn(config.effortMapping, level) ? config.effortMapping[level] : model?.thinkingLevelMap?.[level] ?? (level === 'xhigh' || level === 'max' ? level : undefined))
            : null;
      }
      thinkingLevelMap.off = config.thinking.canDisable
        ? (config.effortMapping?.['off'] ?? config.providerOptions?.offEffort ?? model?.thinkingLevelMap?.off)
        : null;
    } else if (config.providerOptions?.offEffort !== undefined) {
      thinkingLevelMap.off = config.providerOptions.offEffort;
    }
    this.model = {
      id: config.modelName,
      name: model?.name ?? config.modelName,
      api:
        config.providerOptions?.vertexai === true
          ? 'google-vertex'
          : (model?.api ?? API_BY_PROTOCOL[config.protocol]),
      provider: model?.provider ?? config.providerType ?? config.protocol,
      baseUrl: config.baseUrl ?? model?.baseUrl ?? BASE_URL_BY_PROTOCOL[config.protocol],
      reasoning:
        config.thinking === undefined
          ? (config.capabilities?.thinking ?? model?.reasoning ?? false)
          : config.thinking.availability !== 'none',
      thinkingLevelMap,
      input:
        config.capabilities === undefined
          ? (model?.input ?? ['text'])
          : config.capabilities.image_in
            ? ['text', 'image']
            : ['text'],
      cost: model?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.capabilities?.max_context_tokens || model?.contextWindow || 131072,
      maxTokens: this.maxCompletionTokens,
      headers: { ...model?.headers, ...config.defaultHeaders },
      samplingParams: model?.samplingParams,
      compat: model?.compat,
    };
    this.provider = providerForModel(this.model);
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options: GenerateOptions = {},
  ): Promise<StreamedMessage> {
    if (options.signal?.aborted) throw createAbortError();
    if (
      this.legacyCompat !== undefined &&
      (this.config.providerOptions?.reasoningKey !== undefined ||
        tools.some((tool) => tool.name.startsWith('$')) ||
        history.some(
          (message) =>
            (message.tools?.length ?? 0) > 0 ||
            (this.config.providerType === 'kimi' && message.role === 'tool' && message.content.some((part) => part.type === 'image_url')) ||
            message.toolCalls.some((call) =>
              Object.keys(call.extras ?? {}).some(
                (key) => key !== 'thought_signature_b64' && key !== 'namespace',
              ),
            ) ||
            message.content.some(
              (part) =>
                part.type === 'video_url' ||
                part.type === 'audio_url' ||
                (this.config.protocol === 'anthropic' &&
                  part.type === 'think' &&
                  part.encrypted === undefined),
            ),
        ))
    )
      return this.resolveCompatibilityProvider()!.generate(
        systemPrompt,
        tools,
        toLegacyHistory(history, this.model),
        options,
      );
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const response: PiResponseState = {};
    try {
      const endpoint = resolveProviderEndpoint(this.config.providerType ?? this.config.protocol);
      const model: Model<Api> = {
        ...this.model,
        baseUrl:
          options.auth?.baseUrl ?? this.config.baseUrl ?? endpoint.baseUrl ?? this.model.baseUrl,
        headers: { ...this.model.headers },
      };
      for (const name of options.auth?.removeHeaders ?? []) {
        for (const key of Object.keys(model.headers ?? {}))
          if (key.toLowerCase() === name.toLowerCase()) delete model.headers?.[key];
      }
      const context = await toPiContext(systemPrompt, tools, history, model, signal);
      const levels = getSupportedThinkingLevels(this.model);
      const configuredEfforts =
        this.config.thinking === undefined
          ? []
          : thinkingEffortsForProvider(this.config.thinking, this.config.providerType);
      const defaultEffort =
        this.config.thinking?.defaultEffort ??
        configuredEfforts[Math.floor(configuredEfforts.length / 2)] ??
        (levels.includes('medium') ? 'medium' : (levels.find((level) => level !== 'off') ?? 'off'));
      const effort = options.thinking?.effort ?? defaultEffort;
      const selectedEffort = effort === 'on' ? defaultEffort : effort;
      const headers: Record<string, string | null> = {
        ...this.config.defaultHeaders,
        ...options.auth?.headers,
      };
      for (const name of options.auth?.removeHeaders ?? []) {
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
        headers[name] = null;
      }
      const common: ProviderStreamOptions = {
        signal,
        apiKey: options.auth?.apiKey ?? this.config.apiKey ?? endpoint.apiKey,
        headers,
        maxTokens: options.maxCompletionTokens ?? this.maxCompletionTokens,
        temperature: options.sampling?.temperature,
        sessionId: options.cacheKey,
        maxRetries: 0,
        metadata: this.config.providerOptions?.metadata,
        env:
          this.config.providerOptions?.vertexai === true
            ? {
                GOOGLE_CLOUD_PROJECT: this.config.providerOptions.project ?? '',
                GOOGLE_CLOUD_LOCATION: this.config.providerOptions.location ?? '',
              }
            : undefined,
        fetch:
          model.api === 'google-generative-ai' || model.api === 'google-vertex'
            ? undefined
            : async (input, init) => {
                const received = await fetch(input, init);
                response.status = received.status;
                response.headers = Object.fromEntries(received.headers.entries());
                return received;
              },
        onResponse: (received) => {
          response.status = received.status;
          response.headers = received.headers;
          options.onTraceId?.(new Headers(received.headers).get('x-trace-id'));
        },
        onPayload: (value) => {
          let payload = object(value);
          const topP = options.sampling?.topP;
          if (topP !== undefined) {
            if (this.model.api === 'google-generative-ai' || this.model.api === 'google-vertex')
              payload['config'] = {
                ...(payload['config'] === undefined ? {} : object(payload['config'])),
                topP,
              };
            else payload['top_p'] = topP;
          }
          responseFormatPayload(payload, this.model.api, options);
          if (options.cacheKey !== undefined && this.model.api === 'anthropic-messages')
            payload['metadata'] = {
              ...(payload['metadata'] === undefined ? {} : object(payload['metadata'])),
              user_id: options.cacheKey,
            };
          if (this.config.providerType === 'kimi') {
            const trait =
              this.config.protocol === 'anthropic' ? kimiAnthropicTrait : kimiOpenAITrait;
            const context = { config: this.config, providerId: this.config.providerType };
            Object.assign(
              payload,
              trait.withThinking?.(
                selectedEffort,
                { keep: options.thinking?.keep },
                payload,
                context,
              ),
            );
            if (this.config.protocol === 'openai') {
              delete payload['reasoning_effort'];
              payload = trait.buildParams?.(payload, context) ?? payload;
              if (tools.length > 0)
                payload['tools'] = tools.map((tool) => trait.convertTool?.(tool, context));
              if (options.cacheKey !== undefined) payload['prompt_cache_key'] = options.cacheKey;
            } else {
              delete payload['betaFeatures'];
            }
          }
          options.onRequestSent?.();
          return payload;
        },
      };
      const source =
        selectedEffort === undefined || selectedEffort === 'off' || isThinkingLevel(selectedEffort)
          ? this.provider.streamSimple(model, context, {
              ...common,
              reasoning:
                selectedEffort !== undefined && isThinkingLevel(selectedEffort)
                  ? selectedEffort
                  : undefined,
            })
          : this.provider.stream(model, context, {
              ...common,
              ...rawThinkingOptions(this.model.api, selectedEffort),
            });
      return new PiStreamedMessage(source, controller, signal, response, (error) =>
        this.config.providerType === 'kimi' && error instanceof APIStatusError
          ? (classifyKimiQuotaError({
              status: error.statusCode,
              message: error.message,
              headers: new Headers(response.headers),
            }) ?? error)
          : error,
      );
    } catch (error) {
      controller.abort();
      throw convertPiError(error, response);
    }
  }

  async uploadVideo(
    input: string | VideoUploadInput,
    options?: GenerateOptions,
  ): Promise<VideoURLPart> {
    const provider = this.resolveCompatibilityProvider();
    if (provider?.uploadVideo === undefined)
      throw new VideoUploadUnsupportedError('This provider does not support video uploads.');
    return provider.uploadVideo(input, options);
  }

  private resolveCompatibilityProvider(): ChatProvider | undefined {
    this.compatibilityProvider ??= typeof this.legacyCompat === 'function' ? this.legacyCompat() : this.legacyCompat;
    return this.compatibilityProvider;
  }
}
