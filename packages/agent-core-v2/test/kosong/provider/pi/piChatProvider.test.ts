import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { getBuiltinModel as getModel } from '@earendil-works/pi-ai/providers/all';
import { describe, expect, it, vi } from 'vitest';

import { generate } from '#/kosong/contract/generate';
import { classifyApiError, isTransientGenerateError, isRetryableGenerateError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type { ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import { toPiContext, emptyPiUsage, encodePiSignature } from '#/kosong/provider/pi/messages';
import { PiChatProvider } from '#/kosong/provider/pi/piChatProvider';
import { PiStreamedMessage, convertPiError } from '#/kosong/provider/pi/streamedMessage';
import { ResponseDiagnostics } from '#/kosong/provider/pi/responseDiagnostics';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { normalizeThinkingCapability } from '#/kosong/contract/capability';
import { applyModelEffortProfile } from '#/kosong/model/effortProfiles';
import { modelEffortProfile } from '#/kosong/provider/effortProfiles';
import { registerProviderDefinition } from '#/kosong/provider/providerDefinition';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/bases/anthropic/index';

describe('bounded SSE event validation', () => {
  it('classifies EOF from protocol state even when the SDK changes its error wording', () => {
    const diagnostics = new ResponseDiagnostics('anthropic');
    diagnostics.headers(new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
    diagnostics.receive(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n'));
    diagnostics.end();
    expect(convertPiError(new Error('SDK-specific new failure wording'), { diagnostics })).toMatchObject({ code: 'provider.incomplete_stream' });
  });
  it.each(['openai', 'openai_responses', 'anthropic'] as const)('classifies malformed %s SSE before the SDK can log raw data', async protocol => {
    const rawError = vi.spyOn(console, 'error');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'example-request' });
      response.end('data: {"private-output"\ndata: }\n\n');
    });
    const baseUrl = await listen(server);
    try {
      const provider = new PiChatProvider({ protocol, modelName: 'example-model', apiKey: 'YOUR_API_KEY', baseUrl });
      const error = await generate(provider, '', [], []).catch(error => error);
      expect(error).toMatchObject({ code: 'provider.stream_parse_error', details: { requestId: 'example-request', parseStage: 'sse_event', parseFailure: 'invalid_json', eventIndex: 1 } });
      expect(isTransientGenerateError(error)).toBe(true);
      expect(JSON.stringify(error)).not.toContain('private-output');
      expect(rawError).not.toHaveBeenCalled();
    } finally { rawError.mockRestore(); await close(server); }
  });

  it.each(['\n', '\r\n', '\r'])('accepts multi-line event JSON across byte boundaries with %j line endings', newline => {
    const diagnostics = new ResponseDiagnostics('openai');
    diagnostics.headers(new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const body = [': keepalive', 'event: message', 'data: {', 'data: "choices":[{"delta":{"content":"中文"},"finish_reason":null}]}', '', 'data: [DONE]', '', ''].join(newline);
    for (const byte of Buffer.from(body)) diagnostics.receive(Buffer.from([byte]));
    diagnostics.end();
    expect(diagnostics.parseFailure).toBeUndefined();
    expect(diagnostics.snapshot()).toMatchObject({ observedFormat: 'openai', eventIndex: 2 });
  });

  it('does not parse an unfinished event at EOF as a complete JSON event', () => {
    const diagnostics = new ResponseDiagnostics('openai');
    diagnostics.headers(new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
    diagnostics.receive(Buffer.from('data: {"incomplete"'));
    diagnostics.end();
    expect(diagnostics.parseFailure).toBeUndefined();
    expect(diagnostics.snapshot()).toHaveProperty('eventIndex', 0);
  });

  it('honors the terminal DONE marker without parsing trailing data as another event', () => {
    const diagnostics = new ResponseDiagnostics('openai');
    diagnostics.headers(new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
    diagnostics.receive(Buffer.from('data: [DONE]\n\ndata: {"trailing"}\n\n'));
    expect(diagnostics.parseFailure).toBeUndefined();
    expect(diagnostics.snapshot()).toHaveProperty('eventIndex', 1);
  });

  it('detects malformed events after the diagnostic sample budget is exhausted', () => {
    const diagnostics = new ResponseDiagnostics('openai');
    diagnostics.headers(new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
    diagnostics.receive(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(100000) } }] })}\n\n`));
    expect(() => diagnostics.receive(Buffer.from('data: {"broken"}\n\n'))).toThrow('invalid JSON');
    expect(diagnostics.snapshot()).toMatchObject({ eventIndex: 2, sampledBytes: 65536, parseFailure: 'invalid_json' });
  });

  it('rejects an oversized event without retaining its raw contents', () => {
    const diagnostics = new ResponseDiagnostics('openai');
    diagnostics.headers(new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
    expect(() => diagnostics.receive(Buffer.from(`data: "${'x'.repeat(4 * 1024 * 1024)}`))).toThrow('byte limit');
    expect(diagnostics.snapshot()).toMatchObject({ parseFailure: 'event_too_large', eventLimitBytes: 4 * 1024 * 1024 });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('xxx');
  });
});
import '#/kosong/provider/providers/standard.contrib';

const model = getModel('openai', 'gpt-4.1');

describe('Chat system role compatibility behind a custom relay', () => {
  it.each(['deepseek-flash', 'deepseek-v4.1-flash', 'kimi-k3', 'k3-256k', 'kimi-for-coding', 'glm-5.3', 'example-reasoner'])(
    'completes %s against a strict Chat upstream using system instead of developer', async modelName => {
      let received: Record<string, unknown> = {};
      const server = createTestHttpServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        received = JSON.parse(Buffer.concat(chunks).toString());
        const messages = received['messages'] as Array<{ role: string }>;
        if (messages.some(message => message.role === 'developer')) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: "role 'developer' is not allowed", type: 'invalid_request_error' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
      const baseUrl = await listen(server);
      try {
        const provider = new ProtocolAdapterRegistry().createChatProvider({
          protocol: 'openai', providerType: 'example-relay', modelName, baseUrl,
          apiKey: 'YOUR_API_KEY', providerOptions: { relay: true },
          thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['high'] },
        });
        const result = await generate(provider, 'Keep these instructions.', [], [{ role: 'user', content: [{ type: 'text', text: 'ping' }], toolCalls: [] }]);
        expect(result.message.content).toContainEqual({ type: 'text', text: 'pong' });
        expect(received['messages']).toEqual([
          { role: 'system', content: 'Keep these instructions.' },
          { role: 'user', content: [{ type: 'text', text: 'ping' }] },
        ]);
      } finally { await close(server); }
    },
  );

  it('preserves developer for an identified GPT reasoning model on Chat', async () => {
    let body: Record<string, unknown> = {};
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
      body = JSON.parse(init.body);
      throw new Error('offline capture');
    });
    try {
      const provider = new ProtocolAdapterRegistry().createChatProvider({
        protocol: 'openai', providerType: 'example-relay', modelName: 'gpt-5.6',
        baseUrl: 'https://relay.example.test/v1', apiKey: 'YOUR_API_KEY', providerOptions: { relay: true },
        thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['high'] },
      });
      await expect(generate(provider, 'Keep these instructions.', [], [])).rejects.toThrow('Connection error');
      expect(body['messages']).toContainEqual({ role: 'developer', content: 'Keep these instructions.' });
    } finally { request.mockRestore(); }
  });
});

describe('DeepSeek relay history', () => {
  it.each(['deepseek-flash', 'deepseek-v4.1-flash'])(
    'returns empty reasoning_content for an earlier assistant without thinking on %s', async modelName => {
      let received: Record<string, unknown> = {};
      const server = createTestHttpServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        received = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
      const baseUrl = await listen(server);
      try {
        const provider = new ProtocolAdapterRegistry().createChatProvider({
          protocol: 'openai', providerType: 'example-relay', modelName, baseUrl,
          apiKey: 'YOUR_API_KEY', providerOptions: { relay: true },
          thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['high'] },
        });
        await generate(provider, '', [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }], [
          { role: 'assistant', content: [{ type: 'text', text: 'Earlier response' }], toolCalls: [] },
          { role: 'user', content: [{ type: 'text', text: 'Continue' }], toolCalls: [] },
        ], undefined, { thinking: { effort: 'high' } });
        const messages = received['messages'] as Array<Record<string, unknown>>;
        expect(messages[0]).toMatchObject({ role: 'assistant', reasoning_content: '' });
      } finally { await close(server); }
    },
  );

  it.each(['deepseek-flash', 'deepseek-v4.1-flash'])(
    'returns the full reasoning_content after a tool call on the next %s request', async modelName => {
      const requests: Array<Record<string, unknown>> = [];
      const server = createTestHttpServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = requests.length === 1
          ? {
              role: 'assistant',
              reasoning_content: 'Need the lookup result.',
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
            }
          : { role: 'assistant', content: 'Done.' };
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
      const baseUrl = await listen(server);
      try {
        const provider = new ProtocolAdapterRegistry().createChatProvider({
          protocol: 'openai', providerType: 'example-relay', modelName, baseUrl,
          apiKey: 'YOUR_API_KEY', providerOptions: { relay: true },
          thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['high'] },
        });
        const tools = [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }];
        const user: Message = { role: 'user', content: [{ type: 'text', text: 'Look this up' }], toolCalls: [] };
        const first = await generate(provider, '', tools, [user], undefined, { thinking: { effort: 'high' } });
        expect(first.message.toolCalls).toMatchObject([{ id: 'call_1', name: 'lookup' }]);
        await generate(provider, '', tools, [
          user,
          first.message,
          { role: 'tool', name: 'lookup', toolCallId: 'call_1', content: [{ type: 'text', text: 'Found it' }], toolCalls: [] },
        ], undefined, { thinking: { effort: 'high' } });
        const messages = requests[1]?.['messages'] as Array<Record<string, unknown>>;
        expect(messages[1]).toMatchObject({ role: 'assistant', reasoning_content: 'Need the lookup result.' });
      } finally { await close(server); }
    },
  );
});

describe('provider response diagnosis', () => {
  it.each([
    ['glm-5.3', 429, '1113', 'quota_exhausted', false],
    ['glm-5.3', 429, '1309', 'quota_exhausted', false],
    ['glm-5.3', 429, '1310', 'quota_exhausted', false],
    ['glm-5.3', 429, '1311', 'auth', false],
    ['glm-5.3', 429, '1302', 'rate_limit', true],
    ['glm-5.3', 429, '1305', 'overloaded', true],
    ['glm-5.3', 400, '1261', 'context_overflow', false],
    ['glm-5.3', 400, '1301', 'filtered', false],
    ['kimi-k3', 429, 'exceeded_current_quota_error', 'quota_exhausted', false],
    ['kimi-k3', 429, 'rate_limit_reached_error', 'rate_limit', true],
    ['deepseek-flash', 402, 'insufficient_balance', 'quota_exhausted', false],
    ['deepseek-flash', 503, 'server_error', '5xx_server', true],
    ['gpt-4.1', 429, 'insufficient_quota', 'quota_exhausted', false],
    ['qwen3.8-max', 429, 'insufficient_quota', 'rate_limit', true],
    ['minimax-m3', 429, '1008', 'quota_exhausted', false],
    ['minimax-m3', 429, '1002', 'rate_limit', true],
  ] as const)('classifies %s business code %s/%s through a relay', async (modelName, status, code, kind, transient) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code, type: code, message: 'Provider business failure' } }));
    });
    const baseUrl = await listen(server);
    try {
      const provider = new PiChatProvider({ protocol: 'openai', providerType: 'example-relay', modelName, apiKey: 'YOUR_API_KEY', baseUrl });
      const error = await generate(provider, '', [], []).catch(error => error);
      expect(classifyApiError(error).kind).toBe(kind);
      expect(isTransientGenerateError(error)).toBe(transient);
    } finally { await close(server); }
  });

  it.each([
    ['anthropic', 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-example","role":"assistant","content":[],"model":"example","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'],
    ['openai_responses', 'data: {"type":"response.created","response":{"id":"resp-example","status":"in_progress","output":[]}}\n\n'],
  ] as const)('retries %s streams missing the terminal event', async (protocol, body) => {
    const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(body); });
    const baseUrl = await listen(server);
    try {
      const error = await generate(new PiChatProvider({ protocol, modelName: 'example', apiKey: 'YOUR_API_KEY', baseUrl }), '', [], []).catch(error => error);
      expect(error).toMatchObject({ code: 'provider.incomplete_stream' });
      expect(isTransientGenerateError(error)).toBe(true);
    } finally { await close(server); }
  });

  it.each([
    ['anthropic', 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'],
    ['openai_responses', 'data: {"type":"response.failed","response":{"id":"resp-example","status":"failed","error":{"code":"server_error","message":"Internal error"}}}\n\n'],
  ] as const)('retries structured transient failures after HTTP 200 on %s', async (protocol, body) => {
    const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(body); });
    const baseUrl = await listen(server);
    try {
      const error = await generate(new PiChatProvider({ protocol, modelName: 'example', apiKey: 'YOUR_API_KEY', baseUrl }), '', [], []).catch(error => error);
      expect(isTransientGenerateError(error)).toBe(true);
      expect(error.details).toMatchObject({ statusCode: 200 });
    } finally { await close(server); }
  });
  it('classifies an upstream interruption after streamed content as recoverable', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'example-interruption' });
      response.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ error: { message: 'Upstream response stream was interrupted', type: 'upstream_error' } })}`,
        '',
      ].join('\n\n'));
    });
    const baseUrl = await listen(server);
    try {
      const provider = new ProtocolAdapterRegistry().createChatProvider({ protocol: 'openai', providerType: 'openai', modelName: 'glm-5.3-flash', apiKey: 'YOUR_API_KEY', baseUrl });
      const error = await generate(provider, '', [], []).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'provider.incomplete_stream', details: { statusCode: 200, requestId: 'example-interruption' } });
      expect(isTransientGenerateError(error)).toBe(true);
    } finally { await close(server); }
  });

  it.each([400, 401, 403])('keeps HTTP %s non-recoverable despite interruption wording', status => {
    const error = convertPiError(new Error('Upstream response stream was interrupted'), { status });
    expect(error).toMatchObject({ statusCode: status });
    expect(isTransientGenerateError(error)).toBe(false);
  });

  it('does not retry arbitrary provider errors mentioning interrupted work', () => {
    expect(isTransientGenerateError(convertPiError('Tool validation interrupted by invalid arguments', { status: 200 }))).toBe(false);
  });

  it.each([
    ['responses events', 'text/event-stream', 'data: {"type":"response.output_text.delta","delta":"private-output"}\n\n', 'openai_responses'],
    ['anthropic events', 'text/event-stream', 'data: {"type":"message_start","message":{"role":"assistant"}}\n\n', 'anthropic'],
    ['HTML page', 'text/html', '<!doctype html><html>private-output</html>', 'html'],
    ['non-streaming JSON', 'application/json', '{"choices":[{"message":{"content":"private-output"},"finish_reason":"stop"}]}', 'non_streaming_json'],
  ])('rejects %s returned to a Chat request without transient retries', async (_name, contentType, body, format) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': contentType });
      response.end(body);
    });
    const baseUrl = await listen(server);
    try {
      const provider = new PiChatProvider({ protocol: 'openai', modelName: 'example-model', apiKey: 'YOUR_API_KEY', baseUrl });
      const error: unknown = await generate(provider, '', [], []).then(() => { throw new Error('Expected rejection'); }, error => error);
      expect(error).toMatchObject({ code: 'provider.protocol_error', details: { expectedProtocol: 'openai', observedFormat: format, statusCode: 200 } });
      expect(isTransientGenerateError(error)).toBe(false);
      expect(isRetryableGenerateError(error)).toBe(false);
      expect(JSON.stringify(error)).not.toContain('private-output');
      expect(JSON.stringify(error)).not.toContain('YOUR_API_KEY');
    } finally { await close(server); }
  });

  it('bounds structural sampling when a large Chat stream ends without a finish reason', async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'private-output'.repeat(100000) }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(body);
    });
    const baseUrl = await listen(server);
    try {
      const provider = new PiChatProvider({ protocol: 'openai', modelName: 'example-model', apiKey: 'YOUR_API_KEY', baseUrl });
      const error: unknown = await generate(provider, '', [], []).catch(error => error);
      expect(error).toMatchObject({ code: 'provider.incomplete_stream', details: { expectedProtocol: 'openai', sampledBytes: 65536, bytesReceived: Buffer.byteLength(body) } });
      expect(isTransientGenerateError(error)).toBe(true);
      expect(JSON.stringify(error)).not.toContain('private-output');
    } finally { await close(server); }
  });

  it('preserves HTTP authentication errors even when the body is HTML', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'text/html' });
      response.end('<html><title>Unauthorized</title></html>');
    });
    const baseUrl = await listen(server);
    try {
      const provider = new PiChatProvider({ protocol: 'openai', modelName: 'example-model', apiKey: 'YOUR_API_KEY', baseUrl });
      await expect(generate(provider, '', [], [])).rejects.toMatchObject({ code: 'provider.auth_error', statusCode: 401 });
    } finally { await close(server); }
  });
});

describe('Kimi tool schemas behind a Chat relay', () => {
  const parameters = {
    type: 'object',
    properties: { parent: { anyOf: [{ $ref: '#/$defs/page' }, { type: 'null' }] } },
    $defs: { page: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] } },
  };

  it.each([
    { modelName: 'kimi-k3', reasoningKey: undefined },
    { modelName: 'example/k3-256k', reasoningKey: undefined },
    { modelName: 'kimi-k3', reasoningKey: 'reasoning_content' },
  ])('normalizes tool references for $modelName with reasoningKey=$reasoningKey', async ({ modelName, reasoningKey }) => {
    let received: Record<string, unknown> = {};
    const server = createTestHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    const baseUrl = await listen(server);
    try {
      const provider = new ProtocolAdapterRegistry().createChatProvider({ protocol: 'openai', providerType: 'openai', modelName, baseUrl, apiKey: 'YOUR_API_KEY', providerOptions: { reasoningKey } });
      const original = structuredClone(parameters);
      await generate(provider, '', [{ name: 'example_create_page', description: 'Example page tool', parameters }], []);
      expect(received['tools']).toMatchObject([{ function: { parameters: {
        type: 'object', properties: { parent: { anyOf: [{ type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] }, { type: 'null' }] } },
      } } }]);
      expect(JSON.stringify(received['tools'])).not.toContain('$ref');
      expect(parameters).toEqual(original);
    } finally { await close(server); }
  });

  it('leaves tool schemas for non-Kimi models unchanged', async () => {
    let received: Record<string, unknown> = {};
    const server = createTestHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    const baseUrl = await listen(server);
    try {
      const provider = new ProtocolAdapterRegistry().createChatProvider({ protocol: 'openai', providerType: 'openai', modelName: 'glm-5.3-flash', baseUrl, apiKey: 'YOUR_API_KEY' });
      await generate(provider, '', [{ name: 'example_create_page', description: 'Example page tool', parameters }], []);
      expect(received['tools']).toMatchObject([{ function: { parameters } }]);
    } finally { await close(server); }
  });
});

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
    await expect(collect([])).rejects.toMatchObject({ code: 'provider.incomplete_stream' });
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
      ).rejects.toMatchObject({ code: 'provider.api_error', details: { kind: 'quota_exhausted', providerErrorType: 'exceeded_current_quota_error' } });
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
    const result = await generate(provider, '', [], history);
    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
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
