import { createServer } from 'node:http';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageAccumulator } from '#human/llm/message';
import { fromLlmAssistantMessage, type Message, type Tool } from '#/llm-adapter/contract/message';
import { deepSeekBaseUrl, deepSeekRouteIdentity, resolveDeepSeekCapabilities } from '#/llm-adapter/provider/deepseek/capabilities';
import { prepareDeepSeekMessages } from '#/llm-adapter/provider/deepseek/messages';
import { decodePiSignature, encodePiSignature, toPiContext } from '#/llm-adapter/provider/pi/messages';
import { ModelRecordSchema, modelsFromToml, modelsToToml } from '#/app/kosongConfig/configSection';
import { PiChatProvider } from '#/llm-adapter/provider/pi/piChatProvider';

const route = { protocol: 'anthropic' as const, providerType: 'deepseek', providerName: 'example', modelName: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic' };
const capabilities = resolveDeepSeekCapabilities(route);
const model = { api: 'anthropic-messages' as const, provider: 'deepseek', id: 'deepseek-flash', name: 'Flash', baseUrl: route.baseUrl,
  reasoning: true, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 32768 };
const tool: Tool = { name: 'example_tool', description: 'Example tool', parameters: { type: 'object', properties: {} } };
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], toolCalls: [] });
const system = (text: string, tools?: Tool[]): Message => ({ role: 'system', content: text ? [{ type: 'text', text }] : [], toolCalls: [], tools });
const assistant = (content: Message['content']): Message => ({ role: 'assistant', content, toolCalls: [] });
const call: Message = { role: 'assistant', content: [{ type: 'think', think: 'Use a tool' }], toolCalls: [{ type: 'function', id: 'call_1', name: tool.name, arguments: '{}' }] };
const result: Message = { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'Result' }], toolCalls: [] };

async function serialize(history: Message[], tools: Tool[] = [], caps = capabilities, identity = deepSeekRouteIdentity(route), effort = 'high') {
  const context = normalizeContext(await toPiContext('Base system', tools, history, model));
  return JSON.parse(JSON.stringify(prepareDeepSeekMessages({ model: model.id, max_tokens: 32768 }, context, tools, history, caps, identity, effort)));
}

afterEach(() => vi.restoreAllMocks());

describe('DeepSeek capability declarations', () => {
  it('round trips model and legacy override capability declarations through TOML', () => {
    const raw = { example: { protocol: 'anthropic', deepseek: { native_messages: true, system_prompt_update: 'in-history', tool_update: 'addition-only' }, overrides: { deepseek: { tool_update: 'none' } } } };
    const parsed = modelsFromToml(raw) as Record<string, unknown>;
    expect(ModelRecordSchema.parse(parsed['example'])).toMatchObject({ deepseek: { nativeMessages: true }, overrides: { deepseek: { toolUpdate: 'none' } } });
    expect(modelsToToml(parsed, {})).toEqual(raw);
  });
  it('enables Flash updates only on the official native route', () => {
    expect(capabilities).toEqual({ nativeMessages: true, systemPromptUpdate: 'in-history', toolUpdate: 'addition-only', thinkingReplay: 'signed' });
    expect(resolveDeepSeekCapabilities({ ...route, modelName: 'deepseek-v4-pro' })).toMatchObject({ nativeMessages: true, toolUpdate: 'none', systemPromptUpdate: 'leading-only' });
    expect(resolveDeepSeekCapabilities({ ...route, modelName: 'future-model' })).toMatchObject({ toolUpdate: 'none' });
    expect(resolveDeepSeekCapabilities({ ...route, baseUrl: 'https://relay.example.test/anthropic' })).toMatchObject({ nativeMessages: false, toolUpdate: 'none' });
    expect(resolveDeepSeekCapabilities({ ...route, protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' })).toMatchObject({ nativeMessages: false });
    expect(deepSeekBaseUrl({ ...route, baseUrl: 'https://api.deepseek.com/v1' })).toBe('https://api.deepseek.com/anthropic');
  });
  it('accepts explicit relay capabilities and rejects conflicting declarations', () => {
    const relay = { ...route, providerType: 'example-relay', baseUrl: 'https://relay.example.test/anthropic' };
    expect(resolveDeepSeekCapabilities(relay, { nativeMessages: true })).toMatchObject({ nativeMessages: true, toolUpdate: 'none' });
    expect(resolveDeepSeekCapabilities(relay, { nativeMessages: true, systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' })).toMatchObject({ toolUpdate: 'addition-only' });
    expect(() => resolveDeepSeekCapabilities(relay, { nativeMessages: true, toolUpdate: 'addition-only' })).toThrow('system_prompt_update');
    expect(() => resolveDeepSeekCapabilities({ ...route, protocol: 'openai' }, { nativeMessages: true })).toThrow('protocol');
    expect(() => resolveDeepSeekCapabilities(route, { nativeMessages: false, toolUpdate: 'none' })).toThrow('require native_messages');
    expect(() => resolveDeepSeekCapabilities({ ...relay, baseUrl: 'https://YOUR_API_KEY@relay.example.test' }, { nativeMessages: true })).toThrow('without URL credentials');
  });
  it('binds replay to the provider, model and endpoint, normalizing trailing v1', () => {
    const identity = deepSeekRouteIdentity(route);
    expect(deepSeekRouteIdentity({ ...route, baseUrl: `${route.baseUrl}/v1/` })).toBe(identity);
    for (const change of [{ modelName: 'deepseek-v4-pro' }, { providerName: 'other' }, { baseUrl: 'https://relay.example.test/anthropic' }])
      expect(deepSeekRouteIdentity({ ...route, ...change })).not.toBe(identity);
  });
});

describe('DeepSeek Messages history and stable cache prefix', () => {
  it('keeps the leading prompt stable and lands cumulative updates after user input', async () => {
    const first = await serialize([user('First')]);
    const next = await serialize([user('First'), assistant([{ type: 'text', text: 'Answer' }]), system('Reminder'), user('Second'), assistant([{ type: 'text', text: 'Next' }]), system('Another reminder'), user('Third')]);
    expect(next.system).toBe(first.system);
    expect(next.messages.slice(0, 1)).toEqual(first.messages);
    expect(next.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'user', 'system', 'assistant', 'user', 'system']);
    expect(next.messages[3].content).toEqual([{ type: 'text', text: 'Base system\n\nReminder' }]);
    expect(next.messages[6].content).toEqual([{ type: 'text', text: 'Base system\n\nReminder\n\nAnother reminder' }]);
  });
  it('keeps deferred definitions unchanged as tools are loaded, with reference additions after results', async () => {
    const tools = [{ ...tool, deferred: true as const }];
    const before = await serialize([user('First')], tools);
    const after = await serialize([user('First'), call, system('', [tool]), result], tools);
    expect(after.tools).toEqual(before.tools);
    expect(after.tools).toEqual([{ name: tool.name, description: tool.description, input_schema: tool.parameters, defer_loading: true }]);
    expect(after.messages.at(-1)).toEqual({ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: tool.name } }] });
    expect(after.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
  });
  it('folds all system messages and tool declarations for native routes without updates', async () => {
    const caps = resolveDeepSeekCapabilities({ ...route, modelName: 'deepseek-v4-pro' });
    const wire = await serialize([user('First'), assistant([{ type: 'text', text: 'Answer' }]), system('Reminder', [tool]), user('Second')], [], caps);
    expect(wire.system).toBe('Base system\n\nReminder');
    expect(wire.messages.some((message: { role: string }) => message.role === 'system')).toBe(false);
    expect(wire.tools[0].name).toBe(tool.name);
    expect(wire.tools[0]).not.toHaveProperty('defer_loading');
  });
  it('uses the current full tool definition when cached updates are disabled', async () => {
    const caps = { ...capabilities, toolUpdate: 'none' as const };
    const updated = { ...tool, description: 'Current description', parameters: { type: 'object', properties: { value: { type: 'number' } } } };
    const wire = await serialize([user('First'), system('', [tool]), user('Next')], [updated], caps);
    expect(wire.tools[0]).toEqual({ name: tool.name, description: updated.description, input_schema: updated.parameters });
  });
  it('preserves thinking text and reuses only signatures from the exact native route', async () => {
    const identity = deepSeekRouteIdentity(route);
    const signature = encodePiSignature({ ...model, model: model.id }, 'signed-native', undefined, identity);
    const history = [user('First'), assistant([{ type: 'think', think: 'Reasoning', encrypted: signature }, { type: 'text', text: 'Answer' }]), user('Next')];
    expect((await serialize(history)).messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'Reasoning', signature: 'signed-native' });
    expect((await serialize(history, [], capabilities, 'foreign-route')).messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'Reasoning' });
    history[1] = assistant([{ type: 'think', think: 'Old reasoning', encrypted: 'old-opaque-signature' }]);
    expect((await serialize(history)).messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'Old reasoning' });
  });
  it.each(['off', 'low', 'high', 'max'])('serializes native effort %s without Claude budget fields', async effort => {
    const wire = await serialize([user('First')], [], capabilities, deepSeekRouteIdentity(route), effort);
    expect(wire.thinking).toEqual({ type: effort === 'off' ? 'disabled' : 'enabled' });
    if (effort === 'off') expect(wire).not.toHaveProperty('output_config');
    else expect(wire.output_config).toEqual({ effort });
  });
  it('rejects unsupported native efforts rather than silently converting them', async () => {
    await expect(serialize([user('First')], [], capabilities, deepSeekRouteIdentity(route), 'medium')).rejects.toThrow('does not support reasoning effort');
  });
  it('retains inline images on user input and tool results', async () => {
    const image = { type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,ZXhhbXBsZQ==' } };
    const wire = await serialize([{ ...user('First'), content: [image] }, call, { ...result, content: [image] }]);
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZXhhbXBsZQ==' } };
    expect(wire.messages[0].content).toEqual([block]);
    expect(wire.messages[2].content[0].content).toEqual([block]);
  });
  it('rejects schema changes and invalid tool pairing before sending a request', async () => {
    await expect(serialize([user('First'), system('', [{ ...tool, description: 'Changed' }]), user('Next')], [tool])).rejects.toThrow('redefined');
    await expect(serialize([user('First'), call])).rejects.toThrow('unresolved');
    await expect(serialize([user('First'), result])).rejects.toThrow('no matching');
    await expect(serialize([user('First'), call, user('Next')])).rejects.toThrow('precede new user');
    await expect(serialize([user('First'), { ...call, toolCalls: [...call.toolCalls, ...call.toolCalls] }, result])).rejects.toThrow('duplicate');
  });
});

describe('DeepSeek native streaming and protocol switches', () => {
  it('rejects unsupported structured output before dispatch rather than silently ignoring the constraint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new PiChatProvider({ ...route, apiKey: 'YOUR_API_KEY' });
    await expect(provider.generate('System', [], [user('JSON please')], { responseFormat: { type: 'json_object' } })).rejects.toThrow('does not support structured response formats');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses the Messages endpoint, native thinking policy and beta, then replays the streamed signature', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string | string[] | undefined>> = [];
    const paths: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      bodies.push(JSON.parse(raw)); headers.push(request.headers); paths.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { id: 'msg_example', type: 'message', role: 'assistant', model: model.id, content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native-signature' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      })().catch(error => response.destroy(error));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    const config = { ...route, baseUrl: `http://127.0.0.1:${address.port}/anthropic`, apiKey: 'YOUR_API_KEY', providerOptions: { deepseek: { nativeMessages: true, systemPromptUpdate: 'in-history' as const, toolUpdate: 'addition-only' as const } } };
    const provider = new PiChatProvider(config);
    const run = async (history: Message[], effort = 'high') => {
      const stream = await provider.generate('Base system', [], history, { thinking: { effort }, cacheKey: 'example-session' });
      const acc = createMessageAccumulator(); for await (const part of stream) acc.push(part);
      return { message: fromLlmAssistantMessage(acc.finish()), usage: stream.usage };
    };
    try {
      const first = await run([user('First')]);
      expect(first.usage).toMatchObject({ inputOther: 4, inputCacheRead: 3, output: 2 });
      const thinking = first.message.content.find(part => part.type === 'think');
      expect(thinking).toMatchObject({ think: 'Reasoning' });
      expect(decodePiSignature(thinking?.type === 'think' ? thinking.encrypted : undefined)).toMatchObject({ route: deepSeekRouteIdentity(config), signature: 'native-signature' });
      await run([user('First'), first.message, system('Reminder'), user('Next')], 'off');
      expect(paths).toEqual(['/anthropic/v1/messages', '/anthropic/v1/messages']);
      expect(headers[0]?.['anthropic-beta']).toBe('mid-conversation-tool-changes-2026-07-01');
      expect(bodies[0]).toMatchObject({ metadata: { user_id: 'example-session' }, thinking: { type: 'enabled' }, output_config: { effort: 'high' } });
      expect(bodies[0]).not.toHaveProperty('betas');
      expect(bodies[1]).toMatchObject({ thinking: { type: 'disabled' } });
      expect(bodies[1]).not.toHaveProperty('output_config');
      const messages = bodies[1]?.['messages'] as Array<{ content: unknown[] }>;
      expect(messages[1]?.content[0]).toEqual({ type: 'thinking', thinking: 'Reasoning', signature: 'native-signature' });
      expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Base system\n\nReminder' }]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('preserves native thinking as reasoning_content through an OpenAI relay', async () => {
    let body: Record<string, unknown> = {};
    const capture = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON');
      body = JSON.parse(init.body);
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new PiChatProvider({ protocol: 'openai', providerType: 'example-relay', modelName: model.id, baseUrl: 'https://relay.example.test/v1', apiKey: 'YOUR_API_KEY', providerOptions: { relay: true } });
    const native = assistant([{ type: 'think', think: 'Preserved reasoning', encrypted: encodePiSignature({ ...model, model: model.id }, 'native-secret', undefined, deepSeekRouteIdentity(route)) }, { type: 'text', text: 'Previous answer' }]);
    const stream = await provider.generate('System', [], [user('First'), native, user('Next')]);
    for await (const _part of stream) { }
    expect(body['messages']).toContainEqual({ role: 'assistant', content: 'Previous answer', reasoning_content: 'Preserved reasoning' });
    expect(JSON.stringify(body)).not.toContain('native-secret');
    expect(body).not.toHaveProperty('thinking');
    capture.mockRestore();
  });
});
