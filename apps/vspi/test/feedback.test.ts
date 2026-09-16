import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimentalEnabled } from '../src/experimental.js';
import { dispatchFeedback } from '../src/v1/feedback/cli.js';
import { collectFeedback } from '../src/v1/feedback/collect.js';
import { FeedbackPreview } from '../src/v1/feedback/preview.js';
import { createTheme } from '../src/v1/ui/theme.js';
import { detectTerminalCapabilities } from '../src/v1/ui/capabilities.js';
import { FeedbackDiagnosticLog } from '../src/v1/feedback/diagnostics.js';
import {
  createFeedbackBundle,
  feedbackSecrets,
  parseFeedbackBundle,
  redactFeedbackText,
  saveFeedbackBundle,
  MAX_FEEDBACK_BYTES,
} from '../src/v1/feedback/bundle.js';
import { createFeedbackServer } from '../src/v1/feedback/server.js';
import {
  FEEDBACK_ENDPOINT,
  feedbackDigest,
  readPrivateFeedbackFile,
  uploadFeedback,
  readFeedbackUploadConfig,
  submitFeedback,
} from '../src/v1/feedback/client.js';
import { feedbackIdentity, feedbackIdentityPath } from '../src/v1/feedback/identity.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const token = 'YOUR_INDEPENDENT_FEEDBACK_TOKEN_123456';

async function rig(maxStoredBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), 'vspi-feedback-test-'));
  const directory = join(root, 'receiver');
  const server = await createFeedbackServer({
    directory,
    submitters: [{ id: 'example-user', token }],
    maxStoredBytes,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const url = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(root, { recursive: true, force: true });
  });
  const transport: typeof fetch = async (_input, init) => fetch(`${url}/api/feedback`, init);
  return { root, directory, url, transport, server };
}

function bundle() {
  return createFeedbackBundle({
    description: '连接失败，请检查',
    diagnostics: { version: '2.3.0', protocol: 'openai' },
    conversation: [{ role: 'assistant', kind: 'tool', text: 'intermediate output' }],
  });
}

describe('automatic device-user feedback registration', () => {
  it('forms a readable device-user label without an administrator configuration', () => {
    expect(feedbackIdentity('example-device', 'alice')).toEqual({ device: 'example-device', username: 'alice', id: 'example-device-alice' });
  });

  it('submits from an unconfigured home and reuses its private identity on subsequent uploads', async () => {
    const r = await rig();
    const home = join(r.root, 'new-user');
    const bytes = Buffer.from(JSON.stringify(bundle()));
    const output: string[] = [];
    const transport = vi.fn(r.transport);
    const path = await saveFeedbackBundle(join(home, 'feedback/outbox'), parseFeedbackBundle(bytes));
    await dispatchFeedback(['preview', path], { home, fetch: transport, write: text => output.push(text) });
    expect(transport).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      await dispatchFeedback(['submit', path, '--confirm-sha256', feedbackDigest(bytes)], { home, fetch: transport, write: text => output.push(text) });
    }
    expect(transport).toHaveBeenCalledTimes(3);
    const config = await readFeedbackUploadConfig(home, { fetch: transport });
    expect(config.id).toBe(`${hostname()}-${userInfo().username}`);
    expect((await stat(feedbackIdentityPath(home))).mode & 0o777).toBe(0o600);
    expect(await readFile(path)).toEqual(bytes);
    expect(output.join('\n')).not.toContain(config.token);
    const manifest = JSON.parse(await readFile(join(r.directory, 'ready', parseFeedbackBundle(bytes).id, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ submitter: `${hostname()}-${userInfo().username}`, identitySource: 'self-reported-device-user' });
  });

  it('does not register or upload when the confirmation digest is wrong', async () => {
    const r = await rig(); const transport = vi.fn(r.transport);
    await expect(submitFeedback(Buffer.from(JSON.stringify(bundle())), '0'.repeat(64), r.root, { fetch: transport })).rejects.toThrow('changed after preview');
    expect(transport).not.toHaveBeenCalled();
  });

  it('preserves an existing managed credential without automatic registration', async () => {
    const r = await rig(); const transport = vi.fn(r.transport);
    await writeFile(join(r.root, 'feedback.json'), JSON.stringify({ token }), { mode: 0o600 });
    await expect(readFeedbackUploadConfig(r.root, { fetch: transport })).resolves.toMatchObject({ endpoint: FEEDBACK_ENDPOINT, token });
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps one complete private credential when two terminals register concurrently', async () => {
    const r = await rig(); const home = join(r.root, 'new-user');
    const configs = await Promise.all([readFeedbackUploadConfig(home, { fetch: r.transport }), readFeedbackUploadConfig(home, { fetch: r.transport })]);
    expect(configs[0]).toEqual(configs[1]);
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), configs[0], { fetch: r.transport })).resolves.toBeTruthy();
  });

  it('retains automatically issued credentials across a receiver restart', async () => {
    const r = await rig();
    const config = await readFeedbackUploadConfig(join(r.root, 'new-user'), { fetch: r.transport });
    await new Promise<void>(resolve => r.server.close(() => { resolve(); }));
    const restarted = await createFeedbackServer({ directory: r.directory, submitters: [] });
    await new Promise<void>(resolve => restarted.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => { restarted.closeAllConnections(); await new Promise<void>(resolve => restarted.close(() => { resolve(); })); });
    const address = restarted.address(); if (!address || typeof address === 'string') throw new Error('Expected listener');
    const transport: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}/api/feedback`, init);
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), config, { fetch: transport })).resolves.toBeTruthy();
  });

  it('does not let another installation claiming the same name acknowledge an existing report', async () => {
    const r = await rig();
    const first = await readFeedbackUploadConfig(join(r.root, 'first-installation'), { fetch: r.transport });
    const second = await readFeedbackUploadConfig(join(r.root, 'second-installation'), { fetch: r.transport });
    expect(first.id).toBe(second.id);
    expect(first.token).not.toBe(second.token);
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await uploadFeedback(bytes, feedbackDigest(bytes), first, { fetch: r.transport });
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), second, { fetch: r.transport })).rejects.toThrow('409');
  });

  it('rejects tampered automatic credentials without storing data', async () => {
    const r = await rig();
    const config = await readFeedbackUploadConfig(join(r.root, 'new-user'), { fetch: r.transport });
    const [prefix, encoded, signature] = config.token.split('.');
    const claims = JSON.parse(Buffer.from(encoded!, 'base64url').toString());
    claims.username = 'different-user';
    const tampered = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), { ...config, token: tampered }, { fetch: r.transport })).rejects.toThrow('401');
    expect(await readdir(join(r.directory, 'ready'))).toEqual([]);
  });

  it('bounds public registration even when every request uses a different identity', async () => {
    const r = await rig();
    const register = (i: number) => r.transport(FEEDBACK_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feedback-action': 'register', 'x-feedback-consent': 'reviewed-v1' }, body: JSON.stringify({ device: `device-${i}`, username: 'alice' }) });
    for (let i = 0; i < 20; i++) { const response = await register(i); expect(response.status).toBe(201); await response.body?.cancel(); }
    const response = await register(21); expect(response.status).toBe(429); await response.body?.cancel();
    expect(await readdir(join(r.directory, 'ready'))).toEqual([]);
  });

  it('explains an older receiver without suggesting administrator-issued files', async () => {
    const r = await rig();
    const transport: typeof fetch = async () => new Response('{}', { status: 401 });
    await expect(readFeedbackUploadConfig(join(r.root, 'new-user'), { fetch: transport })).rejects.toThrow('接收服务尚未开放自动登记');
  });

  it('caps public uploads across separately registered identities', async () => {
    const r = await rig();
    for (let i = 0; i < 10; i++) {
      const config = await readFeedbackUploadConfig(join(r.root, `installation-${i}`), { fetch: r.transport });
      for (let n = 0; n < 3; n++) {
        const bytes = Buffer.from(JSON.stringify(bundle()));
        await uploadFeedback(bytes, feedbackDigest(bytes), config, { fetch: r.transport });
      }
    }
    const config = await readFeedbackUploadConfig(join(r.root, 'another-installation'), { fetch: r.transport });
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), config, { fetch: r.transport })).rejects.toThrow('429');
    expect(await readdir(join(r.directory, 'ready'))).toHaveLength(30);
  });

  it('redacts automatic submission tokens even if no identity cache is available', () => {
    expect(redactFeedbackText('copied vspi1.ZXhhbXBsZQ.c2lnbmF0dXJl')).toBe('copied [REDACTED FEEDBACK AUTH]');
  });
});

describe('private feedback delivery', () => {
  it('enables feedback without an experimental environment override', () => {
    expect(experimentalEnabled('feedback', {})).toBe(true);
  });
  it('allows explicitly disabling feedback', () => {
    expect(experimentalEnabled('feedback', { KIMI_CODE_EXPERIMENTAL_VSPI_FEEDBACK: 'false' })).toBe(false);
  });
  it('keeps unprovisioned distribution disabled by default', () => {
    expect(experimentalEnabled('distribution', {})).toBe(false);
  });
  it.each(['x'.repeat(64000), 'eyJ-'.repeat(16000), '\n'.repeat(64000)])(
    'handles long non-secret text without pathological pattern backtracking',
    text => { expect(redactFeedbackText(text)).toBe(text); },
  );
  it('keeps the previous credentials when a reload is invalid', async () => {
    const r = await rig();
    expect(() => r.server.reloadSubmitters([{ id: 'example-user', token: 'short' }])).toThrow();
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), { endpoint: FEEDBACK_ENDPOINT, token }, { fetch: r.transport })).resolves.toBeTruthy();
  });

  it('rotates submission credentials without restarting the receiver', async () => {
    const r = await rig(); const replacement = 'YOUR_REPLACEMENT_FEEDBACK_TOKEN_123456';
    r.server.reloadSubmitters([{ id: 'next-user', token: replacement }]);
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), { endpoint: FEEDBACK_ENDPOINT, token }, { fetch: r.transport })).rejects.toThrow('401');
    await expect(uploadFeedback(bytes, feedbackDigest(bytes), { endpoint: FEEDBACK_ENDPOINT, token: replacement }, { fetch: r.transport })).resolves.toBeTruthy();
  });

  it('writes only bounded structural error metadata during a failure burst', async () => {
    const r = await rig();
    const log = new FeedbackDiagnosticLog(r.root);
    for (let i = 0; i < 500; i++)
      log.append(
        {
          code: 'provider.protocol_error',
          details: { expectedProtocol: 'openai', rawBody: 'PRIVATE_RAW_BODY' },
        },
        'example-model',
      );
    await log.drain();
    const directory = join(r.root, 'feedback/diagnostics');
    const files = await readdir(directory);
    const data = await readFile(join(directory, files[0]!), 'utf8');
    expect(JSON.parse(data)).toHaveLength(32);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(65536);
    expect(data).not.toContain('PRIVATE_RAW_BODY');
  });

  it('retains retry timing and upstream status without recording private request content', async () => {
    const r = await rig();
    const log = new FeedbackDiagnosticLog(r.root);
    log.append({
      code: 'loop.retry_budget_exceeded', name: 'LoopError',
      details: { retryBudgetMs: 120_000, retryDelayMs: 300_000, remainingBudgetMs: 119_000, failedAttempt: 1, rawBody: 'PRIVATE_REQUEST' },
      cause: { code: 'provider.api_error', name: 'APIStatusError', details: { statusCode: 502, requestId: 'example-request', retryAfterMs: 300_000 } },
    }, 'example-model');
    await log.drain();
    const directory = join(r.root, 'feedback/diagnostics');
    const files = await readdir(directory);
    const data = await readFile(join(directory, files[0]!), 'utf8');
    expect(JSON.parse(data)).toMatchObject([{ model: 'example-model', chain: [
      { code: 'loop.retry_budget_exceeded', retryBudgetMs: 120_000, retryDelayMs: 300_000, remainingBudgetMs: 119_000, failedAttempt: 1 },
      { statusCode: 502, requestId: 'example-request', retryAfterMs: 300_000 },
    ] }]);
    expect(data).not.toContain('PRIVATE_REQUEST');
  });

  it('recovers incomplete staging owned by a definitely exited process', async () => {
    const r = await rig();
    await new Promise<void>((resolve) => r.server.close(() => resolve()));
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    const stage = join(r.directory, 'staging', randomUUID());
    await mkdir(stage, { mode: 0o700 });
    await writeFile(join(stage, 'owner.json'), JSON.stringify({ pid: child.pid }));
    await writeFile(join(stage, 'incoming'), 'unfinished');
    const restarted = await createFeedbackServer({
      directory: r.directory,
      submitters: [{ id: 'example-user', token }],
    });
    expect(await readdir(join(r.directory, 'staging'))).toEqual([]);
    restarted.close();
  });

  it('does not acknowledge corrupted persisted data on a duplicate submission', async () => {
    const r = await rig();
    const b = bundle();
    const bytes = Buffer.from(JSON.stringify(b));
    await uploadFeedback(
      bytes,
      feedbackDigest(bytes),
      { endpoint: FEEDBACK_ENDPOINT, token },
      { fetch: r.transport },
    );
    await writeFile(join(r.directory, 'ready', b.id, 'bundle.json'), 'corrupted');
    await expect(
      uploadFeedback(
        bytes,
        feedbackDigest(bytes),
        { endpoint: FEEDBACK_ENDPOINT, token },
        { fetch: r.transport },
      ),
    ).rejects.toThrow('500');
  });

  it('rejects raw edited secrets even when the raw file digest is confirmed', async () => {
    const r = await rig();
    const bytes = Buffer.from(
      JSON.stringify({ ...bundle(), description: 'token=example-private-secret' }),
    );
    await expect(
      uploadFeedback(
        bytes,
        feedbackDigest(bytes),
        { endpoint: FEEDBACK_ENDPOINT, token },
        { fetch: r.transport },
      ),
    ).rejects.toThrow('re-exported');
    expect(await readdir(join(r.directory, 'ready'))).toEqual([]);
  });

  it('exports and previews diagnostics without starting an unavailable daemon', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_VSPI_FEEDBACK', undefined);
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', undefined);
    const r = await rig();
    const home = join(r.root, 'client');
    const output: string[] = [];
    const connect = vi.fn(async () => {
      throw new Error('offline');
    });
    await dispatchFeedback(['export', '--description', 'example failure', '--turns', '0'], {
      home,
      connect,
      write: (text) => output.push(text),
    });
    const files = await readdir(join(home, 'feedback/outbox'));
    const path = join(home, 'feedback/outbox', files[0]!);
    await dispatchFeedback(['preview', path], { home, write: (text) => output.push(text) });
    expect(output.join('\n')).toContain('SHA256:');
    expect(output.join('\n')).toContain('example failure');
    expect(connect).toHaveBeenCalledOnce();
  });

  it('limits selected conversation to the latest user turn', async () => {
    const r = await rig();
    const result = await collectFeedback({
      home: r.root,
      description: 'example',
      turns: 1,
      connect: async () => {
        throw new Error('offline');
      },
      messages: [
        { id: '1', role: 'user', kind: 'text', text: 'older' },
        { id: '2', role: 'assistant', kind: 'text', text: 'older answer' },
        { id: '3', role: 'user', kind: 'text', text: 'latest' },
        {
          id: '4',
          role: 'assistant',
          kind: 'tool',
          name: 'example',
          summary: 'tool',
          output: 'intermediate',
          status: 'success',
          expanded: false,
        },
      ],
    });
    expect(result.conversation.map((e) => e.text).join('\n')).not.toContain('older');
    expect(result.conversation.map((e) => e.text).join('\n')).toContain('intermediate');
  });

  it('requires a deliberate confirmation after opening the upload action in the preview', () => {
    const actions: string[] = [];
    const preview = new FeedbackPreview(
      bundle(),
      createTheme(detectTerminalCapabilities({ NO_COLOR: '1' })),
      () => 12,
      (action) => actions.push(action),
    );
    preview.handleInput('\r');
    expect(actions).toEqual([]);
    preview.handleInput('u');
    preview.handleInput('\r');
    expect(actions).toEqual(['upload']);
  });

  it('stores a reviewed package in the Hermes ready directory before confirming upload', async () => {
    const r = await rig();
    const b = bundle();
    const path = await saveFeedbackBundle(join(r.root, 'local'), b);
    const bytes = await readPrivateFeedbackFile(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const id = await uploadFeedback(
      bytes,
      feedbackDigest(bytes),
      { endpoint: FEEDBACK_ENDPOINT, token },
      { fetch: r.transport },
    );
    expect(id).toBe(b.id);
    const saved = parseFeedbackBundle(
      await readFile(join(r.directory, 'ready', id, 'bundle.json')),
    );
    expect(saved.conversation).toEqual([
      { role: 'assistant', kind: 'tool', text: 'intermediate output' },
    ]);
    expect(await readdir(join(r.directory, 'staging'))).toEqual([]);
    const manifest = JSON.parse(
      await readFile(join(r.directory, 'ready', id, 'manifest.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({ id, submitter: 'example-user', untrustedContent: true });
  });

  it('returns the same receipt when a completed upload is retried', async () => {
    const r = await rig();
    const b = bundle();
    const bytes = Buffer.from(JSON.stringify(b));
    for (let i = 0; i < 2; i++)
      expect(
        await uploadFeedback(
          bytes,
          feedbackDigest(bytes),
          { endpoint: FEEDBACK_ENDPOINT, token },
          { fetch: r.transport },
        ),
      ).toBe(b.id);
    expect(await readdir(join(r.directory, 'ready'))).toEqual([b.id]);
  });

  it('rejects an upload when the payload changed after preview', async () => {
    const r = await rig();
    const bytes = Buffer.from(JSON.stringify(bundle()));
    await expect(
      uploadFeedback(
        bytes,
        '0'.repeat(64),
        { endpoint: FEEDBACK_ENDPOINT, token },
        { fetch: r.transport },
      ),
    ).rejects.toThrow('changed after preview');
    expect(await readdir(join(r.directory, 'ready'))).toEqual([]);
  });

  it('rejects a conflicting ID without overwriting an existing report', async () => {
    const r = await rig();
    const b = bundle();
    const bytes = Buffer.from(JSON.stringify(b));
    await uploadFeedback(
      bytes,
      feedbackDigest(bytes),
      { endpoint: FEEDBACK_ENDPOINT, token },
      { fetch: r.transport },
    );
    const changed = Buffer.from(JSON.stringify({ ...b, description: 'different content' }));
    await expect(
      uploadFeedback(
        changed,
        feedbackDigest(changed),
        { endpoint: FEEDBACK_ENDPOINT, token },
        { fetch: r.transport },
      ),
    ).rejects.toThrow('409');
    expect(
      parseFeedbackBundle(await readFile(join(r.directory, 'ready', b.id, 'bundle.json')))
        .description,
    ).toBe('连接失败，请检查');
  });

  it('rejects new reports when the persistent storage budget is exhausted', async () => {
    const r = await rig(MAX_FEEDBACK_BYTES);
    const large = () =>
      createFeedbackBundle({
        description: 'example',
        diagnostics: {},
        conversation: Array.from({ length: 40 }, () => ({
          role: 'assistant',
          kind: 'tool',
          text: 'x'.repeat(16000),
        })),
      });
    const first = Buffer.from(JSON.stringify(large()));
    await uploadFeedback(
      first,
      feedbackDigest(first),
      { endpoint: FEEDBACK_ENDPOINT, token },
      { fetch: r.transport },
    );
    const second = Buffer.from(JSON.stringify(large()));
    await expect(
      uploadFeedback(
        second,
        feedbackDigest(second),
        { endpoint: FEEDBACK_ENDPOINT, token },
        { fetch: r.transport },
      ),
    ).rejects.toThrow('507');
    expect(await readdir(join(r.directory, 'ready'))).toHaveLength(1);
  });

  it('rejects submission when explicit preview consent is missing', async () => {
    const r = await rig();
    const response = await fetch(`${r.url}/api/feedback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(bundle()),
    });
    expect(response.status).toBe(400);
    expect(await readdir(join(r.directory, 'ready'))).toEqual([]);
  });

  it('does not expose feedback files through an unauthenticated HTTP GET', async () => {
    const r = await rig();
    const response = await fetch(`${r.url}/ready/example/bundle.json`);
    expect(response.status).toBe(404);
  });

  it('rejects submission without independent authentication', async () => {
    const r = await rig();
    const response = await fetch(`${r.url}/api/feedback`, {
      method: 'POST',
      body: JSON.stringify(bundle()),
    });
    expect(response.status).toBe(401);
    expect(await readdir(join(r.directory, 'ready'))).toEqual([]);
  });

  it('rejects oversized bodies without publishing an incomplete package', async () => {
    const r = await rig();
    const response = await fetch(`${r.url}/api/feedback`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-feedback-consent': 'reviewed-v1',
      },
      body: 'x'.repeat(MAX_FEEDBACK_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await readdir(join(r.directory, 'ready'))).toEqual([]);
  });

  it('removes credentials from descriptions and intermediate output before local export', () => {
    const secrets = feedbackSecrets({
      providers: {
        example: { api_key: 'example-secret-long', headers: { custom: 'example-header-secret' } },
      },
    });
    const b = createFeedbackBundle({
      description: 'example-secret-long',
      diagnostics: { api_key: 'example-secret-long' },
      conversation: [
        {
          role: 'assistant',
          kind: 'tool',
          text: 'example-header-secret Bearer example-auth-secret https://user:password@example.test/v1?key=private',
        },
      ],
      secrets,
    });
    const text = JSON.stringify(b);
    for (const secret of [
      'example-secret-long',
      'example-header-secret',
      'example-auth-secret',
      'user:password',
      '?key=private',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('example.test/v1');
  });

  it('marks context truncation instead of silently exceeding the package budget', () => {
    const b = createFeedbackBundle({
      description: 'example',
      diagnostics: {},
      conversation: Array.from({ length: 300 }, () => ({
        role: 'assistant',
        kind: 'text',
        text: '字'.repeat(50000),
      })),
    });
    expect(b.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(MAX_FEEDBACK_BYTES);
    expect(() => parseFeedbackBundle(Buffer.from(JSON.stringify(b)))).not.toThrow();
  });

  it('removes terminal control sequences from feedback text', () => {
    expect(redactFeedbackText('\u001B[31mhello\u001B[0m\u001B]0;hidden-title\u0007')).toBe('hello');
  });

  it('redacts database credentials and complete cookie headers without losing token metrics', () => {
    const text = redactFeedbackText(
      'postgresql://example-user:example-password@example.test/db\nAWS_SECRET_ACCESS_KEY=example-access-secret\nCookie: first=example-cookie-one; second=example-cookie-two\nmax_tokens=1024',
    );
    for (const secret of [
      'example-user',
      'example-password',
      'example-access-secret',
      'example-cookie-one',
      'example-cookie-two',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('max_tokens=1024');
  });
});
