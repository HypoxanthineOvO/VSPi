import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { defineKlientConformance } from './helpers/conformance.js';
import { serveKlientIpc, type KlientIpcHost } from '../src/transports/ipc/index.js';
import { IpcChannel } from '../src/transports/ipc/channel.js';
import { connectKlient } from '../src/transports/tcp/index.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';

interface TcpBridge {
  readonly port: number;
  close(): Promise<void>;
}

async function startTcpBridge(socketPath: string): Promise<TcpBridge> {
  const sockets = new Set<Socket>();
  const server = createServer((tcp) => {
    const remote = createConnection(socketPath);
    sockets.add(tcp);
    sockets.add(remote);
    const drop = () => {
      sockets.delete(tcp);
      sockets.delete(remote);
      remote.destroy();
      tcp.destroy();
    };
    tcp.on('error', drop);
    remote.on('error', drop);
    tcp.on('close', drop);
    remote.on('close', drop);
    tcp.pipe(remote);
    remote.pipe(tcp);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP bridge did not bind a port');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

defineKlientConformance('tcp', async () => {
  const { homeDir, app } = await makeEngine();
  const socketPath = join(homeDir, 'klient.sock');
  const host = await serveKlientIpc({ scope: app, socketPath, token: 'TEST_ONLY_TOKEN' });
  const bridge = await startTcpBridge(socketPath);
  const { klient } = await connectKlient({ port: bridge.port, token: 'TEST_ONLY_TOKEN' });
  const rawChannel = new IpcChannel(
    { socketPath: '', token: 'TEST_ONLY_TOKEN' },
    createConnection({ host: '127.0.0.1', port: bridge.port }),
  );
  return {
    klient,
    app,
    rawCall: (service, method, args, scope) =>
      rawChannel.call(scope ?? {}, service, method, args),
    cleanup: async () => {
      await rawChannel.close();
      await klient.close();
      await bridge.close();
      await host.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('tcp transport (loopback tunnel facade)', () => {
  let homeDir: string;
  let app: TestEngine['app'];
  let host: KlientIpcHost | undefined;
  let bridge: TcpBridge | undefined;

  async function setup(options: { token?: string; handshakeData?: unknown } = {}): Promise<number> {
    ({ homeDir, app } = await makeEngine());
    const socketPath = join(homeDir, 'klient.sock');
    host = await serveKlientIpc({ scope: app, socketPath, token: options.token, handshakeData: options.handshakeData });
    bridge = await startTcpBridge(socketPath);
    return bridge.port;
  }

  async function teardown(): Promise<void> {
    await bridge?.close();
    bridge = undefined;
    await host?.close();
    host = undefined;
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  it.each([0, -1, 65536, 1.5, NaN])('rejects invalid tunnel port %s before connecting', async (port) => {
    await expect(connectKlient({ port, token: 'TEST_ONLY_TOKEN' })).rejects.toThrow('Invalid tunnel port');
  });

  it.each(['', '   '])('rejects a blank runtime token before connecting', async (token) => {
    await expect(connectKlient({ port: 1, token })).rejects.toThrow('runtime token is required');
  });

  it.each([
    { handshakeTimeoutMs: 0 },
    { handshakeTimeoutMs: -5 },
    { handshakeTimeoutMs: Number.NaN },
    { maxFrameBytes: 0 },
    { maxFrameBytes: -1 },
    { maxFrameBytes: 2 ** 31 },
  ])('rejects invalid channel options %o without opening a connection', async (options) => {
    let accepted = 0;
    const server = createServer(() => { accepted += 1; });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('counter server did not bind a port');
      await expect(connectKlient({ port: address.port, token: 'TEST_ONLY_TOKEN', ...options })).rejects.toThrow('IPC limit');
      expect(accepted).toBe(0);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });

  it('drops a mismatched token without disturbing authenticated clients', async () => {
    const port = await setup({ token: 'right' });
    try {
      await expect(connectKlient({ port, token: 'wrong' })).rejects.toThrow('unauthorized');
      const { klient } = await connectKlient({ port, token: 'right' });
      try {
        await expect(klient.global.env()).resolves.toMatchObject({ platform: process.platform });
      } finally { await klient.close(); }
    } finally { await teardown(); }
  });

  it('returns the host metadata handshake to the caller', async () => {
    const port = await setup({
      token: 'TEST_ONLY_TOKEN',
      handshakeData: { runtimeId: 'runtime-fixture', capabilities: ['klient-tunnel-v1'] },
    });
    try {
      const { klient, handshake } = await connectKlient({ port, token: 'TEST_ONLY_TOKEN' });
      try {
        expect(handshake).toEqual({ runtimeId: 'runtime-fixture', capabilities: ['klient-tunnel-v1'] });
      } finally { await klient.close(); }
    } finally { await teardown(); }
  });

  it('rejects calls after a clean disconnect', async () => {
    const port = await setup({ token: 'TEST_ONLY_TOKEN' });
    try {
      const { klient } = await connectKlient({ port, token: 'TEST_ONLY_TOKEN' });
      await klient.global.env();
      await klient.close();
      await expect(klient.global.workspaces.list()).rejects.toThrow('ipc closed');
    } finally { await teardown(); }
  });

  it('destroys both endpoints when the tunnel bridge closes', async () => {
    const port = await setup({ token: 'TEST_ONLY_TOKEN' });
    const { klient } = await connectKlient({ port, token: 'TEST_ONLY_TOKEN' });
    try {
      await klient.global.env();
      await bridge!.close();
      bridge = undefined;
      await expect(klient.global.workspaces.list()).rejects.toThrow('ipc closed');
    } finally { await klient.close(); await teardown(); }
  });

  it('serves durable prompt submission and resumable history over the tunnel', async () => {
    const port = await setup({ token: 'TEST_ONLY_TOKEN' });
    const workDir = join(homeDir, 'work');
    await mkdir(workDir);
    try {
      const { klient } = await connectKlient({ port, token: 'TEST_ONLY_TOKEN' });
      try {
        const created = await klient.global.sessions.create({ workDir });
        const agent = klient.session(created.id).agent('main');
        const input = { promptId: 'desktop-p1', input: [{ type: 'text' as const, text: 'hello over tcp' }] };
        const receipt = await agent.submitOnce(input);
        expect(receipt).toMatchObject({ promptId: 'desktop-p1', state: 'accepted' });
        expect(receipt.submittedAt).toEqual(expect.any(String));
        await expect(agent.getSubmission('desktop-p1')).resolves.toEqual(receipt);
        await expect(agent.getSubmission('never-submitted')).resolves.toBeUndefined();
        const replay = await agent.submitOnce(input);
        expect(replay).toEqual(receipt);
        await expect(
          agent.submitOnce({ promptId: 'desktop-p1', input: [{ type: 'text', text: 'different' }] }),
        ).rejects.toMatchObject({ code: 40927 });
        const watch = agent.watchHistory()[Symbol.asyncIterator]();
        try {
          const snapshot = await watch.next();
          expect(snapshot.value?.kind).toBe('snapshot');
          if (snapshot.value?.kind !== 'snapshot') return;
          await agent.submitOnce({ promptId: 'desktop-p2', input: [{ type: 'text', text: 'second' }] });
          const resumed = agent.watchHistory({ after: snapshot.value.cursor })[Symbol.asyncIterator]();
          try {
            const event = await resumed.next();
            expect(event.value?.kind).toBe('event');
            expect(event.value?.cursor.epoch).toBe(snapshot.value.cursor.epoch);
            expect(event.value?.cursor.revision).toBeGreaterThan(snapshot.value.cursor.revision);
          } finally {
            await resumed.return?.();
          }
        } finally {
          await watch.return?.();
        }
        await klient.session(created.id).close();
      } finally {
        await klient.close();
      }
    } finally {
      await teardown();
    }
  });

  it('serves two independent clients and closing one leaves the other operational', async () => {
    const port = await setup({ token: 'TEST_ONLY_TOKEN' });
    try {
      const first = await connectKlient({ port, token: 'TEST_ONLY_TOKEN' });
      const second = await connectKlient({ port, token: 'TEST_ONLY_TOKEN' });
      try {
        const root = join(homeDir, 'shared');
        await mkdir(root);
        const created = await first.klient.global.workspaces.createOrTouch({ root, name: 'shared' });
        expect(await second.klient.global.workspaces.get(created.id)).toMatchObject({ name: 'shared' });
        await first.klient.global.config.set({ domain: 'thinking', patch: { effort: 'low' } });
        expect(await second.klient.global.config.get('thinking')).toMatchObject({ effort: 'low' });
        await first.klient.close();
        await expect(second.klient.global.workspaces.get(created.id)).resolves.toMatchObject({ name: 'shared' });
      } finally { await first.klient.close(); await second.klient.close(); }
    } finally { await teardown(); }
  });
});
