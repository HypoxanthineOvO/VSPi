/** IPC boundaries: authenticated framing, byte budgets, deadlines, and cancellation. */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { IMcpManagementService, IModelCatalog } from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient, serveKlientIpc, type KlientIpcHost } from '../src/transports/ipc/index.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';
import { IpcChannel } from '../src/transports/ipc/channel.js';
import { encodeFrame, NdjsonDecoder, type IpcFrame } from '../src/transports/ipc/codec.js';

defineKlientConformance('ipc', async () => {
  const { homeDir, app } = await makeEngine();
  const socketPath = join(homeDir, 'klient.sock');
  const host = await serveKlientIpc({ scope: app, socketPath });
  const klient = createKlient({ socketPath });
  const rawChannel = new IpcChannel({ socketPath });
  return {
    klient,
    app,
    rawCall: (service, method, args) => rawChannel.call({}, service, method, args),
    cleanup: async () => {
      await rawChannel.close();
      await klient.close();
      await host.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('IPC framing (untrusted bytes)', () => {
  it('rejects an oversized string before serializing the frame', () => {
    expect(() => encodeFrame({ type: 'result', id: 'large', data: 'x'.repeat(8 * 1024 * 1024) }, 1024)).toThrow('byte limit');
  });

  it('counts escaped and multibyte strings against their encoded byte size', () => {
    const frame = { type: 'result', id: 'text', data: '中文🧪\n\u0000"\\' };
    const size = Buffer.byteLength(JSON.stringify(frame));
    expect(encodeFrame(frame, size)).toBe(`${JSON.stringify(frame)}\n`);
    expect(() => encodeFrame(frame, size - 1)).toThrow('byte limit');
  });
  it('preserves multibyte text when every byte arrives separately', () => {
    const decoder = new NdjsonDecoder();
    const frames: IpcFrame[] = [];
    for (const byte of Buffer.from('{"type":"result","id":"r1","data":"中文🧪内容"}\n')) {
      frames.push(...decoder.push(Buffer.from([byte])));
    }
    expect(frames).toEqual([{ type: 'result', id: 'r1', data: '中文🧪内容' }]);
  });

  it('applies the byte limit per frame when multiple frames share a chunk', () => {
    const decoder = new NdjsonDecoder(16);
    expect([...decoder.push(Buffer.from('{"type":"ready"}\n{"type":"ready"}\n'))]).toEqual([{ type: 'ready' }, { type: 'ready' }]);
  });

  it('rejects a partial frame when successive chunks cross its budget', () => {
    const decoder = new NdjsonDecoder(8);
    expect([...decoder.push(Buffer.from('1234'))]).toEqual([]);
    expect(() => [...decoder.push(Buffer.from('56789'))]).toThrow('byte limit');
  });

  it('rejects invalid UTF-8 instead of silently replacing data', () => {
    const decoder = new NdjsonDecoder();
    const bytes = Buffer.concat([Buffer.from('{"type":"result","id":"r","data":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
    expect(() => [...decoder.push(bytes)]).toThrow();
  });
});

describe('IPC client (host failures and stream disposal)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function peer(receive: (frame: IpcFrame, socket: Socket) => void) {
    const root = await mkdtemp(join(tmpdir(), 'klient-peer-'));
    const socketPath = join(root, 'peer.sock');
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      const decoder = new NdjsonDecoder();
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) receive(frame, socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(root, { recursive: true, force: true });
    });
    return socketPath;
  }

  it('rejects a call when hello never completes even with RPC deadlines disabled', async () => {
    const socketPath = await peer(() => {});
    const channel = new IpcChannel({ socketPath, callTimeoutMs: 0, handshakeTimeoutMs: 25 });
    cleanups.push(() => channel.close());
    await expect(channel.call({}, 'example', 'read', [])).rejects.toThrow('handshake timed out');
  });

  it('rejects a stream when its initial handshake fails', async () => {
    const socketPath = await peer(() => {});
    const channel = new IpcChannel({ socketPath, handshakeTimeoutMs: 25 });
    cleanups.push(() => channel.close());
    const iterator = channel.stream({}, 'example', 'read', [])[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('handshake timed out');
  });

  it('rejects pending calls when the peer sends a non-object frame', async () => {
    const socketPath = await peer((frame, socket) => {
      if (frame.type === 'hello') socket.write(encodeFrame({ type: 'hello_result' }));
      else socket.write('null\n');
    });
    const channel = new IpcChannel({ socketPath });
    cleanups.push(() => channel.close());
    await expect(channel.call({}, 'example', 'read', [])).rejects.toThrow('Invalid IPC frame');
  });

  it('rejects pending calls when a response exceeds its byte budget without a newline', async () => {
    const socketPath = await peer((frame, socket) => {
      socket.write(frame.type === 'hello' ? encodeFrame({ type: 'hello_result' }) : 'x'.repeat(129));
    });
    const channel = new IpcChannel({ socketPath, maxFrameBytes: 128 });
    cleanups.push(() => channel.close());
    await expect(channel.call({}, 'example', 'read', [])).rejects.toThrow('byte limit');
  });

  it('does not send a stream cancelled before hello completes', async () => {
    const received: string[] = [];
    const socketPath = await peer((frame, socket) => {
      received.push(frame.type);
      socket.write(frame.type === 'hello' ? encodeFrame({ type: 'hello_result' }) : encodeFrame({ type: 'result', id: frame.id }));
    });
    const channel = new IpcChannel({ socketPath });
    cleanups.push(() => channel.close());
    const iterator = channel.stream({}, 'example', 'read', [])[Symbol.asyncIterator]();
    const next = iterator.next();
    await iterator.return?.();
    await channel.call({}, 'example', 'barrier', []);
    expect(received).not.toContain('stream');
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });

  it('cancels a stream when a slow consumer exceeds its buffer budget', async () => {
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const socketPath = await peer((frame, socket) => {
      if (frame.type === 'hello') socket.write(encodeFrame({ type: 'hello_result' }));
      if (frame.type === 'stream') {
        socket.write(Array.from({ length: 100 }, () => encodeFrame({ type: 'stream_data', id: frame.id, data: '0123456789' })).join(''));
      }
      if (frame.type === 'stream_cancel') cancelled();
    });
    const channel = new IpcChannel({ socketPath, maxFrameBytes: 256 });
    cleanups.push(() => channel.close());
    const iterator = channel.stream({}, 'example', 'read', [])[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: '0123456789' });
    await cancellation;
    await expect(iterator.next()).rejects.toThrow('stream buffer limit');
  });
});

describe('ipc transport specifics', () => {
  let homeDir: string;
  let app: TestEngine['app'];
  let host: KlientIpcHost | undefined;

  async function setup(opts: { token?: string; handshakeTimeoutMs?: number; maxFrameBytes?: number } = {}): Promise<string> {
    ({ homeDir, app } = await makeEngine());
    const socketPath = join(homeDir, 'klient.sock');
    host = await serveKlientIpc({ scope: app, socketPath, ...opts });
    return socketPath;
  }

  async function teardown(): Promise<void> {
    await host?.close();
    host = undefined;
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  it.each(['null\n', '[]\n', '{"type":42}\n', '{"type":"call","id":{},"service":"example","method":"get"}\n', '{broken}\n'])('isolates an invalid unauthenticated frame %s without stopping the host', async (payload) => {
    const socketPath = await setup({ token: 'TEST_ONLY_TOKEN' });
    const socket = createConnection(socketPath);
    socket.resume();
    socket.on('error', () => {});
    const closed = once(socket, 'close');
    const client = createKlient({ socketPath, token: 'TEST_ONLY_TOKEN' });
    try {
      await once(socket, 'connect');
      socket.write(payload);
      await closed;
      await expect(client.global.env()).resolves.toMatchObject({ platform: process.platform });
    } finally { socket.destroy(); await client.close(); await teardown(); }
  });

  it('closes an unfinished frame when its byte budget is exceeded', async () => {
    const socketPath = await setup({ maxFrameBytes: 128 });
    const socket = createConnection(socketPath);
    socket.resume();
    socket.on('error', () => {});
    const closed = once(socket, 'close');
    try {
      await once(socket, 'connect');
      socket.write('x'.repeat(129));
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally { socket.destroy(); await teardown(); }
  });

  it('closes a client that never sends hello by the handshake deadline', async () => {
    const socketPath = await setup({ handshakeTimeoutMs: 25 });
    const socket = createConnection(socketPath);
    socket.resume();
    socket.on('error', () => {});
    try {
      await once(socket, 'close');
      expect(socket.destroyed).toBe(true);
    }
    finally { socket.destroy(); await teardown(); }
  });

  it.skipIf(process.platform === 'win32')('restricts a Unix socket to its owning user', async () => {
    const socketPath = await setup();
    try { expect((await stat(socketPath)).mode & 0o777).toBe(0o600); }
    finally { await teardown(); }
  });

  it('cancels an upstream request while the first stream item is still pending', async () => {
    const socketPath = await setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const catalog = app.accessor.get(IModelCatalog);
    const requester = catalog.getRequester;
    const request = vi.fn(async function* (_input: unknown, signal: AbortSignal) {
      started();
      await new Promise<void>((resolve) => {
        if (signal.aborted) { cancelled(); resolve(); return; }
        signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true });
      });
      yield { type: 'text', text: 'late output' };
    });
    const spy = vi.spyOn(catalog, 'getRequester').mockReturnValue({ request } as unknown as ReturnType<typeof requester>);
    const channel = new IpcChannel({ socketPath });
    try {
      const iterator = channel.stream({}, 'modelResolver', 'generate', ['example', {}])[Symbol.asyncIterator]();
      const next = iterator.next();
      await ready;
      await iterator.return?.();
      await cancellation;
      await expect(next).resolves.toEqual({ done: true, value: undefined });
    } finally { await channel.close(); spy.mockRestore(); await teardown(); }
  });

  it('rejects calls when the socket path does not exist', async () => {
    const klient = createKlient({ socketPath: join(tmpdir(), 'klient-no-such.sock') });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();
  });

  it('rejects calls made after close', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath });
    await klient.global.env();
    await klient.close();
    // env() is served from its frozen-snapshot cache after the first call, so
    // probe the closed channel with an uncached method instead.
    await expect(klient.global.workspaces.list()).rejects.toThrow('ipc closed');
    await teardown();
  });

  it('reports an idle transport disconnect without requiring another RPC', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath });
    const onError = vi.fn();
    klient.events.onError(onError);
    klient.events.on('kosong.models.changed', () => {});
    try {
      await klient.global.env();
      await host!.close();
      host = undefined;
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'ipc closed' })));
    } finally { await klient.close(); await teardown(); }
  });

  it('does not report intentional client disposal as a disconnect', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath });
    const onError = vi.fn();
    klient.events.onError(onError);
    klient.events.on('kosong.models.changed', () => {});
    try {
      await klient.global.env();
      await klient.close();
      expect(onError).not.toHaveBeenCalled();
    } finally { await teardown(); }
  });

  it('drops clients whose hello token mismatches', async () => {
    const socketPath = await setup({ token: 'right' });
    const klient = createKlient({ socketPath, token: 'wrong' });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();

    const ok = createKlient({ socketPath, token: 'right' });
    await expect(ok.global.env()).resolves.toMatchObject({ platform: process.platform });
    await ok.close();
    await teardown();
  });

  it('completeAuth outlives the channel default call timeout', async () => {
    const socketPath = await setup();
    // A slow engine-side wait: without the facade's per-call deadline the
    // channel's default would kill the long poll mid-flight.
    const management = app.accessor.get(IMcpManagementService);
    const completeSpy = vi
      .spyOn(management, 'completeServerAuth')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
      );
    const cancelSpy = vi
      .spyOn(management, 'cancelServerAuth')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
      );
    const klient = createKlient({ socketPath, callTimeoutMs: 25 });
    try {
      // completeAuth passes the engine wait + margin as its per-call deadline,
      // so the 200ms wait resolves instead of dying at the 25ms default.
      await expect(
        klient.global.mcp.completeAuth({ flowId: 'flow-1', timeoutMs: 100 }),
      ).resolves.toBeUndefined();
      // Calls without the override still die at the channel default.
      await expect(klient.global.mcp.cancelAuth({ flowId: 'flow-1' })).rejects.toThrow(
        'call timed out after 25ms',
      );
    } finally {
      completeSpy.mockRestore();
      cancelSpy.mockRestore();
      await klient.close();
    }
    await teardown();
  });

  it('completeAuth clamps a near-max timeoutMs instead of overflowing the call timer', async () => {
    const socketPath = await setup();
    const management = app.accessor.get(IMcpManagementService);
    const completeSpy = vi
      .spyOn(management, 'completeServerAuth')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      );
    const klient = createKlient({ socketPath, callTimeoutMs: 25 });
    try {
      // timeoutMs at the contract max plus the facade margin would overflow
      // Node's 32-bit setTimeout into ~1ms; the clamp keeps the call alive
      // until the engine-side wait resolves.
      await expect(
        klient.global.mcp.completeAuth({ flowId: 'flow-1', timeoutMs: 2 ** 31 - 1 }),
      ).resolves.toBeUndefined();
      expect(completeSpy).toHaveBeenCalled();
    } finally {
      completeSpy.mockRestore();
      await klient.close();
    }
    await teardown();
  });
});

describe('IPC response and call budgets', () => {
  it('rejects a large response without closing the connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klient-budget-'));
    const service = { read(size: number) { return 'x'.repeat(size); } };
    const host = await serveKlientIpc({ socketPath: join(root, 'ipc.sock'), maxFrameBytes: 1024, scope: { accessor: { get: <T>() => service as T } } });
    const channel = new IpcChannel({ socketPath: host.socketPath });
    try {
      await expect(channel.call({}, 'modelResolver', 'read', [2048])).rejects.toMatchObject({ code: 41301 });
      await expect(channel.call({}, 'modelResolver', 'read', [2])).resolves.toBe('xx');
    } finally { await channel.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps a connection usable after rejecting a large outgoing request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klient-budget-'));
    const service = { echo(value: string) { return value; } };
    const host = await serveKlientIpc({ socketPath: join(root, 'ipc.sock'), scope: { accessor: { get: <T>() => service as T } } });
    const channel = new IpcChannel({ socketPath: host.socketPath, maxFrameBytes: 1024 });
    try {
      await expect(channel.call({}, 'modelResolver', 'echo', ['x'.repeat(2048)])).rejects.toMatchObject({ code: 41301 });
      await expect(channel.call({}, 'modelResolver', 'echo', ['ok'])).resolves.toBe('ok');
    } finally { await channel.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('retains the global call budget for pending operations after a client disconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klient-budget-'));
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const service = { async slow() { started(); await pending; return true; } };
    const host = await serveKlientIpc({ socketPath: join(root, 'ipc.sock'), maxTotalCalls: 1, scope: { accessor: { get: <T>() => service as T } } });
    const first = new IpcChannel({ socketPath: host.socketPath });
    const second = new IpcChannel({ socketPath: host.socketPath });
    try {
      const call = first.call({}, 'modelResolver', 'slow', []).catch(() => {});
      await entered;
      await first.close();
      await call;
      await expect(second.call({}, 'modelResolver', 'slow', [])).rejects.toMatchObject({ code: 42901 });
    } finally { release(); await first.close(); await second.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
  });
});
