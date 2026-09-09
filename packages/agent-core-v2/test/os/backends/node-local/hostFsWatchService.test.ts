import { readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import type {
  HostFsChange,
  IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type HostFsWatchRuntime = NonNullable<ConstructorParameters<typeof HostFsWatchService>[0]>;

class TestNativeWatcher {
  private errorListener: ((error: NodeJS.ErrnoException) => void) | undefined;
  closed = false;

  on(_event: 'error', listener: (error: NodeJS.ErrnoException) => void): this {
    this.errorListener = listener;
    return this;
  }

  close(): void {
    this.closed = true;
  }

  fail(code = 'EIO'): void {
    this.errorListener?.(Object.assign(new Error('native watch failed'), { code }));
  }
}

interface TestNativeAttempt {
  readonly watcher: TestNativeWatcher;
  emit(filename: string | null): void;
}

interface TestRetry {
  readonly delayMs: number;
  readonly active: boolean;
  run(): void;
}

function signalRig(options?: { readonly synchronousFailures?: number }): {
  readonly service: IHostFsWatchService;
  readonly attempts: TestNativeAttempt[];
  readonly retries: TestRetry[];
  attempt(index: number): TestNativeAttempt;
  retry(index: number): TestRetry;
} {
  const attempts: TestNativeAttempt[] = [];
  const retries: TestRetry[] = [];
  let synchronousFailures = options?.synchronousFailures ?? 0;
  const runtime: HostFsWatchRuntime = {
    platform: 'darwin',
    watchNative: (_root, listener) => {
      if (synchronousFailures > 0) {
        synchronousFailures -= 1;
        throw Object.assign(new Error('native watch creation failed'), { code: 'EIO' });
      }
      const watcher = new TestNativeWatcher();
      attempts.push({
        watcher,
        emit: (filename) => {
          listener('rename', filename);
        },
      });
      return watcher;
    },
    scheduleRetry: (callback, delayMs) => {
      let active = true;
      retries.push({
        delayMs,
        get active() {
          return active;
        },
        run: () => {
          if (!active) return;
          active = false;
          callback();
        },
      });
      return {
        dispose: () => {
          active = false;
        },
      };
    },
  };
  return {
    service: new HostFsWatchService(runtime),
    attempts,
    retries,
    attempt: (index) => requiredAt(attempts, index),
    retry: (index) => requiredAt(retries, index),
  };
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing test value at index ${index}`);
  return value;
}

describe('host filesystem change notifications', () => {
  let root: string;
  let handle: IHostFsWatchHandle | undefined;

  beforeEach(() => {
    setUnexpectedErrorHandler(() => undefined);
  });

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
    resetUnexpectedErrorHandler();
  });

  async function start(recursive = true): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive });
    handle.onDidChange((e) => events.push(e));
    await handle.ready;
    return events;
  }

  it('waits for ignore rules before scanning and prunes ignored directories', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-ignore-ready-'));
    await mkdir(join(root, 'build', 'nested'), { recursive: true });
    await writeFile(join(root, 'build', 'nested', 'artifact'), 'output');
    let release!: () => void;
    const ignoredReady = new Promise<void>((resolve) => { release = resolve; });
    const visited: string[] = [];
    const service = new HostFsWatchService();
    handle = service.watch(root, {
      ignoredReady,
      ignored: (path, kind) => {
        visited.push(path);
        return path === join(root, 'build') && kind === 'directory';
      },
    });
    await wait(30);
    expect(visited).toEqual([]);
    release();
    await handle.ready;
    expect(visited).toContain(join(root, 'build'));
    expect(visited).not.toContain(join(root, 'build', 'nested', 'artifact'));
  });

  async function startSignal(ignored?: (path: string) => boolean): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive: true, signal: true, ignored });
    handle.onDidChange((e) => events.push(e));
    await handle.ready;
    return events;
  }

  it('invalidates a named file without scanning unrelated sibling entries', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-target-'));
    const file = join(root, 'config.toml');
    await writeFile(file, 'one');
    await writeFile(join(root, 'unrelated.txt'), 'ignored');
    const visited: string[] = [];
    const events: HostFsChange[] = [];
    const filter = subtreeWatchFilter(root, [file]);
    handle = new HostFsWatchService().watch(root, {
      signal: true, targets: [file],
      ignored: (path) => { visited.push(path); return filter(path); },
    });
    handle.onDidChange((event) => events.push(event));
    await handle.ready;

    expect(visited).not.toContain(join(root, 'unrelated.txt'));
    await writeFile(file, 'two');

    await vi.waitFor(() => expect(events).toContainEqual({ path: root, action: 'modified', kind: 'directory' }));
  });

  it('follows a named file when its missing parent is created', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-target-created-'));
    const file = join(root, 'config', 'local.toml');
    const events: HostFsChange[] = [];
    handle = new HostFsWatchService().watch(root, {
      signal: true, targets: [file], ignored: subtreeWatchFilter(root, [file]),
    });
    handle.onDidChange((event) => events.push(event));
    await handle.ready;

    await mkdir(dirname(file));
    await writeFile(file, 'one');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await wait(100);
    events.length = 0;
    await writeFile(file, 'two');

    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  });

  it('rearms a named subtree after it is deleted and recreated', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-target-recreated-'));
    const target = join(root, 'skills');
    await mkdir(target);
    const events: HostFsChange[] = [];
    handle = new HostFsWatchService().watch(root, {
      signal: true, targets: [target], ignored: subtreeWatchFilter(root, [target]),
    });
    handle.onDidChange((event) => events.push(event));
    await handle.ready;

    await rm(target, { recursive: true });
    await mkdir(target);
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await wait(100);
    events.length = 0;
    await writeFile(join(target, 'SKILL.md'), 'new skill');

    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  });

  it('rearms named targets when the watched root is recreated', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-root-recreated-'));
    const watchedRoot = join(root, 'project');
    await mkdir(watchedRoot);
    const target = join(watchedRoot, 'config.toml');
    const events: HostFsChange[] = [];
    handle = new HostFsWatchService().watch(watchedRoot, {
      signal: true, targets: [target], ignored: subtreeWatchFilter(watchedRoot, [target]),
    });
    handle.onDidChange((event) => events.push(event));
    await handle.ready;

    await rm(watchedRoot, { recursive: true });
    await wait(100);
    await mkdir(watchedRoot);
    await writeFile(target, 'one');
    await wait(100);
    events.length = 0;
    await writeFile(target, 'two');

    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  });

  it('settles target watch readiness when disposed before ignore rules load', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-target-dispose-'));
    handle = new HostFsWatchService().watch(root, {
      signal: true, targets: [join(root, 'config.toml')], ignoredReady: new Promise<void>(() => {}),
    });

    handle.dispose();

    await expect(handle.ready).resolves.toBeUndefined();
  });

  it('emits a coarse root invalidation when a native signal path changes', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('skills/demo/SKILL.md');

    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('does not invalidate when a native signal path is ignored', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', {
      signal: true,
      ignored: (path) => path.includes('node_modules'),
    });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('node_modules/pkg/index.js');

    expect(events).toEqual([]);
  });

  it('increases the retry delay after consecutive native failures', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).watcher.fail();
    rig.retry(1).run();
    rig.attempt(2).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 2000, 4000]);
  });

  it('invalidates again after a native watch is rearmed', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();

    expect(events).toEqual([
      { path: '/repo', action: 'modified', kind: 'directory' },
      { path: '/repo', action: 'modified', kind: 'directory' },
    ]);
  });

  it('invalidates after recovering from a synchronous native-watch creation failure', () => {
    const rig = signalRig({ synchronousFailures: 1 });
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.retry(0).run();

    expect(rig.attempts).toHaveLength(1);
    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('resets the retry delay after the recovered native watch emits an event', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).emit('skills/demo/SKILL.md');
    rig.attempt(1).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 1000]);
  });

  it('cancels a pending native retry when the watch handle is disposed', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });
    rig.attempt(0).watcher.fail();

    handle.dispose();
    handle = undefined;
    rig.retry(0).run();

    expect(rig.retry(0).active).toBe(false);
    expect(rig.attempt(0).watcher.closed).toBe(true);
    expect(rig.attempts).toHaveLength(1);
  });

  it('reports create / modify / delete for a file', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    await wait(300);
    await writeFile(file, 'v2');
    await wait(300);
    await rm(file);
    await wait(300);

    const actions = events.filter((e) => e.path === file).map((e) => e.action);
    expect(actions).toContain('created');
    expect(actions).toContain('modified');
    expect(actions).toContain('deleted');
    expect(events.find((e) => e.path === file)?.kind).toBe('file');
  });

  it('does not fire for paths ignored by default (.git)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'x');
    await wait(300);

    expect(events.some((e) => e.path.includes('/.git/') || e.path.endsWith('/.git'))).toBe(false);
  });

  it('does not fire for pre-existing files (ignoreInitial)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const preexisting = join(root, 'pre.txt');
    await writeFile(preexisting, 'v0');

    const events = await start();
    await wait(300);

    expect(events.some((e) => e.path === preexisting)).toBe(false);
  });

  it('stops firing after the handle is disposed', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    handle?.dispose();
    handle = undefined;

    await writeFile(join(root, 'after-dispose.txt'), 'x');
    await wait(300);

    expect(events).toHaveLength(0);
  });

  it.skipIf(process.platform !== 'darwin')(
    'signal mode keeps the fd footprint bounded on a fat subtree',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'hostfswatch-fat-'));
      const fat = join(root, 'fat');
      await mkdir(fat, { recursive: true });
      for (let i = 0; i < 1200; i++) {
        await writeFile(join(fat, `f${i}.txt`), 'x');
      }

      const fdsBefore = readdirSync('/dev/fd').length;
      await startSignal();
      const fdsAfter = readdirSync('/dev/fd').length;

      expect(fdsAfter - fdsBefore).toBeLessThan(50);
    },
    30000,
  );
});
