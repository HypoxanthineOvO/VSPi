import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { getBuiltinModel as getModel } from '@earendil-works/pi-ai/providers/all';
import { describe, expect, it, vi } from 'vitest';

import { generate } from '#/kosong/contract/generate';
import type { Message } from '#/kosong/contract/message';
import type { ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import { toPiContext, emptyPiUsage, encodePiSignature } from '#/kosong/provider/pi/messages';
import { PiChatProvider } from '#/kosong/provider/pi/piChatProvider';
import { PiStreamedMessage, convertPiError } from '#/kosong/provider/pi/streamedMessage';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { normalizeThinkingCapability } from '#/kosong/contract/capability';
import { applyModelEffortProfile } from '#/kosong/model/effortProfiles';
import { modelEffortProfile } from '#/kosong/provider/effortProfiles';
import { registerProviderDefinition } from '#/kosong/provider/providerDefinition';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/bases/anthropic/index';
import '#/kosong/provider/providers/standard.contrib';

const model = getModel('openai', 'gpt-4.1');

describe('relay model request encoding', () => {
  it.each([
    ['mimo-v2.5', 'enabled'],
    ['mimo-v2.5-pro', 'enabled'],
    ['MiniMax-M3', 'adaptive'],
  ])('uses the documented thinking switch without a fake effort field for %s', async (modelName, type) => {
    let body: Record<string, unknown> = {};
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON');
      body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response('{"error":{"message":"offline capture"}}', { status: 400 });
    });
    try {
      const record = applyModelEffortProfile({}, modelEffortProfile(modelName)!);
      const provider = new ProtocolAdapterRegistry().createChatProvider({ modelName, protocol: 'openai', providerType: 'openai', baseUrl: 'https://relay.example.test/v1', apiKey: 'YOUR_API_KEY', providerOptions: { relay: true }, thinking: normalizeThinkingCapability(record.thinking), effortMapping: record.effortMapping });
      await expect(generate(provider, 'Example', [], [], undefined, { thinking: { effort: 'on' } })).rejects.toThrow('offline capture');
      expect(body['thinking']).toEqual({ type });
      expect(body).not.toHaveProperty('reasoning_effort');
    } finally { request.mockRestore(); }
  });

  it('enables Qwen 3.8 thinking with its canonical xhigh effort', async () => {
    let body: Record<string, unknown> = {};
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON');
      body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response('{"error":{"message":"offline capture"}}', { status: 400 });
    });
    try {
      const record = applyModelEffortProfile({}, modelEffortProfile('qwen3.8-max')!);
      const provider = new ProtocolAdapterRegistry().createChatProvider({ modelName: 'qwen3.8-max', protocol: 'openai', providerType: 'openai', baseUrl: 'https://relay.example.test/v1', apiKey: 'YOUR_API_KEY', providerOptions: { relay: true }, thinking: normalizeThinkingCapability(record.thinking), effortMapping: record.effortMapping });
      await expect(generate(provider, 'Example', [], [], undefined, { thinking: { effort: 'xhigh' } })).rejects.toThrow('offline capture');
      expect(body).toMatchObject({ enable_thinking: true, reasoning_effort: 'xhigh' });
      expect(body).not.toHaveProperty('thinking_budget');
    } finally { request.mockRestore(); }
  });

  it('sends MEDIUM to Gemini 3.1 Pro instead of mapping it to HIGH', async () => {
    let body: Record<string, unknown> = {};
    const server = createTestHttpServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      body = JSON.parse(raw) as Record<string, unknown>;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":{"code":400,"message":"offline capture","status":"INVALID_ARGUMENT"}}');
    });
    const baseUrl = await listen(server);
    try {
      const record = applyModelEffortProfile({}, modelEffortProfile('gemini-3.1-pro-preview')!);
      const provider = new ProtocolAdapterRegistry().createChatProvider({ modelName: 'gemini-3.1-pro-preview', protocol: 'google-genai', providerType: 'google', baseUrl, apiKey: 'YOUR_API_KEY', providerOptions: { relay: true }, thinking: normalizeThinkingCapability(record.thinking), effortMapping: record.effortMapping });
      await expect(generate(provider, 'Example', [], [{ role: 'user', content: [{ type: 'text', text: 'Example' }], toolCalls: [] }], undefined, { thinking: { effort: 'medium' } })).rejects.toThrow('offline capture');
      expect(body['generationConfig']).toMatchObject({ thinkingConfig: { thinkingLevel: 'MEDIUM' } });
    } finally { await close(server); }
  });

  it.each([
    ['gpt-6-astra', 'openai_responses', '/v1/responses'],
    ['gpt-6-astra', 'openai', '/v1/chat/completions'],
    ['kimi-k3', 'openai', '/v1/chat/completions'],
    ['glm-5.3', 'openai', '/v1/chat/completions'],
    ['deepseek-v4-pro', 'openai', '/v1/chat/completions'],
    ['claude-opus-5', 'anthropic', '/v1/messages'],
  ] as const)('sends the selected effort for %s over %s', async (modelName, protocol, path) => {
    let url = '';
    let body: Record<string, unknown> = {};
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response('{"error":{"message":"offline capture"}}', { status: 400, headers: { 'content-type': 'application/json' } });
    });
    try {
      const provider = new ProtocolAdapterRegistry().createChatProvider({
        modelName, protocol, providerType: 'openai', baseUrl: protocol === 'anthropic' ? 'https://relay.example.test' : 'https://relay.example.test/v1', apiKey: 'YOUR_API_KEY',
        providerOptions: { relay: true },
        thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['high', 'max'], defaultEffort: 'high' },
      });
      await expect(generate(provider, 'Example', [], [], undefined, { thinking: { effort: 'max' } })).rejects.toThrow('offline capture');
      expect(new URL(url).pathname).toBe(path);
      if (protocol === 'openai') expect(body['reasoning_effort']).toBe('max');
      else if (protocol === 'openai_responses') expect(body['reasoning']).toMatchObject({ effort: 'max' });
      else expect((body['messages'] as Array<Record<string, unknown>>).at(-1)).toMatchObject({ role: 'system', output_config: { effort: 'max' } });
    } finally { request.mockRestore(); }
  });
});

function createTestHttpServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Server {
  return createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
  });
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyPiUsage(),
    stopReason: 'stop',
    timestamp: 0,
  };
}

function source(events: AssistantMessageEvent[]): PiStreamedMessage {
  const input = createAssistantMessageEventStream();
  for (const event of events) input.push(event);
  input.end();
  const controller = new AbortController();
  return new PiStreamedMessage(input, controller, controller.signal, {});
}

async function collect(events: AssistantMessageEvent[]) {
  return generate(
    {
      name: 'example',
      modelName: model.id,
      thinkingEffort: null,
      generate: async () => source(events),
    },
    '',
    [],
    [],
  );
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    }),
  );
}

describe('PiChatProvider stream conversion', () => {
  it('keeps unsigned and signed adjacent blocks separate and removes streaming indices', async () => {
    const message = assistant([
      { type: 'text', text: 'unsigned' },
      { type: 'text', text: 'signed', textSignature: 'sig' },
    ]);
    const result = await collect([
      { type: 'text_delta', contentIndex: 0, delta: 'unsigned', partial: message },
      { type: 'text_end', contentIndex: 0, content: 'unsigned', partial: message },
      { type: 'text_delta', contentIndex: 1, delta: 'signed', partial: message },
      { type: 'text_end', contentIndex: 1, content: 'signed', partial: message },
      { type: 'done', reason: 'stop', message },
    ]);
    expect(result.message.content).toEqual([
      { type: 'text', text: 'unsigned' },
      { type: 'text', text: 'signed', textSignature: encodePiSignature(message, 'sig') },
    ]);
    expect(result.message.content.every((part) => !('_streamIndex' in part))).toBe(true);
  });

  it('rejects a safety-filtered stream without classifying it as retryable generation failure', async () => {
    const message = assistant([]);
    message.errorMessage = 'Response blocked';
    message.rawStopReason = 'SAFETY';
    message.stopReason = 'error';
    await expect(
      collect([{ type: 'error', reason: 'error', error: message }]),
    ).rejects.toMatchObject({ code: 'provider.filtered', rawFinishReason: 'SAFETY' });
  });
  it('preserves text, thinking and tool signatures without duplicating deltas', async () => {
    const tool = {
      type: 'toolCall' as const,
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'example.txt' },
      thoughtSignature: 'tool-signature',
    };
    const message = assistant([
      { type: 'thinking', thinking: 'reason', thinkingSignature: 'thinking-signature' },
      { type: 'text', text: 'answer', textSignature: 'text-signature' },
      tool,
    ]);
    message.responseId = 'response_1';
    message.usage = {
      ...emptyPiUsage(),
      input: 20,
      output: 5,
      cacheRead: 10,
      cacheWrite: 3,
      totalTokens: 38,
    };
    const result = await collect([
      { type: 'start', partial: message },
      { type: 'thinking_delta', contentIndex: 0, delta: 'reason', partial: message },
      { type: 'thinking_end', contentIndex: 0, content: 'reason', partial: message },
      { type: 'text_delta', contentIndex: 1, delta: 'answer', partial: message },
      { type: 'text_end', contentIndex: 1, content: 'answer', partial: message },
      { type: 'toolcall_start', contentIndex: 2, partial: message },
      { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":', partial: message },
      { type: 'toolcall_delta', contentIndex: 2, delta: '"example.txt"}', partial: message },
      { type: 'toolcall_end', contentIndex: 2, toolCall: tool, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    expect(result.id).toBe('response_1');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({
      inputOther: 20,
      output: 5,
      inputCacheRead: 10,
      inputCacheCreation: 3,
    });
    expect(result.message.content).toEqual([
      {
        type: 'think',
        think: 'reason',
        encrypted: encodePiSignature(message, 'thinking-signature'),
      },
      { type: 'text', text: 'answer', textSignature: encodePiSignature(message, 'text-signature') },
    ]);
    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"example.txt"}',
        extras: { thought_signature_b64: encodePiSignature(message, 'tool-signature') },
      },
    ]);
    const replay = await toPiContext(
      '',
      [],
      [result.message],
      getModel('anthropic', 'claude-sonnet-4-6'),
    );
    expect(replay.messages[0]).toMatchObject({
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: message.content,
    });
  });

  it('reconstructs end-only tools and does not repeat signed content at done', async () => {
    const tool = { type: 'toolCall' as const, id: 'call_1', name: 'read', arguments: {} };
    const message = assistant([
      { type: 'text', text: 'first', textSignature: 'a' },
      { type: 'text', text: 'second', textSignature: 'b' },
      tool,
    ]);
    const result = await collect([
      { type: 'text_end', contentIndex: 0, content: 'first', partial: message },
      { type: 'text_end', contentIndex: 1, content: 'second', partial: message },
      { type: 'toolcall_end', contentIndex: 2, toolCall: tool, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    expect(result.message.content).toHaveLength(2);
    expect(result.message.toolCalls[0]?.arguments).toBe('{}');
  });

  it('routes interleaved tool arguments to their own calls', async () => {
    const first = { type: 'toolCall' as const, id: 'call_a', name: 'a', arguments: { a: 1 } };
    const second = { type: 'toolCall' as const, id: 'call_b', name: 'b', arguments: { b: 2 } };
    const message = assistant([first, second]);
    const result = await collect([
      { type: 'toolcall_start', contentIndex: 0, partial: message },
      { type: 'toolcall_start', contentIndex: 1, partial: message },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"a":', partial: message },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"b":2}', partial: message },
      { type: 'toolcall_delta', contentIndex: 0, delta: '1}', partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    expect(result.message.toolCalls.map((call) => call.arguments)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('rejects truncated streams and incomplete tool argument JSON', async () => {
    await expect(collect([])).rejects.toMatchObject({ code: 'provider.connection_error' });
    const tool = { type: 'toolCall' as const, id: 'call_1', name: 'read', arguments: {} };
    const message = assistant([tool]);
    await expect(
      collect([
        { type: 'toolcall_delta', contentIndex: 0, delta: '{', partial: message },
        { type: 'done', reason: 'toolUse', message },
      ]),
    ).rejects.toThrow('incomplete arguments');
  });

  it('aborts while awaiting the next provider event', async () => {
    const events = createAssistantMessageEventStream();
    const controller = new AbortController();
    const stream = new PiStreamedMessage(events, controller, controller.signal, {});
    const next = stream[Symbol.asyncIterator]().next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    events.end();
  });
});

describe('PiChatProvider message conversion', () => {
  it('preserves image input, tool names, empty tool outputs and system instructions', async () => {
    const history: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'system history' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AA==' } }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'read', arguments: '{}' }],
      },
      { role: 'tool', content: [], toolCalls: [], toolCallId: 'call_1' },
    ];
    const context = await toPiContext(
      'system',
      [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
      history,
      model,
    );
    expect(context.systemPrompt).toBe('system\n\nsystem history');
    expect(context.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }],
    });
    expect(context.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [],
    });
    expect(context.tools?.[0]?.parameters).toEqual({ type: 'object' });
  });

  it('preserves redacted thinking and rejects unsupported media explicitly', async () => {
    const message = assistant([
      { type: 'thinking', thinking: '', thinkingSignature: 'redacted', redacted: true },
      { type: 'text', text: 'safe' },
    ]);
    const result = await collect([{ type: 'done', reason: 'stop', message }]);
    const context = await toPiContext('', [], [result.message], model);
    expect(context.messages[0]).toMatchObject({
      content: [
        { type: 'thinking', thinking: '', thinkingSignature: 'redacted', redacted: true },
        { type: 'text', text: 'safe' },
      ],
    });
    await expect(
      toPiContext(
        '',
        [],
        [
          {
            role: 'user',
            content: [{ type: 'video_url', videoUrl: { url: 'ms://example' } }],
            toolCalls: [],
          },
        ],
        model,
      ),
    ).rejects.toThrow('does not support video_url');
  });
});

describe('PiChatProvider real transport', () => {
  it.each(['openai', 'openai_responses', 'anthropic', 'google-genai'] as const)(
    'does not retry HTTP429 internally for %s',
    async (protocol) => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
        response.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Too many requests',
              type: 'rate_limit_error',
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
        );
      });
      const baseUrl = await listen(server);
      try {
        const provider = new ProtocolAdapterRegistry().createChatProvider({
          protocol,
          modelName: 'example',
          apiKey: 'YOUR_API_KEY',
          baseUrl,
        });
        await expect(
          generate(
            provider,
            '',
            [],
            [{ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] }],
          ),
        ).rejects.toMatchObject({ statusCode: 429, code: 'provider.rate_limit' });
        expect(requests).toBe(1);
      } finally {
        await close(server);
      }
    },
  );

  it('routes ordinary Kimi requests through pi-ai and retains Kimi wire parameters', async () => {
    let body: Record<string, unknown> | undefined;
    const server = createTestHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            type: 'exceeded_current_quota_error',
            message: 'Insufficient balance, please recharge your account',
          },
        }),
      );
    });
    const baseUrl = await listen(server);
    try {
      const provider = new ProtocolAdapterRegistry().createChatProvider({
        protocol: 'openai',
        providerType: 'kimi',
        modelName: 'kimi-k2',
        apiKey: 'YOUR_API_KEY',
        baseUrl,
      });
      expect(provider).toBeInstanceOf(PiChatProvider);
      await expect(
        generate(
          provider,
          '',
          [
            {
              name: 'read',
              description: 'Read',
              parameters: {
                $defs: { path: { type: 'string' } },
                type: 'object',
                properties: { path: { $ref: '#/$defs/path' } },
              },
            },
          ],
          [{ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] }],
          undefined,
          {
            thinking: { effort: 'high', keep: 'all' },
            cacheKey: 'example-session',
            maxCompletionTokens: 5000,
          },
        ),
      ).rejects.toMatchObject({ name: 'APIProviderQuotaExhaustedError' });
      expect(body).toMatchObject({
        thinking: { type: 'enabled', effort: 'high', keep: 'all' },
        prompt_cache_key: 'example-session',
        max_completion_tokens: 5000,
        tools: [
          {
            type: 'function',
            function: {
              name: 'read',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
      });
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('extra_body');
    } finally {
      await close(server);
    }
  });

  it('delegates proprietary Kimi media without silently losing its content', async () => {
    const finalMessage = source([
      { type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: 'ok' }]) },
    ]);
    const legacy = {
      name: 'legacy',
      modelName: 'kimi-k2.5',
      thinkingEffort: null,
      generate: vi.fn().mockResolvedValue(finalMessage),
      uploadVideo: vi
        .fn()
        .mockResolvedValue({ type: 'video_url', videoUrl: { url: 'ms://example' } }),
    };
    const provider = new PiChatProvider(
      { protocol: 'openai', providerType: 'kimi', modelName: 'kimi-k2.5' },
      undefined,
      legacy,
    );
    const history: Message[] = [
      {
        role: 'user',
        content: [{ type: 'video_url', videoUrl: { url: 'ms://example' } }],
        toolCalls: [],
      },
    ];
    expect(await provider.generate('', [], history)).toBe(finalMessage);
    expect(legacy.generate).toHaveBeenCalledWith('', [], history, {});
    await expect(
      provider.uploadVideo({ data: new Uint8Array([0]), mimeType: 'video/mp4' }),
    ).resolves.toEqual({ type: 'video_url', videoUrl: { url: 'ms://example' } });
  });

  it('merges trait, config and request headers and honors OAuth header removals', async () => {
    registerProviderDefinition({
      id: 'example-pi-headers',
      baseProtocol: 'openai',
      traits: [
        {
          defaultHeaders: () => ({
            'x-example': 'trait',
            'x-trait': 'retained',
            'x-remove': 'remove',
          }),
        },
      ],
    });
    let headers: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      headers = request.headers;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Example authorization failure' } }));
    });
    const baseUrl = await listen(server);
    try {
      const provider = new ProtocolAdapterRegistry().createChatProvider({
        protocol: 'openai',
        providerType: 'example-pi-headers',
        modelName: 'example',
        apiKey: 'YOUR_API_KEY',
        baseUrl,
        defaultHeaders: { 'x-example': 'config', 'X-Remove': 'remove' },
      });
      await expect(
        generate(provider, '', [], [], undefined, {
          auth: { headers: { 'x-example': 'request' }, removeHeaders: ['x-remove'] },
        }),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(headers).toMatchObject({ 'x-example': 'request', 'x-trait': 'retained' });
      expect(headers).not.toHaveProperty('x-remove');
    } finally {
      await close(server);
    }
  });
  it('maps HTTP 401 through pi-ai to Core auth errors', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }),
      );
    });
    const baseUrl = await listen(server);
    try {
      const provider = new PiChatProvider({
        protocol: 'openai',
        modelName: 'custom',
        apiKey: 'YOUR_API_KEY',
        baseUrl,
      });
      await expect(generate(provider, '', [], [])).rejects.toMatchObject({
        code: 'provider.auth_error',
        statusCode: 401,
      });
    } finally {
      await close(server);
    }
  });

  it.each(['high', 'custom-effort'])(
    'sends request parameters and %s effort through pi-ai',
    async (effort) => {
      const requests: { body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
      const server = createTestHttpServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
          headers: request.headers,
        });
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-trace-id': 'trace-example',
        });
        response.end(
          `data: ${JSON.stringify({ id: 'response_1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
        );
      });
      const baseUrl = await listen(server);
      try {
        const reasoningModel = {
          ...model,
          api: 'openai-completions' as const,
          reasoning: true,
          thinkingLevelMap: { high: 'mapped-high' },
        };
        const provider = new PiChatProvider(
          {
            protocol: 'openai',
            modelName: 'custom',
            apiKey: 'old-key',
            defaultHeaders: { 'x-example': 'default' },
            baseUrl,
          },
          reasoningModel,
        );
        const onRequestSent = vi.fn();
        const onTraceId = vi.fn();
        const result = await generate(
          provider,
          'system',
          [],
          [{ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] }],
          undefined,
          {
            thinking: { effort },
            auth: { apiKey: 'YOUR_API_KEY', headers: { 'x-example': 'request' } },
            sampling: { temperature: 0.2, topP: 0.7 },
            maxCompletionTokens: 123,
            responseFormat: {
              type: 'json_schema',
              jsonSchema: { name: 'result', schema: { type: 'object' }, strict: true },
            },
            onRequestSent,
            onTraceId,
          },
        );
        expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
        expect(result.usage).toEqual({
          inputOther: 4,
          output: 2,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        });
        expect(requests[0]?.body).toMatchObject({
          model: 'custom',
          temperature: 0.2,
          top_p: 0.7,
          max_completion_tokens: 123,
          reasoning_effort: effort === 'high' ? 'mapped-high' : 'custom-effort',
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'result', schema: { type: 'object' }, strict: true },
          },
        });
        expect(requests[0]?.headers).toMatchObject({
          authorization: 'Bearer YOUR_API_KEY',
          'x-example': 'request',
        });
        expect(onRequestSent).toHaveBeenCalledOnce();
        expect(onTraceId).toHaveBeenCalledWith('trace-example');
      } finally {
        await close(server);
      }
    },
  );

  it('preserves retryable HTTP error classes', () => {
    expect(convertPiError('429 Too many requests')).toMatchObject({
      code: 'provider.rate_limit',
      statusCode: 429,
    });
    expect(convertPiError('400 context length exceeded')).toMatchObject({
      code: 'context.overflow',
      statusCode: 400,
    });
    expect(convertPiError(new DOMException('cancelled', 'AbortError'))).toMatchObject({
      name: 'AbortError',
    });
    expect(convertPiError('Provider finish_reason: content_filter')).toMatchObject({
      code: 'provider.filtered',
      finishReason: 'filtered',
    });
  });

  it.each([
    {
      protocol: 'openai_responses',
      model: getModel('openai', 'gpt-5.4'),
      expected: {
        top_p: 0.7,
        text: {
          format: { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true },
        },
      },
    },
    {
      protocol: 'anthropic',
      model: getModel('anthropic', 'claude-sonnet-4-6'),
      expected: {
        top_p: 0.7,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: { type: 'object' } },
        },
      },
    },
    {
      protocol: 'google-genai',
      model: getModel('google', 'gemini-3.1-pro-preview'),
      expected: {
        generationConfig: {
          topP: 0.7,
          responseMimeType: 'application/json',
          responseJsonSchema: { type: 'object' },
        },
      },
    },
  ] as const)(
    'maps structured output and sampling for $protocol',
    async ({ protocol, model: selectedModel, expected }) => {
      const bodies: Record<string, unknown>[] = [];
      const server = createTestHttpServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Example validation error',
              type: 'invalid_request_error',
              status: 'INVALID_ARGUMENT',
            },
          }),
        );
      });
      const baseUrl = await listen(server);
      try {
        const provider = new PiChatProvider(
          { protocol, modelName: selectedModel.id, apiKey: 'YOUR_API_KEY', baseUrl },
          selectedModel,
        );
        await expect(
          generate(
            provider,
            'system',
            [],
            [{ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] }],
            undefined,
            {
              thinking: { effort: 'medium' },
              sampling: { topP: 0.7 },
              responseFormat: {
                type: 'json_schema',
                jsonSchema: { name: 'result', schema: { type: 'object' }, strict: true },
              },
            },
          ),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject(expected);
      } finally {
        await close(server);
      }
    },
  );

  it('uses effective image and effort overrides and the current auth endpoint', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createTestHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'Example validation error', type: 'invalid_request_error' },
        }),
      );
    });
    const baseUrl = await listen(server);
    try {
      const config: ProtocolAdapterConfig = {
        protocol: 'openai',
        modelName: 'custom',
        baseUrl: 'https://example.invalid/v1',
        capabilities: {
          image_in: true,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 10000,
        },
        thinking: {
          availability: 'dynamic',
          canDisable: true,
          controls: ['effort', 'toggle'],
          efforts: ['xhigh'],
          defaultEffort: 'xhigh',
        },
      };
      const provider = new PiChatProvider(config, {
        ...model,
        api: 'openai-completions',
        input: ['text'],
        reasoning: false,
      });
      await expect(
        generate(
          provider,
          '',
          [],
          [
            {
              role: 'user',
              content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AA==' } }],
              toolCalls: [],
            },
          ],
          undefined,
          { auth: { apiKey: 'YOUR_API_KEY', baseUrl }, thinking: { effort: 'on' } },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(bodies[0]?.['reasoning_effort']).toBe('xhigh');
      expect(bodies[0]?.['messages']).toEqual([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
        },
      ]);
    } finally {
      await close(server);
    }
  });
});
