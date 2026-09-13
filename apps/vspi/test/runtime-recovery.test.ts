import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRuntime, inspectRuntimeActivity, startRuntimeDaemon, type RuntimeConnection } from '@vsp/vsp-runtime';
import { stopRuntimeForUpdate } from '../src/v1/update/self-update.js';
import { KlientChatBackend } from '../src/v1/backend/klient-backend.js';
import type { TranscriptMessage } from '../src/v1/domain/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

async function fixture(mode: 'normal' | 'http-retry' | 'stream-retry' = 'normal', idleTimeoutMs = 0) {
  const root = await mkdtemp(join(tmpdir(), 'vspi-recovery-'));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  await mkdir(join(workspace, '.git'), { recursive: true });
  const replies: Array<() => void> = [];
  let attempts = 0;
  const server = createServer((request, response) => {
    void (async () => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'one' }, { id: 'two' }] }));
      return;
    }
    for await (const _chunk of request) {}
    attempts++;
    if (mode === 'http-retry' && attempts === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Temporary overload' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'one', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.write(chunk({ role: 'assistant', content: mode === 'stream-retry' && attempts > 1 ? 'replacement ' : 'early ' }));
    if (mode === 'stream-retry' && attempts === 1) {
      replies.push(() => { response.destroy(); });
      return;
    }
    replies.push(() => { if (response.destroyed) return; response.write(chunk({ content: 'late' })); response.write(chunk({}, 'stop')); response.end('data: [DONE]\n\n'); });
    })().catch(() => { response.destroy(); });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const daemon = await startRuntimeDaemon({ homeDir: home, idleTimeoutMs, env: { HOME: root, PATH: process.env.PATH }, hostIdentity: { productName: 'vspi-test', version: '2.3.0-test', platform: 'test' } });
  const connection = await connectRuntime(home);
  const connections: RuntimeConnection[] = [connection];
  const backends: KlientChatBackend[] = [];
  cleanups.push(async () => {
    for (const reply of replies.splice(0)) reply();
    for (const backend of backends) await backend.dispose();
    for (const client of connections) await client.close();
    await daemon.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    await rm(root, { recursive: true, force: true });
  });
  await connection.klient.global.config.replace({ domain: 'providers', value: { example: { type: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'YOUR_API_KEY', modelSource: 'static' } } });
  await connection.klient.global.config.replace({ domain: 'models', value: Object.fromEntries(['one', 'two'].map(id => [`example/${id}`, { provider: 'example', model: id, maxContextSize: 65536, maxOutputSize: 1024, thinking: { availability: 'none', canDisable: false, controls: [] } }])) });
  await connection.klient.global.config.replace({ domain: 'defaultModel', value: 'example/one' });
  async function front(mode: 'new' | 'continue') {
    const client = await connectRuntime(home); connections.push(client);
    const backend = new KlientChatBackend(client, workspace, mode); backends.push(backend);
    const messages = new Map<string, TranscriptMessage>();
    const errors: Error[] = [];
    const notices: string[] = [];
    const retryNotices: Array<string | undefined> = [];
    let busy = false;
    await backend.start({
      onHistory(items, prepend) { if (!prepend) messages.clear(); for (const item of items) messages.set(item.id, item); },
      onMessage(message) { messages.set(message.id, message); },
      onMessageUpdate(id, patch) { const previous = messages.get(id); if (previous) messages.set(id, { ...previous, ...patch } as TranscriptMessage); },
      onBusy(value) { busy = value; }, onUsage() {}, onNotice(message) { notices.push(message); }, onSessionError(error) { errors.push(error); },
      onRetryNotice(message) { retryNotices.push(message); },
    });
    return { backend, messages, errors, notices, retryNotices, busy: () => busy };
  }
  return { home, daemon, connection, front, detach: async () => { for (const backend of backends) await backend.dispose(); for (const client of connections) await client.close(); }, attempts: () => attempts, release: () => { for (const reply of replies.splice(0)) reply(); } };
}

describe('multiple clients on a real runtime', () => {
  it('finishes a detached turn before automatically shutting down its idle daemon', async () => {
    const rig = await fixture('normal', 300);
    const front = await rig.front('new');
    const prompt = front.backend.send('finish after detach', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect([...front.messages.values()].some(item => item.kind === 'text' && item.text === 'early ')).toBe(true); });
    await rig.detach();
    const witnessHome = await mkdtemp(join(tmpdir(), 'vspi-detach-witness-'));
    const witness = await startRuntimeDaemon({ homeDir: witnessHome, idleTimeoutMs: 500, env: { HOME: witnessHome, PATH: process.env.PATH }, hostIdentity: { productName: 'vspi-test', version: 'test', platform: 'test' } });
    try {
      await witness.closed;
      expect((await inspectRuntimeActivity(rig.home))?.busyAgents.length).toBe(1);
      rig.release();
      await rig.daemon.closed;
      await expect(inspectRuntimeActivity(rig.home)).resolves.toBeUndefined();
      await prompt.catch(() => {});
    } finally { await witness.close(); await rm(witnessHome, { recursive: true, force: true }); }
  }, 30000);
  it('recovers from a temporary HTTP failure without failing the prompt', async () => {
    const rig = await fixture('http-retry');
    const a = await rig.front('new');
    const prompt = a.backend.send('ordinary request', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect([...a.messages.values()].some(item => item.kind === 'text' && item.text === 'early ')).toBe(true); }, { timeout: 5000 });
    rig.release();
    await prompt;
    expect(rig.attempts()).toBe(2);
    expect(a.errors).toEqual([]);
    expect(a.retryNotices.some(message => message?.includes('第 2/3 次尝试'))).toBe(true);
    expect(a.retryNotices.at(-1)).toBeUndefined();
    expect(a.notices.some(message => message.includes('第 2/3 次尝试'))).toBe(false);
  }, 30000);

  it('replaces interrupted SSE content instead of concatenating it with a retried reply', async () => {
    const rig = await fixture('stream-retry');
    const a = await rig.front('new');
    const prompt = a.backend.send('ordinary request', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect([...a.messages.values()].some(item => item.kind === 'text' && item.text === 'early ')).toBe(true); });
    rig.release();
    await vi.waitFor(() => { expect([...a.messages.values()].some(item => item.kind === 'text' && item.text === 'replacement ')).toBe(true); }, { timeout: 5000 });
    rig.release();
    await prompt;
    const responses = [...a.messages.values()].flatMap(item => item.role === 'assistant' && item.kind === 'text' ? [item.text] : []);
    expect(responses).toContain('replacement late');
    expect(responses.some(text => text.includes('early'))).toBe(false);
    expect(rig.attempts()).toBe(2);
    expect(a.errors).toEqual([]);
  }, 30000);

  it('restores an active reply and applies later deltas without duplicates', async () => {
    const rig = await fixture();
    const a = await rig.front('new');
    const prompt = a.backend.send('ordinary user request', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect([...a.messages.values()].some(item => item.kind === 'text' && item.text === 'early ')).toBe(true); });
    const b = await rig.front('continue');
    expect(b.busy()).toBe(true);
    expect([...b.messages.values()].flatMap(item => item.role === 'assistant' && item.kind === 'text' ? [item.text] : [])).toEqual(['early ']);
    rig.release();
    await prompt;
    await vi.waitFor(() => { expect(b.busy()).toBe(false); });
    expect([...b.messages.values()].flatMap(item => item.role === 'assistant' && item.kind === 'text' ? [item.text] : [])).toEqual(['early late']);
    expect(b.errors).toEqual([]);
  }, 30000);

  it('updates another client when the shared model changes', async () => {
    const rig = await fixture();
    const a = await rig.front('new');
    const prompt = a.backend.send('create session', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect(a.busy()).toBe(true); });
    const b = await rig.front('continue');
    expect(b.backend.isSessionReady()).toBe(true);
    await a.backend.selectModel('example', 'two', 'off');
    await vi.waitFor(() => { expect(b.backend.modelId).toBe('two'); });
    rig.release();
    await prompt;
  }, 30000);

  it('allows an upgrade shutdown with an idle client attached', async () => {
    const rig = await fixture();
    const confirm = vi.fn(async () => false);
    await expect(stopRuntimeForUpdate(rig.home, confirm)).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    await expect(rig.daemon.closed).resolves.toBeUndefined();
  }, 30000);

  it('keeps an active model turn running when update interruption is declined', async () => {
    const rig = await fixture();
    const front = await rig.front('new');
    const prompt = front.backend.send('active work', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect([...front.messages.values()].some(item => item.kind === 'text' && item.text === 'early ')).toBe(true); });
    const confirm = vi.fn(async () => false);
    await expect(stopRuntimeForUpdate(rig.home, confirm)).rejects.toThrow('更新已取消');
    expect(confirm).toHaveBeenCalledOnce();
    expect((await inspectRuntimeActivity(rig.home))?.busyAgents.length).toBe(1);
    rig.release();
    await prompt;
  }, 30000);

  it('stops an active model turn only after explicit update confirmation', async () => {
    const rig = await fixture();
    const front = await rig.front('new');
    const prompt = front.backend.send('active work', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect([...front.messages.values()].some(item => item.kind === 'text' && item.text === 'early ')).toBe(true); });
    const confirm = vi.fn(async () => true);
    await expect(stopRuntimeForUpdate(rig.home, confirm)).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    await expect(rig.daemon.closed).resolves.toBeUndefined();
    rig.release();
    await prompt.catch(() => {});
  }, 30000);

  it('does not interrupt active work when no confirmation handler is available', async () => {
    const rig = await fixture();
    const front = await rig.front('new');
    const prompt = front.backend.send('active work', { attachments: [], effort: 'off', behavior: 'prompt' });
    void prompt.catch(() => {});
    await vi.waitFor(() => { expect([...front.messages.values()].some(item => item.kind === 'text' && item.text === 'early ')).toBe(true); });
    await expect(stopRuntimeForUpdate(rig.home)).rejects.toThrow('更新已取消');
    expect((await inspectRuntimeActivity(rig.home))?.busyAgents.length).toBe(1);
    rig.release();
    await prompt;
  }, 30000);
});
