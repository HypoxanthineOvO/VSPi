import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  createTerminalRequestSchema,
  type CreateTerminalRequest,
  type Terminal,
  type TerminalAttachOptions,
  type TerminalAttachSink,
  type TerminalExitMessage,
  type TerminalFrame,
  type TerminalOutputMessage,
  type TerminalProcess,
} from '#/os/interface/terminal';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import type { RuntimeLease } from '#/runtime/runtime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MAX_BUFFERED_FRAMES = 2000;
const STREAM_MAX_QUEUED_FRAMES = 128;
const STREAM_MAX_QUEUED_BYTES = 1024 * 1024;

export const openTerminalRequestSchema = z
  .object({
    runtime_id: z.string().min(1).max(128),
    cwd: createTerminalRequestSchema.shape.cwd,
    cols: z.number().int().min(1).max(1000).optional(),
    rows: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export type TerminalStreamFrame =
  | { readonly type: 'terminal_ready'; readonly terminal: Terminal }
  | TerminalFrame;

interface TerminalRecord {
  terminal: Terminal;
  process: TerminalProcess;
  lease: RuntimeLease;
  sinks: Map<string, TerminalAttachSink>;
  buffer: TerminalFrame[];
  nextSeq: number;
  disposables: IDisposable[];
  closed: boolean;
}

export interface ISessionTerminalService {
  readonly _serviceBrand: undefined;

  open(input: CreateTerminalRequest): AsyncIterable<TerminalStreamFrame>;
  create(input: CreateTerminalRequest): Promise<Terminal>;
  list(): Promise<readonly Terminal[]>;
  get(terminalId: string): Promise<Terminal>;
  attach(
    terminalId: string,
    sink: TerminalAttachSink,
    options?: TerminalAttachOptions,
  ): Promise<{ replayed: number }>;
  detach(terminalId: string, sinkId: string): void;
  detachAllForSink(sinkId: string): void;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<{ closed: true }>;
}

export const ISessionTerminalService: ServiceIdentifier<ISessionTerminalService> =
  createDecorator<ISessionTerminalService>('sessionTerminalService');

export class SessionTerminalService extends Disposable implements ISessionTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly records = new Map<string, TerminalRecord>();
  private readonly openStreams = new Set<{ finish(): void }>();

  constructor(
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
  }

  open(input: CreateTerminalRequest): AsyncIterable<TerminalStreamFrame> {
    const parsed = openTerminalRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'invalid terminal open request');
    }
    const request: CreateTerminalRequest = parsed.data;
    return {
      [Symbol.asyncIterator]: () => this.openIterator(request),
    };
  }

  private openIterator(request: CreateTerminalRequest): AsyncIterator<TerminalStreamFrame> {
    const queue: Array<{ frame: TerminalStreamFrame; bytes: number }> = [];
    const waiters: Array<{
      resolve(result: IteratorResult<TerminalStreamFrame>): void;
      reject(error: unknown): void;
    }> = [];
    let queuedBytes = 0;
    let started = false;
    let done = false;
    let failure: unknown;
    let terminalId: string | undefined;
    let sinkId: string | undefined;
    let sinkRegistered = false;
    let exitSeen = false;

    const handle = { finish: () => finish() };
    this.openStreams.add(handle);

    const detachSink = (): void => {
      if (!sinkRegistered) return;
      sinkRegistered = false;
      if (terminalId !== undefined && sinkId !== undefined) {
        this.detach(terminalId, sinkId);
      }
    };

    const finish = (): void => {
      if (done || failure !== undefined) return;
      done = true;
      queue.length = 0;
      queuedBytes = 0;
      detachSink();
      this.openStreams.delete(handle);
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        waiter.resolve({ done: true, value: undefined });
      }
    };

    const fail = (error: unknown): void => {
      if (done || failure !== undefined) return;
      failure = error;
      queue.length = 0;
      queuedBytes = 0;
      detachSink();
      this.openStreams.delete(handle);
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        waiter.reject(error);
      }
      if (terminalId !== undefined) {
        void this.close(terminalId).catch(() => undefined);
      }
    };

    const push = (frame: TerminalStreamFrame, bytes: number): void => {
      if (done || failure !== undefined) return;
      if (queue.length >= STREAM_MAX_QUEUED_FRAMES || queuedBytes + bytes > STREAM_MAX_QUEUED_BYTES) {
        fail(new Error2(ErrorCodes.REQUEST_INVALID, 'terminal output exceeded the stream buffer'));
        return;
      }
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve({ done: false, value: frame });
        return;
      }
      queue.push({ frame, bytes });
      queuedBytes += bytes;
    };

    const onFrame = (frame: TerminalFrame): void => {
      if (frame.type === 'terminal_exit') {
        if (exitSeen) return;
        exitSeen = true;
      }
      push(frame, frameSize(frame));
      if (frame.type === 'terminal_exit') detachSink();
    };

    const ensureStarted = (): void => {
      if (started || done || failure !== undefined) return;
      started = true;
      void (async () => {
        let terminal: Terminal;
        try {
          terminal = await this.create(request);
        } catch (error) {
          fail(error);
          return;
        }
        if (done || failure !== undefined) {
          await this.close(terminal.id).catch(() => undefined);
          return;
        }
        terminalId = terminal.id;
        sinkId = `stream-${randomUUID()}`;
        push(
          {
            type: 'terminal_ready',
            terminal,
          },
          512,
        );
        sinkRegistered = true;
        try {
          await this.attach(terminal.id, { id: sinkId, send: onFrame });
          if (done || failure !== undefined || exitSeen) detachSink();
        } catch (error) {
          if (done || failure !== undefined) detachSink();
          else fail(error);
        }
      })();
    };

    return {
      next: async (): Promise<IteratorResult<TerminalStreamFrame>> => {
        ensureStarted();
        if (failure !== undefined)
          throw failure instanceof Error ? failure : new Error('terminal stream failed', { cause: failure });
        const entry = queue.shift();
        if (entry !== undefined) {
          queuedBytes -= entry.bytes;
          return { done: false, value: entry.frame };
        }
        if (done || exitSeen) {
          finish();
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<TerminalStreamFrame>>((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      return: async (): Promise<IteratorResult<TerminalStreamFrame>> => {
        if (done) return { done: true, value: undefined };
        finish();
        if (terminalId !== undefined) {
          await this.close(terminalId).catch(() => undefined);
        }
        return { done: true, value: undefined };
      },
    };
  }

  async create(input: CreateTerminalRequest): Promise<Terminal> {
    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    const lease = this.runtimeResolver.acquire(
      { workspaceId: this.sessionContext.workspaceId, runtimeId: input.runtime_id },
      ['terminal'],
    );
    const view = new RuntimeWorkspaceView(lease.runtime, this.workspace);
    const cwd = input.cwd === undefined ? view.workDir : view.assertAllowed(view.resolve(input.cwd));
    const shell = input.shell ?? lease.runtime.environment.shellPath;
    let process: TerminalProcess;
    try {
      process = await lease.runtime.terminal!.spawn({ cwd, shell, cols, rows });
      lease.track({ dispose: () => process.kill() });
    } catch (error) {
      lease.dispose();
      throw error;
    }
    const terminal: Terminal = {
      id: `term_${randomUUID()}`,
      session_id: this.sessionContext.sessionId,
      cwd,
      shell,
      cols,
      rows,
      status: 'running',
      created_at: new Date().toISOString(),
    };
    const record: TerminalRecord = {
      terminal,
      process,
      lease,
      sinks: new Map(),
      buffer: [],
      nextSeq: 0,
      disposables: [],
      closed: false,
    };
    record.disposables.push(
      process.onProcessData((data) => this.onData(record, data)),
      process.onProcessExit((event) => this.onExit(record, event.exitCode)),
    );
    this.records.set(terminal.id, record);
    return { ...terminal };
  }

  list(): Promise<readonly Terminal[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => ({ ...record.terminal })),
    );
  }

  async get(terminalId: string): Promise<Terminal> {
    return { ...this.requireRecord(terminalId).terminal };
  }

  async attach(
    terminalId: string,
    sink: TerminalAttachSink,
    options: TerminalAttachOptions = {},
  ): Promise<{ replayed: number }> {
    const record = this.requireRecord(terminalId);
    record.sinks.set(sink.id, sink);
    const sinceSeq = options.sinceSeq ?? 0;
    const replay = record.buffer.filter((frame) => frameSeq(frame) > sinceSeq);
    for (const frame of replay) {
      sink.send(frame);
    }
    return { replayed: replay.length };
  }

  detach(terminalId: string, sinkId: string): void {
    this.records.get(terminalId)?.sinks.delete(sinkId);
  }

  detachAllForSink(sinkId: string): void {
    for (const record of this.records.values()) {
      record.sinks.delete(sinkId);
    }
  }

  async write(terminalId: string, data: string): Promise<void> {
    const record = this.requireRecord(terminalId);
    record.process.write(data);
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const record = this.requireRecord(terminalId);
    record.terminal = { ...record.terminal, cols, rows };
    record.process.resize(cols, rows);
  }

  async close(terminalId: string): Promise<{ closed: true }> {
    const record = this.requireRecord(terminalId);
    if (!record.closed) {
      record.closed = true;
      record.process.kill();
      this.markExited(record, null);
    }
    return { closed: true };
  }

  override dispose(): void {
    for (const stream of this.openStreams) stream.finish();
    for (const record of this.records.values()) {
      disposeAll(record.disposables);
      record.lease.dispose();
      try {
        record.process.kill();
      } catch {
      }
    }
    this.records.clear();
    super.dispose();
  }

  private requireRecord(terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId);
    if (record === undefined) {
      throw new Error2(
        ErrorCodes.TERMINAL_NOT_FOUND,
        `terminal ${terminalId} does not exist in session ${this.sessionContext.sessionId}`,
      );
    }
    return record;
  }

  private onData(record: TerminalRecord, data: string): void {
    const frame: TerminalOutputMessage = {
      type: 'terminal_output',
      seq: ++record.nextSeq,
      session_id: record.terminal.session_id,
      terminal_id: record.terminal.id,
      timestamp: new Date().toISOString(),
      payload: { data },
    };
    this.pushFrame(record, frame);
  }

  private onExit(record: TerminalRecord, exitCode: number | null): void {
    this.markExited(record, exitCode);
  }

  private markExited(record: TerminalRecord, exitCode: number | null): void {
    if (record.terminal.status === 'exited') return;
    record.closed = true;
    record.terminal = {
      ...record.terminal,
      status: 'exited',
      exited_at: new Date().toISOString(),
      exit_code: exitCode,
    };
    const frame: TerminalExitMessage = {
      type: 'terminal_exit',
      session_id: record.terminal.session_id,
      terminal_id: record.terminal.id,
      timestamp: new Date().toISOString(),
      payload: { exit_code: exitCode },
    };
    this.pushFrame(record, frame);
    disposeAll(record.disposables);
    record.disposables = [];
    record.lease.dispose();
  }

  private pushFrame(record: TerminalRecord, frame: TerminalFrame): void {
    record.buffer.push(frame);
    if (record.buffer.length > DEFAULT_MAX_BUFFERED_FRAMES) {
      record.buffer.splice(0, record.buffer.length - DEFAULT_MAX_BUFFERED_FRAMES);
    }
    for (const sink of record.sinks.values()) {
      sink.send(frame);
    }
  }
}

function disposeAll(items: Iterable<IDisposable>): void {
  for (const item of items) {
    item.dispose();
  }
}

function frameSeq(frame: TerminalFrame): number {
  return frame.type === 'terminal_output' ? frame.seq : Number.MAX_SAFE_INTEGER;
}

function frameSize(frame: TerminalFrame): number {
  return frame.type === 'terminal_output'
    ? Buffer.byteLength(frame.payload.data, 'utf8') + 64
    : 128;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTerminalService,
  SessionTerminalService,
  ScopeActivation.OnScopeCreated,
  'terminal',
);
