import { createHash, randomUUID } from 'node:crypto';
import type { Message, StreamedMessagePart, Tool } from '#/llm-adapter/contract/message';
import type { ChatProvider, GenerateOptions, StreamedMessage } from '#/llm-adapter/contract/provider';
import { APIIncompleteStreamError, APIProtocolError, ChatProviderError } from '#/llm-adapter/contract/errors';
import type { ProtocolAdapterConfig } from '#/llm-adapter/protocol/protocol';
import { checkTrailer, child, children, connectFrame, ConnectDecoder, decode, double, field, message, number, text } from './protobuf';
import { DEVIN_BASE_URL, DEVIN_CHAT_PATH, devinHttpError, devinMetadata, devinRequestAuth } from './wire';
import { normalizeDevinGeminiSchema } from './schema';

function stableId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function devinToolId(id: string): string {
  if (/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return id;
  return `call_${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

export function accumulateDevinArguments(previous: string, incoming: string): string {
  return incoming.startsWith(previous) ? incoming : previous + incoming;
}

async function historyPrompt(row: Message, index: number, cascadeId: string, model: string, signal?: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = [];
  let prompt = '';
  let thinking = '';
  let signature = '';
  for (const part of row.content) {
    if (part.type === 'text') prompt += part.text;
    else if (part.type === 'think') {
      thinking += part.think;
      if (part.encrypted?.startsWith('devin:')) {
        try {
          const data = JSON.parse(part.encrypted.slice(6)) as { model?: string; signature?: string };
          if (data.model === model && typeof data.signature === 'string') signature += data.signature;
        } catch {}
      }
    } else if (part.type === 'image_url') {
      const inline = /^data:(image\/[^;,]+);base64,([\s\S]*)$/.exec(part.imageUrl.url);
      if (inline) parts.push(field(10, message(field(1, inline[2]), field(2, inline[1]))));
      else {
        if (!/^https?:\/\//i.test(part.imageUrl.url)) throw new ChatProviderError('Devin requires image data URLs or HTTP(S) URLs.');
        const response = await fetch(part.imageUrl.url, { signal });
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
        if (!response.ok || !mime?.startsWith('image/')) throw new ChatProviderError('Devin image download failed or returned a non-image.');
        parts.push(field(10, message(field(1, Buffer.from(await response.arrayBuffer()).toString('base64')), field(2, mime))));
      }
    } else throw new ChatProviderError(`Devin does not support ${part.type} content.`);
  }
  return message(field(1, stableId(`${cascadeId}\0${index}\0${row.role}`)),
    field(2, row.role === 'assistant' ? 2 : row.role === 'tool' ? 4 : row.role === 'system' ? 5 : 1), field(3, prompt),
    ...row.toolCalls.map(call => field(6, message(field(1, devinToolId(call.id)), field(2, call.name), field(3, call.arguments ?? '{}')))),
    field(7, row.toolCallId === undefined ? undefined : devinToolId(row.toolCallId)), ...parts,
    field(11, thinking || undefined), field(12, signature || undefined));
}

export async function buildDevinRequest(config: ProtocolAdapterConfig, system: string, tools: Tool[], history: Message[], options: GenerateOptions, token: string, jwt: string): Promise<Buffer> {
  const cascadeId = options.cacheKey ? stableId(options.cacheKey) : randomUUID();
  const effort = options.thinking?.effort ?? config.thinking?.defaultEffort;
  const uid = effort ? config.effortMapping?.[effort] ?? config.modelName : config.modelName;
  const prompts = await Promise.all(history.map((row, index) => historyPrompt(row, index, cascadeId, config.modelName, options.signal)));
  return message(field(1, devinMetadata(token, jwt)), field(2, system), ...prompts.map(prompt => field(3, prompt)),
    field(21, uid), field(7, 5), field(20, 1), field(16, cascadeId), field(22, randomUUID()),
    field(12, field(1, 'auto')), field(13, field(1, 1)),
    field(8, message(field(1, 1), field(2, options.maxCompletionTokens ?? config.providerOptions?.defaultMaxTokens ?? 64000),
      field(3, 400), double(5, options.sampling?.temperature ?? 1), field(7, 40), double(8, Math.fround(options.sampling?.topP ?? 0.95)))),
    ...tools.map(tool => field(10, message(field(1, tool.name), field(2, tool.description), field(3,
      JSON.stringify(/^(?:gemini[-_]|MODEL_GOOGLE_GEMINI_)/i.test(uid) ? normalizeDevinGeminiSchema(tool.parameters) : tool.parameters))))));
}

export class DevinChatProvider implements ChatProvider {
  readonly name = 'devin';
  readonly thinkingEffort = null;
  get modelName(): string { return this.config.modelName; }
  constructor(private readonly config: ProtocolAdapterConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async generate(system: string, tools: Tool[], history: Message[], options: GenerateOptions = {}): Promise<StreamedMessage> {
    if (options.responseFormat !== undefined) throw new ChatProviderError('Devin does not support structured response formats.');
    const token = options.auth?.apiKey ?? this.config.apiKey;
    if (!token) throw new ChatProviderError('Devin login required.');
    const baseUrl = options.auth?.baseUrl ?? this.config.baseUrl ?? DEVIN_BASE_URL;
    options.onProtocolProgress?.('start');
    const auth = await devinRequestAuth(token, baseUrl, options.signal, this.fetchImpl);
    const request = await buildDevinRequest(this.config, system, tools, history, options, token, auth.userJwt);
    const response = await this.fetchImpl(auth.baseUrl.replace(/\/+$/, '') + DEVIN_CHAT_PATH, {
      method: 'POST', headers: { ...this.config.defaultHeaders, ...options.auth?.headers,
        'content-type': 'application/connect+proto', 'connect-protocol-version': '1',
        'connect-content-encoding': 'gzip', 'connect-accept-encoding': 'gzip', 'accept-encoding': 'identity',
        'user-agent': 'connect-go/1.18.1 (go1.26.3)' },
      body: new Uint8Array(connectFrame(request, 1)), signal: options.signal,
    });
    options.onRequestSent?.(); options.onProtocolProgress?.('headers');
    if (!response.ok) throw devinHttpError(response);
    if (!response.body) throw new APIIncompleteStreamError('Devin returned an empty stream.');
    const state: { id: string | null; usage: StreamedMessage['usage']; finishReason: StreamedMessage['finishReason']; rawFinishReason: string | null } = { id: null, usage: null, finishReason: null, rawFinishReason: null };
    const config = this.config;
    return {
      get id() { return state.id; }, get usage() { return state.usage; },
      get finishReason() { return state.finishReason; }, get rawFinishReason() { return state.rawFinishReason; },
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamedMessagePart> {
        const reader = response.body!.getReader();
        const decoder = new ConnectDecoder();
        const calls = new Map<string, { name: string; arguments: string; emitted: boolean; index: number }>();
        let activeId: string | undefined;
        let trailer = false;
        let stop = 0;
        let signature = '';
        let contentIndex = 0;
        let contentKind = '';
        try {
          for (;;) {
            const read = await reader.read();
            if (read.value?.length) options.onProtocolProgress?.('body');
            for (const frame of decoder.push(read.value ?? new Uint8Array())) {
              if (trailer) throw new APIProtocolError('Devin sent data after its end-stream trailer.');
              if (frame.flags & 2) { checkTrailer(frame.payload, response.headers); trailer = true; continue; }
              const delta = decode(frame.payload);
              if (text(delta, 1)) state.id = text(delta, 1);
              if (number(delta, 5)) stop = number(delta, 5);
              if (text(delta, 10)) signature += text(delta, 10);
              if (text(delta, 9)) {
                if (contentKind !== 'thinking') { contentIndex++; contentKind = 'thinking'; }
                yield { type: 'think', think: text(delta, 9), _streamIndex: contentIndex };
              }
              if (signature && (text(delta, 3) || children(delta, 6).length || number(delta, 5))) {
                yield { type: 'think', think: '', encrypted: `devin:${JSON.stringify({ model: config.modelName, signature })}`, _streamIndex: contentIndex };
                signature = '';
              }
              if (text(delta, 3)) {
                if (contentKind !== 'text') { contentIndex++; contentKind = 'text'; }
                yield { type: 'text', text: text(delta, 3), _streamIndex: contentIndex };
              }
              for (const tc of children(delta, 6)) {
                const id = text(tc, 1) || activeId;
                if (!id) throw new APIProtocolError('Devin returned tool arguments without a tool call id.');
                activeId = id;
                let call = calls.get(id);
                if (!call) { contentKind = 'tool'; call = { name: '', arguments: '', emitted: false, index: ++contentIndex }; calls.set(id, call); }
                if (text(tc, 2)) call.name = text(tc, 2);
                const previous = call.arguments;
                call.arguments = accumulateDevinArguments(previous, text(tc, 3));
                if (!call.emitted && call.name) {
                  call.emitted = true;
                  yield { type: 'function', id: devinToolId(id), name: call.name, arguments: call.arguments, _streamIndex: call.index };
                } else if (call.emitted && call.arguments.length > previous.length) {
                  yield { type: 'tool_call_part', index: call.index, argumentsPart: call.arguments.slice(previous.length) };
                }
              }
              if (delta.has(7)) {
                const usage = child(delta, 7);
                state.usage = { inputOther: number(usage, 2), output: number(usage, 3), inputCacheCreation: number(usage, 4), inputCacheRead: number(usage, 5) };
              }
            }
            if (read.done) break;
          }
          decoder.finish();
          if (!trailer) throw new APIIncompleteStreamError('Devin stream ended without its Connect end-stream trailer.');
          if (signature) yield { type: 'think', think: '', encrypted: `devin:${JSON.stringify({ model: config.modelName, signature })}`, _streamIndex: contentIndex };
          for (const call of calls.values()) {
            if (!call.emitted) throw new APIProtocolError('Devin tool call has no name.');
            try { JSON.parse(call.arguments || '{}'); } catch { throw new APIProtocolError('Devin tool call arguments are incomplete JSON.'); }
          }
          if (stop === 13) throw new ChatProviderError('Devin reported an upstream generation error.');
          state.rawFinishReason = String(stop);
          state.finishReason = calls.size ? 'tool_calls' : stop === 3 ? 'truncated' : stop === 11 ? 'filtered' : 'completed';
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); options.onStreamEnd?.(); }
      },
    };
  }
}
