import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ErrorCodes } from '#/errors';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  type TerminalAttachSink,
  type TerminalFrame,
  type TerminalProcess,
  type TerminalSpawnOptions,
  IHostTerminalService,
} from '#/os/interface/terminal';
import { HostTerminalService } from '#/os/backends/node-local/hostTerminalService';
import {
  ISessionTerminalService,
  SessionTerminalService,
} from '#/session/terminal/terminalService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { RuntimeLease } from '#/runtime/runtime';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IRuntimeResolver, type IRuntimeResolver as RuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

class FakeTerminalProcess implements TerminalProcess {
  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<{ exitCode: number | null }>();
  readonly onProcessData = this.dataEmitter.event;
  readonly onProcessExit = this.exitEmitter.event;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    this.dataEmitter.fire(data);
  }
  emitExit(exitCode: number | null): void {
    this.exitEmitter.fire({ exitCode });
  }
  dispose(): void {
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
  }
}

class FakeHostTerminalService implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;
  readonly processes: FakeTerminalProcess[] = [];
  readonly lastOptions: TerminalSpawnOptions[] = [];

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    this.lastOptions.push(options);
    const proc = new FakeTerminalProcess();
    this.processes.push(proc);
    return Promise.resolve(proc);
  }
}

class FakeRuntimeResolver implements RuntimeResolver {
  declare readonly _serviceBrand: undefined;
  activeLeases = 0;
  readonly bindings: Array<{ workspaceId: string; runtimeId: string }> = [];
  private readonly runtime;

  constructor(
    terminal: IHostTerminalService,
    runtimeId = 'local',
    mapWorkspaceRoots?: (roots: { workDir: string; additionalDirs?: readonly string[] }) => {
      workDir: string;
      additionalDirs?: readonly string[];
    },
  ) {
    this.runtime = Object.assign(
      new FakeRuntime(
        { workspaceId: 'w1', runtimeId, generation: 'test' },
        { capabilities: ['terminal'], mapWorkspaceRoots },
      ),
      { terminal },
    );
  }

  inspect() {
    return this.runtime;
  }

  acquire(binding: { workspaceId: string; runtimeId: string }): RuntimeLease {
    this.bindings.push(binding);
    this.activeLeases += 1;
    let active = true;
    return {
      runtime: this.runtime,
      track: (resource) => resource,
      dispose: () => {
        if (!active) return;
        active = false;
        this.activeLeases -= 1;
      },
    };
  }
}

function stubWorkspace(workDir = '/ws'): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs: [],
    resolve: (rel) => resolve(workDir, rel),
    isWithin: () => true,
    assertAllowed: (absPath) => resolve(workDir, absPath),
  };
}

function stubSessionContext(sessionId = 's1'): ISessionContext {
  return makeSessionContext({
    sessionId,
    workspaceId: 'w1',
    sessionDir: '/ws/.session',
    sessionScope: `session:${sessionId}`,
    metaScope: `session:${sessionId}`,
    cwd: '/ws',
  });
}

function collectSink(id = 'sink-1'): { sink: TerminalAttachSink; frames: TerminalFrame[] } {
  const frames: TerminalFrame[] = [];
  return { sink: { id, send: (frame) => frames.push(frame) }, frames };
}

describe('SessionTerminalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let host: FakeHostTerminalService;
  let resolver: FakeRuntimeResolver;

  beforeEach(() => {
    disposables = new DisposableStore();
    host = new FakeHostTerminalService();
    resolver = new FakeRuntimeResolver(host);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IHostTerminalService, host);
        reg.defineInstance(IRuntimeResolver, resolver);
        reg.define(ISessionTerminalService, SessionTerminalService);
        reg.defineInstance(ISessionWorkspaceContext, stubWorkspace());
        reg.defineInstance(ISessionContext, stubSessionContext());
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('creates a terminal and resolves cwd through the workspace', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local', cwd: 'sub', cols: 100, rows: 40 });

    expect(terminal.status).toBe('running');
    expect(terminal.session_id).toBe('s1');
    expect(terminal.cwd).toBe(resolve('/ws', 'sub'));
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(40);
    expect(host.processes).toHaveLength(1);
    expect(host.lastOptions[0]?.cwd).toBe(resolve('/ws', 'sub'));
  });

  it('uses the selected non-local runtime mapping and terminal instead of the App host', async () => {
    const remoteHost = new FakeHostTerminalService();
    resolver = new FakeRuntimeResolver(
      remoteHost,
      'remote',
      (roots) => ({ ...roots, workDir: '/remote/workspace' }),
    );
    ix.set(IRuntimeResolver, resolver);
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'remote', cwd: 'sub' });

    expect(resolver.bindings).toEqual([{ workspaceId: 'w1', runtimeId: 'remote' }]);
    expect(terminal.cwd).toBe('/remote/workspace/sub');
    expect(remoteHost.lastOptions[0]?.cwd).toBe('/remote/workspace/sub');
    expect(host.processes).toHaveLength(0);
    expect(resolver.activeLeases).toBe(1);
    await svc.close(terminal.id);
    expect(resolver.activeLeases).toBe(0);
  });

  it('uses the workspace workDir when cwd is omitted', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local' });
    expect(terminal.cwd).toBe('/ws');
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  it('lists and gets terminals', async () => {
    const svc = ix.get(ISessionTerminalService);
    const created = await svc.create({ runtime_id: 'local',});
    const listed = await svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const fetched = await svc.get(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('throws TERMINAL_NOT_FOUND for an unknown terminal', async () => {
    const svc = ix.get(ISessionTerminalService);
    await expect(svc.get('nope')).rejects.toMatchObject({
      code: ErrorCodes.TERMINAL_NOT_FOUND,
    });
  });

  it('attaches a sink, replays buffered frames, then streams live output', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local' });
    const proc = host.processes[0]!;

    proc.emitData('hello');
    const { sink, frames } = collectSink();
    const { replayed } = await svc.attach(terminal.id, sink);
    expect(replayed).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'terminal_output',
      seq: 1,
      session_id: 's1',
      terminal_id: terminal.id,
      payload: { data: 'hello' },
    });

    proc.emitData('world');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ type: 'terminal_output', seq: 2, payload: { data: 'world' } });
  });

  it('replays only frames after sinceSeq', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local' });
    const proc = host.processes[0]!;
    proc.emitData('a');
    proc.emitData('b');
    proc.emitData('c');

    const { sink, frames } = collectSink();
    const { replayed } = await svc.attach(terminal.id, sink, { sinceSeq: 1 });
    expect(replayed).toBe(2);
    expect(frames.map((f) => (f as { seq?: number }).seq)).toEqual([2, 3]);
  });

  it('emits an exit frame and marks the terminal exited on process exit', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local' });
    const proc = host.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);
    expect(resolver.activeLeases).toBe(1);

    proc.emitExit(7);

    expect(resolver.activeLeases).toBe(0);
    const exitFrame = frames.find((f) => f.type === 'terminal_exit');
    expect(exitFrame).toMatchObject({
      type: 'terminal_exit',
      terminal_id: terminal.id,
      payload: { exit_code: 7 },
    });
    const fetched = await svc.get(terminal.id);
    expect(fetched.status).toBe('exited');
    expect(fetched.exit_code).toBe(7);
  });

  it('delegates write and resize to the process', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local' });
    const proc = host.processes[0]!;

    await svc.write(terminal.id, 'ls\n');
    await svc.resize(terminal.id, 120, 50);

    expect(proc.writes).toEqual(['ls\n']);
    expect(proc.resizes).toEqual([[120, 50]]);
    expect((await svc.get(terminal.id)).cols).toBe(120);
  });

  it('closes a terminal by killing the process and marking it exited', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local' });
    const proc = host.processes[0]!;

    const result = await svc.close(terminal.id);
    expect(result).toEqual({ closed: true });
    expect(proc.killed).toBe(true);
    expect((await svc.get(terminal.id)).status).toBe('exited');
  });

  it('detaches a sink so it stops receiving frames', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ runtime_id: 'local' });
    const proc = host.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);

    svc.detach(terminal.id, sink.id);
    proc.emitData('after-detach');
    expect(frames).toHaveLength(0);
  });

  it('kills every live process when the service is disposed', async () => {
    const svc = ix.get(ISessionTerminalService);
    await svc.create({ runtime_id: 'local' });
    const proc = host.processes[0]!;
    expect(resolver.activeLeases).toBe(1);

    disposables.dispose();
    expect(proc.killed).toBe(true);
    expect(resolver.activeLeases).toBe(0);
  });

  describe('open', () => {
    function openIter(svc: ISessionTerminalService) {
      return svc.open({ runtime_id: 'local' })[Symbol.asyncIterator]();
    }

    it('yields terminal_ready before attached output', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter = openIter(svc);
      const ready = await iter.next();
      expect(ready.done).toBe(false);
      expect(ready.value).toMatchObject({ type: 'terminal_ready' });
      const terminal = (ready.value as { terminal: { id: string; cols: number } }).terminal;
      expect(terminal.id).toBeTruthy();
      expect(host.processes).toHaveLength(1);

      const proc = host.processes[0]!;
      proc.emitData('first');
      proc.emitData('second');
      const out1 = await iter.next();
      const out2 = await iter.next();
      expect(out1.value).toMatchObject({
        type: 'terminal_output',
        terminal_id: terminal.id,
        payload: { data: 'first' },
      });
      expect(out2.value).toMatchObject({
        type: 'terminal_output',
        payload: { data: 'second' },
      });
      await iter.return!();
    });

    it('does not create a PTY until the first next()', async () => {
      const svc = ix.get(ISessionTerminalService);
      svc.open({ runtime_id: 'local' });
      svc.open({ runtime_id: 'local' })[Symbol.asyncIterator]();
      expect(host.processes).toHaveLength(0);
    });

    it('propagates UTF-8 writes and resize to the spawned process', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter = svc
        .open({ runtime_id: 'local', cols: 90, rows: 30 })
        [Symbol.asyncIterator]();
      const ready = await iter.next();
      const terminal = (ready.value as { terminal: { id: string; cols: number; rows: number } })
        .terminal;
      expect(terminal.cols).toBe(90);
      expect(terminal.rows).toBe(30);

      const proc = host.processes[0]!;
      await svc.write(terminal.id, 'echo 世界\n');
      await svc.resize(terminal.id, 120, 40);
      expect(proc.writes).toEqual(['echo 世界\n']);
      expect(proc.resizes).toEqual([[120, 40]]);
      expect((await svc.get(terminal.id)).cols).toBe(120);

      proc.emitData('ok ✓');
      const out = await iter.next();
      expect(out.value).toMatchObject({ payload: { data: 'ok ✓' } });
      await iter.return!();
    });

    it('emits terminal_exit once then finishes after the consumer drains it', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter = openIter(svc);
      const ready = await iter.next();
      const id = (ready.value as { terminal: { id: string } }).terminal.id;

      host.processes[0]!.emitExit(7);
      const exit = await iter.next();
      expect(exit.value).toMatchObject({
        type: 'terminal_exit',
        terminal_id: id,
        payload: { exit_code: 7 },
      });
      const after = await iter.next();
      expect(after.done).toBe(true);
      expect((await svc.get(id)).status).toBe('exited');
    });

    it('closes the freshly created PTY when returned while creation is pending', async () => {
      const svc = ix.get(ISessionTerminalService);
      const proc = new FakeTerminalProcess();
      let releaseSpawn: (process: TerminalProcess) => void = () => undefined;
      const gate = new Promise<TerminalProcess>((resolve) => {
        releaseSpawn = resolve;
      });
      vi.spyOn(host, 'spawn').mockReturnValueOnce(gate);

      const iter = openIter(svc);
      const pendingNext = iter.next();
      const returned = await iter.return!();
      expect(returned.done).toBe(true);
      await expect(pendingNext).resolves.toMatchObject({ done: true });

      releaseSpawn(proc);
      await vi.waitFor(() => expect(proc.killed).toBe(true));
      await expect(svc.list()).resolves.toHaveLength(1);
      await expect(svc.list()).resolves.toMatchObject([{ status: 'exited' }]);
    });

    it('never spawns when returned before the first next()', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter = openIter(svc);
      const returned = await iter.return!();
      expect(returned.done).toBe(true);
      expect(host.processes).toHaveLength(0);
      const late = await iter.next();
      expect(late.done).toBe(true);
      expect(host.processes).toHaveLength(0);
    });

    it('detaches its sink when return() lands while attach is in flight', async () => {
      const svc = ix.get(ISessionTerminalService);
      let releaseAttach: (value: { replayed: number }) => void = () => undefined;
      vi.spyOn(svc, 'attach').mockImplementation(
        () =>
          new Promise<{ replayed: number }>((resolve) => {
            releaseAttach = resolve;
          }),
      );
      const iter = openIter(svc);
      const first = iter.next();
      await vi.waitFor(() => expect(svc.list()).resolves.toHaveLength(1));
      await iter.return!();
      const terminalId = (await svc.list())[0]!.id;
      const detachSpy = vi.spyOn(svc, 'detach');
      releaseAttach({ replayed: 0 });
      await expect(first).resolves.toMatchObject({ done: false });
      await vi.waitFor(() =>
        expect(detachSpy).toHaveBeenCalledWith(terminalId, expect.any(String)),
      );
    });

    it('counts multibyte output toward the byte budget', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter = openIter(svc);
      await iter.next();
      const proc = host.processes[0]!;
      proc.emitData('中'.repeat(400_000));
      await expect(iter.next()).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
      });
      await vi.waitFor(() => expect(proc.killed).toBe(true));
    });

    it('return() resolves a pending next() on a live stream and closes only its terminal', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter1 = openIter(svc);
      const iter2 = openIter(svc);
      await iter1.next();
      await iter2.next();
      const proc1 = host.processes[0]!;
      const proc2 = host.processes[1]!;

      const waiting = iter1.next();
      await iter1.return!();
      await expect(waiting).resolves.toMatchObject({ done: true });
      await vi.waitFor(() => expect(proc1.killed).toBe(true));
      expect(proc2.killed).toBe(false);

      proc2.emitData('still alive');
      const out = await iter2.next();
      expect(out.value).toMatchObject({ payload: { data: 'still alive' } });
      await iter2.return!();
    });

    it('fails a slow reader and closes only that terminal', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter1 = openIter(svc);
      const iter2 = openIter(svc);
      const ready1 = await iter1.next();
      await iter2.next();
      const proc1 = host.processes[0]!;
      const proc2 = host.processes[1]!;

      for (let i = 0; i < 200; i += 1) {
        proc1.emitData('x'.repeat(8192));
      }
      await expect(iter1.next()).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
      });
      await vi.waitFor(() => expect(proc1.killed).toBe(true));
      expect(proc2.killed).toBe(false);

      proc2.emitData('unaffected');
      const out = await iter2.next();
      expect(out.value).toMatchObject({ payload: { data: 'unaffected' } });
      await iter2.return!();
    });

    it('rejects invalid open requests synchronously', async () => {
      const svc = ix.get(ISessionTerminalService);
      expect(() => svc.open({ runtime_id: '' })).toThrowError(
        expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }),
      );
      expect(() => svc.open({ runtime_id: 'local', cols: 0 })).toThrowError(
        expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }),
      );
      expect(() => svc.open({ runtime_id: 'local', rows: 1001 })).toThrowError(
        expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }),
      );
      expect(() =>
        svc.open({ runtime_id: 'local', shell: '/bin/evil' } as never),
      ).toThrowError(expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }));
      expect(host.processes).toHaveLength(0);
    });

    it('dispose finishes a pending stream and kills its PTY', async () => {
      const svc = ix.get(ISessionTerminalService);
      const iter = openIter(svc);
      await iter.next();
      const waiting = iter.next();
      disposables.dispose();
      await expect(waiting).resolves.toMatchObject({ done: true });
      expect(host.processes[0]!.killed).toBe(true);
    });
  });
});

describe('HostTerminalService (App scope)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostTerminalService, HostTerminalService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('spawns a PTY through node-pty and forwards events', async () => {
    const { spawn } = await import('node-pty');
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    const mockPty = {
      onData: (listener: (data: string) => void) => {
        dataListeners.add(listener);
        return toDisposable(() => dataListeners.delete(listener));
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exitListeners.add(listener);
        return toDisposable(() => exitListeners.delete(listener));
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockPty as unknown as import('node-pty').IPty);

    const svc = ix.get(IHostTerminalService);
    const proc = await svc.spawn({ cwd: '/ws', shell: '/bin/sh', cols: 80, rows: 24 });

    expect(spawn).toHaveBeenCalledWith('/bin/sh', [], {
      name: 'xterm-256color',
      cwd: '/ws',
      cols: 80,
      rows: 24,
      env: process.env,
    });

    let receivedData = '';
    proc.onProcessData((data) => {
      receivedData += data;
    });
    for (const listener of dataListeners) listener('hello');
    expect(receivedData).toBe('hello');

    let receivedExit: { exitCode: number | null } | undefined;
    proc.onProcessExit((event) => {
      receivedExit = event;
    });
    for (const listener of exitListeners) listener({ exitCode: 5 });
    expect(receivedExit).toEqual({ exitCode: 5 });

    proc.write('ls\n');
    expect(mockPty.write).toHaveBeenCalledWith('ls\n');

    proc.resize(120, 50);
    expect(mockPty.resize).toHaveBeenCalledWith(120, 50);

    proc.kill();
    expect(mockPty.kill).toHaveBeenCalled();
  });
});
