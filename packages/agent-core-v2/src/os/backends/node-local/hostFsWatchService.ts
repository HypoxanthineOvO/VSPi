import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { FSWatcher } from 'chokidar';

import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import {
  type HostFsChange,
  type HostFsChangeAction,
  type HostFsChangeKind,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

const DEFAULT_IGNORED = (p: string): boolean => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p);

const NATIVE_RETRY_BASE_MS = 1000;
const NATIVE_RETRY_MAX_MS = 30000;

interface NativeFsWatcher {
  close(): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
}

interface HostFsWatchRuntime {
  readonly platform: NodeJS.Platform;
  watchNative(
    root: string,
    listener: (eventType: string, filename: string | null) => void,
  ): NativeFsWatcher;
  scheduleRetry(callback: () => void, delayMs: number): IDisposable;
}

const NODE_HOST_FS_WATCH_RUNTIME: HostFsWatchRuntime = {
  platform: process.platform,
  watchNative: (root, listener) =>
    fsWatch(root, { persistent: false, recursive: true }, listener),
  scheduleRetry: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return {
      dispose: () => {
        clearTimeout(timer);
      },
    };
  },
};

interface WatchReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function createWatchReadiness(): WatchReadiness {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

class HostFsWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly readiness = createWatchReadiness();
  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: FSWatcher;
  private disposed = false;

  constructor(path: string, options: HostFsWatchOptions | undefined) {
    this.ready = this.readiness.promise;
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.watcher = new FSWatcher({
      ignoreInitial: true,
      persistent: false,
      followSymlinks: false,
      depth: options?.recursive === false ? 0 : undefined,
      ignored: (path, stats) => (options?.ignored ?? DEFAULT_IGNORED)(path, stats?.isDirectory() ? 'directory' : stats?.isFile() ? 'file' : undefined),
    });
    this.watcher.on('all', (eventName: string, absPath: string) => {
      const mapped = mapChokidarEvent(eventName, absPath);
      if (mapped !== undefined) this.emitter.fire(mapped);
    });
    this.watcher.on('error', (error: unknown) => {
      this.readiness.reject(error);
      onUnexpectedError(error);
    });
    this.watcher.once('ready', () => this.readiness.resolve());
    const begin = () => { if (!this.disposed) this.watcher.add(path); };
    if (options?.ignoredReady) {
      void options.ignoredReady.then(begin, (error: unknown) => {
        this.readiness.reject(error);
        onUnexpectedError(error);
      });
    } else begin();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.resolve();
    void this.watcher.close().catch(() => undefined);
    this.emitter.dispose();
  }
}

class TargetSignalWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly emitter = new Emitter<HostFsChange>();
  private readonly readiness = createWatchReadiness();
  private readonly parents = new Map<string, NativeFsWatcher>();
  private readonly subtrees = new Map<string, HostFsWatchHandle>();
  private readonly targets: readonly string[];
  private refreshTail: Promise<void>;
  private refreshQueued = false;
  private disposed = false;

  constructor(private readonly root: string, private readonly options: HostFsWatchOptions) {
    this.onDidChange = this.emitter.event;
    this.targets = [...new Set(options.targets?.map((target) => resolve(target)))];
    this.refreshTail = (options.ignoredReady ?? Promise.resolve()).then(() => this.refresh());
    this.ready = this.readiness.promise;
    void this.refreshTail.then(() => this.readiness.resolve(), (error: unknown) => this.readiness.reject(error));
    void this.ready.catch(onUnexpectedError);
  }

  private invalidate(path: string, rearm = false): void {
    if (this.disposed || (path !== this.root && this.options.ignored?.(path))) return;
    if (rearm) {
      for (const [watched, watcher] of this.parents) {
        if (clampToRoot(path, watched) === watched) { watcher.close(); this.parents.delete(watched); }
      }
      for (const [watched, watcher] of this.subtrees) {
        if (clampToRoot(path, watched) === watched) { watcher.dispose(); this.subtrees.delete(watched); }
      }
    }
    this.emitter.fire({ path: this.root, action: 'modified', kind: 'directory' });
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    this.refreshTail = this.refreshTail.catch(() => undefined).then(async () => {
      this.refreshQueued = false;
      await this.refresh();
      if (!this.disposed) this.emitter.fire({ path: this.root, action: 'modified', kind: 'directory' });
    });
    void this.refreshTail.catch(onUnexpectedError);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const parents = new Set<string>();
    const subtrees = new Set<string>();
    if (dirname(this.root) !== this.root) {
      parents.add(dirname(this.root));
      this.watchParent(dirname(this.root));
    }
    for (const target of this.targets) {
      if (clampToRoot(this.root, target) !== target) continue;
      const chain: string[] = [];
      for (let parent = dirname(target);; parent = dirname(parent)) {
        chain.push(parent);
        if (parent === this.root) break;
      }
      for (const parent of chain.reverse()) {
        const info = await stat(parent).catch(() => undefined);
        if (this.disposed) return;
        if (!info?.isDirectory()) break;
        parents.add(parent);
        this.watchParent(parent);
      }
      const info = await stat(target).catch(() => undefined);
      if (this.disposed) return;
      if (!info?.isDirectory()) continue;
      subtrees.add(target);
      if (this.subtrees.has(target)) continue;
      const watcher = new HostFsWatchHandle(target, this.options);
      watcher.onDidChange((event) => this.invalidate(event.path));
      this.subtrees.set(target, watcher);
      await watcher.ready;
      if (this.disposed) return;
    }
    for (const [path, watcher] of this.parents) {
      if (!parents.has(path)) { watcher.close(); this.parents.delete(path); }
    }
    for (const [path, watcher] of this.subtrees) {
      if (!subtrees.has(path)) { watcher.dispose(); this.subtrees.delete(path); }
    }
  }

  private watchParent(parent: string): void {
    if (this.parents.has(parent)) return;
    const watcher = fsWatch(parent, { persistent: false }, (type, filename) => {
      const path = resolveNativeSignalPath(parent, filename);
      if (parent !== this.root && parent === dirname(this.root) && path !== this.root && path !== parent) return;
      this.invalidate(path === parent ? this.root : path, type === 'rename');
    });
    watcher.on('error', (error) => {
      watcher.close();
      this.parents.delete(parent);
      onUnexpectedError(error);
      this.invalidate(this.root);
    });
    this.parents.set(parent, watcher);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.resolve();
    for (const watcher of this.parents.values()) watcher.close();
    for (const watcher of this.subtrees.values()) watcher.dispose();
    this.parents.clear();
    this.subtrees.clear();
    this.emitter.dispose();
  }
}

class SignalWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly readiness = createWatchReadiness();
  private readonly emitter: Emitter<HostFsChange>;
  private readonly ignored: (path: string) => boolean;
  private nativeWatcher: NativeFsWatcher | undefined;
  private chokidarLeg: HostFsWatchHandle | undefined;
  private retry: IDisposable | undefined;
  private retryAttempts = 0;
  private recovering = false;
  private disposed = false;

  constructor(
    private readonly root: string,
    options: HostFsWatchOptions | undefined,
    private readonly runtime: HostFsWatchRuntime,
  ) {
    this.ready = this.readiness.promise;
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.ignored = options?.ignored ?? DEFAULT_IGNORED;
    this.startNativeLeg();
  }

  private startNativeLeg(): void {
    if (this.disposed) return;
    try {
      const watcher = this.runtime.watchNative(this.root, (_eventType, filename) => {
        if (this.disposed) return;
        this.retryAttempts = 0;
        const absPath = resolveNativeSignalPath(this.root, filename);
        if (absPath !== this.root && this.ignored(absPath)) return;
        this.fireInvalidation();
      });
      watcher.on('error', (error: NodeJS.ErrnoException) => {
        this.onNativeError(watcher, error);
      });
      this.nativeWatcher = watcher;
      this.readiness.resolve();
      if (this.recovering) {
        this.recovering = false;
        this.fireInvalidation();
      }
    } catch (error) {
      this.onNativeError(undefined, error as NodeJS.ErrnoException);
    }
  }

  private onNativeError(watcher: NativeFsWatcher | undefined, error: NodeJS.ErrnoException): void {
    if (this.disposed) return;
    if (watcher !== undefined && watcher !== this.nativeWatcher) return;
    watcher?.close();
    this.nativeWatcher = undefined;
    if (error.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
      this.recovering = false;
      this.startChokidarLeg();
      this.fireInvalidation();
      return;
    }
    onUnexpectedError(error);
    this.recovering = true;
    this.fireInvalidation();
    const delay = Math.min(NATIVE_RETRY_BASE_MS * 2 ** this.retryAttempts, NATIVE_RETRY_MAX_MS);
    this.retryAttempts += 1;
    this.retry?.dispose();
    this.retry = this.runtime.scheduleRetry(() => {
      this.retry = undefined;
      this.startNativeLeg();
    }, delay);
  }

  private startChokidarLeg(): void {
    if (this.chokidarLeg !== undefined) return;
    const leg = new HostFsWatchHandle(this.root, { recursive: true, ignored: this.ignored });
    leg.onDidChange((event) => {
      if (!this.disposed) this.emitter.fire(event);
    });
    void leg.ready.then(
      () => this.readiness.resolve(),
      (error: unknown) => this.readiness.reject(error),
    );
    this.chokidarLeg = leg;
  }

  private fireInvalidation(): void {
    this.emitter.fire({ path: this.root, action: 'modified', kind: 'directory' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.resolve();
    this.retry?.dispose();
    this.nativeWatcher?.close();
    this.chokidarLeg?.dispose();
    this.emitter.dispose();
  }
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly runtime: HostFsWatchRuntime = NODE_HOST_FS_WATCH_RUNTIME) {}

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    if (options?.signal && options.targets !== undefined && !options.targets.some((target) => resolve(target) === resolve(path))) {
      return new TargetSignalWatchHandle(resolve(path), options);
    }
    if (useNativeRecursive(options, this.runtime.platform)) {
      return new SignalWatchHandle(path, options, this.runtime);
    }
    return new HostFsWatchHandle(path, options);
  }
}

function useNativeRecursive(
  options: HostFsWatchOptions | undefined,
  platform: NodeJS.Platform,
): boolean {
  return (
    options?.signal === true &&
    options.recursive !== false &&
    (platform === 'darwin' || platform === 'win32')
  );
}

function resolveNativeSignalPath(root: string, filename: string | null): string {
  if (filename === null || filename === '' || filename === basename(root)) return root;
  return clampToRoot(root, isAbsolute(filename) ? filename : join(root, filename));
}

function clampToRoot(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return absPath;
  return root;
}

function mapChokidarEvent(eventName: string, absPath: string): HostFsChange | undefined {
  const mapped = mapActionAndKind(eventName);
  if (mapped === undefined) return undefined;
  return { path: absPath, action: mapped.action, kind: mapped.kind };
}

function mapActionAndKind(
  eventName: string,
): { action: HostFsChangeAction; kind: HostFsChangeKind } | undefined {
  switch (eventName) {
    case 'add':
      return { action: 'created', kind: 'file' };
    case 'addDir':
      return { action: 'created', kind: 'directory' };
    case 'change':
      return { action: 'modified', kind: 'file' };
    case 'unlink':
      return { action: 'deleted', kind: 'file' };
    case 'unlinkDir':
      return { action: 'deleted', kind: 'directory' };
    default:
      return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostFsWatchService,
  HostFsWatchService,
  ScopeActivation.OnScopeCreated,
  'hostFsWatch',
);
