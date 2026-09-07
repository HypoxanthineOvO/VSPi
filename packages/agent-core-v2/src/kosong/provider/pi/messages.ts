import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
  Usage,
} from '@earendil-works/pi-ai';

import { ChatProviderError } from '#/kosong/contract/errors';
import type { ContentPart, Message, ToolCall } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { normalizeToolCallIdsForProvider, sanitizeToolCallId } from '#/kosong/provider/bases/tool-call-id';

interface Signature {
  api: string;
  provider: string;
  model: string;
  signature: string;
  redacted?: boolean;
}

export function encodePiSignature(
  model: Pick<AssistantMessage, 'api' | 'provider' | 'model'>,
  signature: string,
  redacted?: boolean,
): string {
  return `pi-signature:${JSON.stringify({ api: model.api, provider: model.provider, model: model.model, signature, redacted })}`;
}

function decodeSignature(value: string | undefined): Signature | undefined {
  if (value === undefined || !value.startsWith('pi-signature:')) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.slice('pi-signature:'.length));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record['api'] !== 'string' ||
      typeof record['provider'] !== 'string' ||
      typeof record['model'] !== 'string' ||
      typeof record['signature'] !== 'string'
    )
      return undefined;
    return {
      api: record['api'],
      provider: record['provider'],
      model: record['model'],
      signature: record['signature'],
      redacted: record['redacted'] === true,
    };
  } catch {
    return undefined;
  }
}

export function emptyPiUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function toLegacyHistory(history: Message[], model: Model<Api>): Message[] {
  return history.map((message) => ({
    ...message,
    content: message.content.map((part) => {
      if (part.type !== 'think') return part;
      const signature = decodeSignature(part.encrypted);
      if (signature === undefined) return part;
      const sameModel =
        signature.api === model.api &&
        signature.provider === model.provider &&
        signature.model === model.id;
      return { ...part, encrypted: sameModel ? signature.signature : undefined };
    }),
    toolCalls: message.toolCalls.map((call) => {
      const value = call.extras?.['thought_signature_b64'];
      const signature = typeof value === 'string' ? decodeSignature(value) : undefined;
      if (signature === undefined) return call;
      const extras = { ...call.extras };
      if (
        signature.api === model.api &&
        signature.provider === model.provider &&
        signature.model === model.id
      )
        extras['thought_signature_b64'] = signature.signature;
      else delete extras['thought_signature_b64'];
      return { ...call, extras };
    }),
  }));
}

async function convertContent(
  content: ContentPart[],
  signal?: AbortSignal,
): Promise<(TextContent | ImageContent)[]> {
  const converted: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (part.type === 'text') converted.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const url = part.imageUrl.url;
      const inline = /^data:(image\/[^;,]+);base64,([\s\S]*)$/.exec(url);
      if (inline !== null) {
        converted.push({ type: 'image', mimeType: inline[1]!, data: inline[2]! });
      } else {
        if (!/^https?:\/\//i.test(url))
          throw new ChatProviderError(
            'Unsupported image URL: expected an image data URL or HTTP(S) URL.',
          );
        const response = await fetch(url, { signal });
        if (!response.ok)
          throw new ChatProviderError(`Image download failed with HTTP ${response.status}.`);
        const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim();
        if (mimeType === undefined || !mimeType.startsWith('image/'))
          throw new ChatProviderError('Image URL did not return an image content type.');
        converted.push({
          type: 'image',
          mimeType,
          data: Buffer.from(await response.arrayBuffer()).toString('base64'),
        });
      }
    } else if (part.type !== 'think') {
      throw new ChatProviderError(`pi-ai does not support ${part.type} content.`);
    }
  }
  return converted;
}

function convertToolCall(call: ToolCall): PiToolCall {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments ?? '{}');
  } catch (error) {
    throw new ChatProviderError(
      `Invalid JSON arguments in historical tool call '${call.name}'.`,
      undefined,
      { cause: error },
    );
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    throw new ChatProviderError(`Arguments for tool '${call.name}' must be an object.`);
  const signature = call.extras?.['thought_signature_b64'];
  return {
    type: 'toolCall',
    id: call.id,
    name: call.name,
    arguments: args as Record<string, unknown>,
    thoughtSignature:
      typeof signature === 'string'
        ? (decodeSignature(signature)?.signature ?? signature)
        : undefined,
    namespace:
      typeof call.extras?.['namespace'] === 'string' ? call.extras['namespace'] : undefined,
  };
}

function convertAssistant(
  message: Message,
  model: Model<Api>,
  timestamp: number,
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  let origin: Signature | undefined;
  for (const part of message.content) {
    if (part.type === 'text') {
      const signature = decodeSignature(part.textSignature);
      origin ??= signature;
      content.push({
        type: 'text',
        text: part.text,
        textSignature: signature?.signature ?? part.textSignature,
      });
    } else if (part.type === 'think') {
      const signature = decodeSignature(part.encrypted);
      origin ??= signature;
      const thinking: ThinkingContent = {
        type: 'thinking',
        thinking: part.think,
        thinkingSignature: signature?.signature ?? part.encrypted,
        redacted: signature?.redacted,
      };
      content.push(thinking);
    } else {
      throw new ChatProviderError(`pi-ai cannot replay assistant ${part.type} content.`);
    }
  }
  for (const call of message.toolCalls) {
    const signature = call.extras?.['thought_signature_b64'];
    if (typeof signature === 'string') origin ??= decodeSignature(signature);
    content.push(convertToolCall(call));
  }
  return {
    role: 'assistant',
    content,
    api: origin?.api ?? model.api,
    provider: origin?.provider ?? model.provider,
    model: origin?.model ?? model.id,
    usage: emptyPiUsage(),
    stopReason: message.toolCalls.length > 0 ? 'toolUse' : 'stop',
    timestamp,
  };
}

export async function toPiContext(
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  model: Model<Api>,
  signal?: AbortSignal,
): Promise<Context> {
  const context: Context = {
    systemPrompt,
    messages: [],
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
  const normalized = model.api === 'openai-completions'
    ? normalizeToolCallIdsForProvider([...history], { normalize: (id) => sanitizeToolCallId(id, 64), maxLength: 64 })
    : history;
  const toolNames = new Map(
    normalized.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)),
  );
  for (const [timestamp, message] of normalized.entries()) {
    if (message.content.length === 0 && message.toolCalls.length === 0 && message.role !== 'tool')
      continue;
    if (message.role === 'system') {
      if (message.content.some((part) => part.type !== 'text'))
        throw new ChatProviderError('System messages must contain only text.');
      context.systemPrompt = [
        context.systemPrompt,
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      ]
        .filter(Boolean)
        .join('\n\n');
    } else if (message.role === 'assistant') {
      context.messages.push(convertAssistant(message, model, timestamp));
    } else if (message.role === 'tool') {
      if (message.toolCallId === undefined)
        throw new ChatProviderError('Historical tool result is missing its tool call ID.');
      context.messages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: message.name ?? toolNames.get(message.toolCallId) ?? 'tool',
        content: await convertContent(message.content, signal),
        isError: false,
        timestamp,
      });
    } else {
      context.messages.push({
        role: 'user',
        content: await convertContent(message.content, signal),
        timestamp,
      });
    }
  }
  return context;
}
