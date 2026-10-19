import { describe, expect, it, vi } from 'vitest';
import { createMessageAccumulator } from '#human/llm/message';
import { createUserMessage, createToolMessage, type Message } from '#/llm-adapter/contract/message';
import { DevinChatProvider, accumulateDevinArguments, buildDevinRequest, devinToolId } from '#/llm-adapter/provider/devin/chatProvider';
import { normalizeDevinModels } from '#/llm-adapter/provider/devin/catalog';
import { checkTrailer, child, children, connectFrame, ConnectDecoder, decode, decodeUnary, field, message, number, text } from '#/llm-adapter/provider/devin/protobuf';
import { devinCredential } from '#/app/auth/devinCredential';

const config = { protocol: 'openai' as const, providerType: 'devin', modelName: 'example-model' };
const tool = { name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { value: { type: 'string' } } } };
const model = (uid: string, label: string, extra: Uint8Array = Buffer.alloc(0)) => field(1, message(field(1, label), field(22, uid), extra));
const trailer = connectFrame(Buffer.from('{}'), 2);

function mockProvider(frames: Buffer[]) {
  const requests: Buffer[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    requests.push(Buffer.from(init?.body as Uint8Array));
    if (requests.length === 1) return new Response(field(1, 'example-user-jwt'));
    return new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(frame); controller.close(); } }), { headers: { 'content-type': 'application/connect+proto' } });
  });
  return { provider: new DevinChatProvider(config, fetchImpl), fetchImpl, requests };
}

async function consume(provider: DevinChatProvider) {
  const stream = await provider.generate('System', [tool], [createUserMessage('Hello')], { auth: { apiKey: 'example-session' } });
  const accumulator = createMessageAccumulator();
  for await (const part of stream) accumulator.push(part);
  return { stream, assistant: accumulator.finish() };
}

describe('Devin protobuf and Connect', () => {
  it('round trips protobuf integers, unicode, nested messages and split gzip frames', () => {
    const payload = message(field(1, 'hello 世界'), field(2, 2 ** 40), field(3, field(1, 'nested')));
    const frame = connectFrame(payload, 1);
    const decoder = new ConnectDecoder();
    const frames = [];
    for (const byte of frame) frames.push(...decoder.push(Uint8Array.of(byte)));
    decoder.finish();
    expect(frames).toHaveLength(1);
    const decoded = decode(frames[0]!.payload);
    expect(text(decoded, 1)).toBe('hello 世界');
    expect(number(decoded, 2)).toBe(2 ** 40);
    expect(text(child(decoded, 3), 1)).toBe('nested');
    expect(text(decodeUnary(frame), 1)).toBe('hello 世界');
  });
  it('rejects truncated and oversized frames and malformed protobuf', () => {
    const decoder = new ConnectDecoder(); decoder.push(Buffer.from([0, 0, 0, 0, 2, 8]));
    expect(() => decoder.finish()).toThrow('truncated');
    expect(() => new ConnectDecoder().push(Buffer.from([0, 127, 255, 255, 255]))).toThrow('oversized');
    expect(() => decode(Buffer.from([10, 5, 65]))).toThrow('Truncated');
    expect(() => decode(Buffer.from([128]))).toThrow('Truncated');
  });
  it('classifies trailer auth errors and preserves rate-limit reset hints', () => {
    expect(() => checkTrailer(Buffer.from('{'))).toThrow('Invalid Devin');
    expect(() => checkTrailer(Buffer.from(JSON.stringify({ error: { code: 'unauthenticated', message: 'Login rejected' } })))).toThrow('unauthenticated');
    try { checkTrailer(Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message: 'Wait' }, metadata: { 'retry-after': ['20'] } }))); }
    catch (error) { expect(error).toMatchObject({ statusCode: 429, retryAfterMs: 20000 }); }
  });
});

describe('Devin catalog', () => {
  it('filters disabled/internal/router/composite models and collapses only effort lanes', () => {
    const family = (effort: string, fast = false) => field(30, message(field(1, 'Example Model'),
      field(2, message(field(1, 'Reasoning Effort'), field(2, message(field(1, 1), field(2, effort))))),
      field(2, message(field(1, 'Fast Mode'), field(2, field(1, fast ? 1 : 0))))));
    const response = decode(message(
      model('example-low', 'Low', family('Low')), model('example-high', 'High', message(family('High'), field(31, true))),
      model('example-fast', 'Fast', family('High', true)),
      model('disabled', 'Disabled', field(4, true)), model('internal', 'Internal', field(23, field(2, true))),
      model('router', 'Router', field(23, field(25, true))), model('fusion-example', 'Fusion'), model('adaptive', 'Adaptive'),
      model('hidden', 'Hidden', field(23, field(22, 6))),
      model('vision', 'Vision', message(field(18, 123456), field(23, message(field(13, 1234), field(6, message(field(11, true), field(12, true), field(15, true))))))),
      model('swe-1-6', 'SWE', field(5, true)),
    ));
    const records = normalizeDevinModels(response);
    expect(Object.keys(records)).toEqual(['devin/example-model', 'devin/example-model-fast', 'devin/swe-1-6', 'devin/vision']);
    expect(records['devin/example-model']).toMatchObject({ model: 'example-high', effortMapping: { low: 'example-low', high: 'example-high' }, thinking: { efforts: ['low', 'high'], defaultEffort: 'high' } });
    expect(records['devin/vision']).toMatchObject({ maxContextSize: 123456, maxOutputSize: 1234, capabilities: ['tool_use', 'thinking', 'image_in'] });
    expect(records['devin/swe-1-6']?.capabilities).not.toContain('image_in');
  });
  it('uses the small fallback catalog only for an empty successful discovery', async () => {
    const { fetchDevinModels } = await import('#/llm-adapter/provider/devin/catalog');
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array()));
    expect(Object.keys(await fetchDevinModels('example-session', 'example', undefined, undefined, fetchImpl))).toEqual(['example/swe-1-6', 'example/swe-1-6-fast']);
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(fetchDevinModels('example-session', 'example', undefined, undefined, fetchImpl)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('supports native CLI JWTs without exp and rejects expired exp claims', () => {
    const token = `header.${Buffer.from(JSON.stringify({ session_id: 'example-session-id' })).toString('base64url')}.signature`;
    expect(devinCredential(token).expires).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => devinCredential('header.eyJleHAiOjF9.signature')).toThrow('re-login required');
  });
});

describe('Devin native chat', () => {
  it('decodes text, thinking, signatures, cumulative/incremental tool arguments and usage', async () => {
    const toolDelta = (args: string, id = 'call_1') => field(6, message(field(1, id), field(2, 'lookup'), field(3, args)));
    const { provider, requests } = mockProvider([
      connectFrame(message(field(1, 'message-1'), field(9, 'Think'), field(10, 'signed')), 1),
      connectFrame(field(3, 'Use tool')), connectFrame(toolDelta('{"value":')),
      connectFrame(toolDelta('{"value":"x')), connectFrame(toolDelta('"}', '')),
      connectFrame(message(field(5, 10), field(7, message(field(2, 10), field(3, 5), field(4, 2), field(5, 3))))), trailer,
    ]);
    const { stream, assistant } = await consume(provider);
    expect(stream.id).toBe('message-1');
    expect(stream.finishReason).toBe('tool_calls');
    expect(stream.usage).toEqual({ inputOther: 10, output: 5, inputCacheCreation: 2, inputCacheRead: 3 });
    expect(assistant.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Use tool' }), expect.objectContaining({ type: 'think', think: 'Think', encrypted: expect.stringContaining('signed') })]));
    expect(assistant.toolCalls).toMatchObject([{ id: 'call_1', name: 'lookup', arguments: '{"value":"x"}' }]);
    const request = decodeUnary(requests[1]!);
    expect(text(request, 21)).toBe('example-model');
    expect(text(child(request, 1), 3)).toBe('devin-session-token$example-session');
  });
  it('raises HTTP-200 trailer errors and incomplete streams, without internal retries', async () => {
    const failing = mockProvider([connectFrame(Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message: 'Wait' } })), 2)]);
    await expect(consume(failing.provider)).rejects.toMatchObject({ statusCode: 429 });
    expect(failing.fetchImpl).toHaveBeenCalledTimes(2);
    await expect(consume(mockProvider([connectFrame(field(3, 'partial'))]).provider)).rejects.toThrow('end-stream trailer');
    await expect(consume(mockProvider([connectFrame(field(6, message(field(1, 'call'), field(2, 'lookup'), field(3, '{')))), trailer]).provider)).rejects.toThrow('incomplete JSON');
  });
  it.each(['gemini-3-5-flash', 'MODEL_GOOGLE_GEMINI_3_5_FLASH', 'claude-example', 'swe-1-6-fast'])('normalizes tool schemas only for Gemini wire UIDs: %s', async uid => {
    const parameters = {
      type: 'object', additionalProperties: false,
      properties: {
        value: { type: ['number', 'null'], minimum: 0 },
        nested: { type: 'array', items: { type: ['string', 'number', 'null'] } },
        choice: { anyOf: [{ type: ['string', 'null'] }, { const: 'example' }] },
        type: { type: ['boolean', 'null'] },
        additionalProperties: { type: 'string' },
      }, required: ['value'],
    };
    const before = structuredClone(parameters);
    const request = decode(await buildDevinRequest({ ...config, modelName: 'gemini-alias', effortMapping: { high: uid } }, 'System', [{ ...tool, parameters }], [], { thinking: { effort: 'high' } }, 'example-token', 'example-jwt'));
    const schema: unknown = JSON.parse(text(child(request, 10), 3));
    expect(text(request, 21)).toBe(uid);
    expect(parameters).toEqual(before);
    if (uid.startsWith('gemini-') || uid.startsWith('MODEL_GOOGLE_GEMINI_')) {
      expect(schema).toMatchObject({
        type: 'object', required: ['value'], propertyOrdering: Object.keys(parameters.properties),
        properties: {
          value: { type: 'number', nullable: true, description: expect.stringContaining('minimum') },
          nested: { type: 'array', items: { nullable: true, anyOf: [{ type: 'string' }, { type: 'number' }] } },
          choice: { anyOf: [{ type: 'string', nullable: true }, { type: 'string', enum: ['example'] }] },
          type: { type: 'boolean', nullable: true }, additionalProperties: { type: 'string' },
        },
      });
      expect(schema).not.toHaveProperty('additionalProperties');
    } else expect(schema).toEqual(parameters);
  });
  it('replays tool results and signed thinking, routes efforts and retains image input', async () => {
    const history: Message[] = [createUserMessage('Hello'), { role: 'assistant', content: [{ type: 'think', think: 'Thought', encrypted: 'devin:{"model":"example-model","signature":"sig"}' }], toolCalls: [{ type: 'function', id: 'foreign|tool.id', name: 'lookup', arguments: '{"value":"x"}' }] }, createToolMessage('foreign|tool.id', [{ type: 'text', text: 'Result' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } }])];
    const request = decode(await buildDevinRequest({ ...config, effortMapping: { high: 'example-high' } }, 'System', [tool], history, { thinking: { effort: 'high' }, cacheKey: 'example-session' }, 'example-token', 'example-jwt'));
    expect(text(request, 21)).toBe('example-high');
    const prompts = children(request, 3);
    expect(text(prompts[1]!, 12)).toBe('sig');
    expect(text(child(prompts[1]!, 6), 1)).toBe(devinToolId('foreign|tool.id'));
    expect(text(prompts[2]!, 7)).toBe(devinToolId('foreign|tool.id'));
    expect(text(child(prompts[2]!, 10), 1)).toBe('aGVsbG8=');
    expect(accumulateDevinArguments('{"a":', '{"a":1}')).toBe('{"a":1}');
  });
});
