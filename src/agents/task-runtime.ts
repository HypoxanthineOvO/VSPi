// Task lifecycle and persistence semantics adapted from MoonshotAI/kimi-code
// commit 676e4d8 (MIT): agent/task/taskService.ts and agent/task/persist.ts.
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { EffortLevel } from "../domain/types.js";
import type { AgentRunSnapshot } from "./types.js";

export interface AgentTaskResumeState {
  sessionFile: string;
  model: string;
  effort: EffortLevel;
  tools: string[];
  systemPrompt: string;
  instructions: string;
}

export type AgentTaskStatus = "running" | "completed" | "failed" | "timed_out" | "killed" | "lost";
export type AgentTaskNotificationState = "none" | "pending" | "delivered" | "suppressed";

export interface AgentTaskRecord {
  version: 1;
  taskId: string;
  agentId: string;
  ownerAgentId: string;
  description: string;
  status: AgentTaskStatus;
  detached: boolean;
  startedAt: number;
  endedAt: number | null;
  stopReason?: string;
  timeoutMs?: number;
  notification: AgentTaskNotificationState;
  outputSizeBytes: number;
  run?: AgentRunSnapshot;
  resume?: AgentTaskResumeState;
}

export interface AgentTaskOutputSnapshot {
  taskId: string;
  status: AgentTaskStatus;
  outputPath?: string;
  outputSizeBytes: number;
  previewBytes: number;
  truncated: boolean;
  fullOutputAvailable: boolean;
  preview: string;
  task: AgentTaskRecord;
}

export interface AgentTaskRuntimeOptions {
  directory: string;
  onChange?: (records: readonly AgentTaskRecord[]) => void;
  deliverNotification?: (record: AgentTaskRecord, output: string) => Promise<void>;
  maxOutputBytes?: number;
}

interface LiveTask {
  controller: AbortController;
  timeout?: NodeJS.Timeout;
  waiters: Set<() => void>;
  foregroundRelease?: {
    promise: Promise<"detached" | "terminal">;
    resolve(reason: "detached" | "terminal"): void;
  };
}

const TERMINAL = new Set<AgentTaskStatus>(["completed", "failed", "timed_out", "killed", "lost"]);
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_PREVIEW_BYTES = 4 * 1024;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export class AgentTaskRuntime {
  private readonly records = new Map<string, AgentTaskRecord>();
  private readonly live = new Map<string, LiveTask>();
  private readonly writeTails = new Map<string, Promise<void>>();
  private readonly outputTails = new Map<string, Promise<void>>();
  private closed = false;

  private constructor(private readonly options: AgentTaskRuntimeOptions) {}

  static async open(options: AgentTaskRuntimeOptions): Promise<AgentTaskRuntime> {
    const runtime = new AgentTaskRuntime({ ...options, directory: resolve(options.directory) });
    await mkdir(runtime.tasksDirectory(), { recursive: true, mode: 0o700 });
    await mkdir(runtime.outputsDirectory(), { recursive: true, mode: 0o700 });
    await runtime.restore();
    return runtime;
  }

  list(ownerAgentId = "main", activeOnly = false, limit = 100): AgentTaskRecord[] {
    return [...this.records.values()]
      .filter((record) => record.ownerAgentId === ownerAgentId && (!activeOnly || !TERMINAL.has(record.status)))
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(cloneRecord);
  }

  all(): AgentTaskRecord[] {
    return [...this.records.values()].sort((left, right) => right.startedAt - left.startedAt).map(cloneRecord);
  }

  get(taskId: string, ownerAgentId?: string): AgentTaskRecord | undefined {
    const record = this.records.get(taskId);
    if (!record || (ownerAgentId !== undefined && record.ownerAgentId !== ownerAgentId)) return;
    return cloneRecord(record);
  }

  async register(input: {
    taskId?: string;
    agentId: string;
    ownerAgentId: string;
    description: string;
    detached: boolean;
    timeoutMs?: number;
  }): Promise<{ taskId: string; signal: AbortSignal }> {
    if (this.closed) throw new Error("Agent task runtime is closed");
    const taskId = input.taskId ?? taskIdFor("agent");
    validateTaskId(taskId);
    if (this.records.has(taskId)) throw new Error(`Agent task already exists: ${taskId}`);
    const controller = new AbortController();
    const record: AgentTaskRecord = {
      version: 1,
      taskId,
      agentId: input.agentId,
      ownerAgentId: input.ownerAgentId,
      description: input.description,
      status: "running",
      detached: input.detached,
      startedAt: Date.now(),
      endedAt: null,
      notification: "none",
      outputSizeBytes: 0,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
    const live: LiveTask = {
      controller,
      waiters: new Set(),
      ...(!input.detached ? { foregroundRelease: foregroundRelease() } : {}),
    };
    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      live.timeout = setTimeout(() => {
        const current = this.records.get(taskId);
        if (!current || TERMINAL.has(current.status)) return;
        const reason = `Task timed out after ${input.timeoutMs}ms`;
        controller.abort(new Error(reason));
        void this.settle(taskId, { status: "timed_out", stopReason: reason });
      }, input.timeoutMs);
      live.timeout.unref();
    }
    this.records.set(taskId, record);
    this.live.set(taskId, live);
    await this.persist(record);
    this.changed();
    return { taskId, signal: controller.signal };
  }

  async updateRun(taskId: string, run: AgentRunSnapshot): Promise<void> {
    const record = this.records.get(taskId);
    if (!record) return;
    record.run = structuredClone(run);
    await this.persist(record);
    this.changed();
  }

  async updateResume(taskId: string, resume: AgentTaskResumeState): Promise<void> {
    const record = this.records.get(taskId);
    if (!record) return;
    record.resume = structuredClone(resume);
    await this.persist(record);
    this.changed();
  }

  async appendOutput(taskId: string, chunk: string): Promise<void> {
    if (!chunk) return;
    const previous = (this.outputTails.get(taskId) ?? Promise.resolve()).catch(() => undefined);
    const next = previous.then(() => this.appendOutputNow(taskId, chunk));
    this.outputTails.set(taskId, next);
    void next.then(
      () => {
        if (this.outputTails.get(taskId) === next) this.outputTails.delete(taskId);
      },
      () => {
        if (this.outputTails.get(taskId) === next) this.outputTails.delete(taskId);
      },
    );
    return next;
  }

  private async appendOutputNow(taskId: string, chunk: string): Promise<void> {
    const record = this.records.get(taskId);
    if (!record || TERMINAL.has(record.status)) return;
    const bytes = Buffer.byteLength(chunk, "utf8");
    const limit = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (record.outputSizeBytes + bytes > limit) {
      const reason = `Output limit exceeded (${Math.floor(limit / (1024 * 1024))} MiB)`;
      queueMicrotask(() => void this.stop(taskId, reason, "failed"));
      return;
    }
    await mkdir(this.outputTaskDirectory(taskId), { recursive: true, mode: 0o700 });
    await open(this.outputPath(taskId), "a", 0o600).then(async (handle) => {
      try {
        await handle.writeFile(chunk, "utf8");
      } finally {
        await handle.close();
      }
    });
    record.outputSizeBytes += bytes;
    await this.persist(record);
    this.changed();
  }

  async settle(
    taskId: string,
    settlement: { status: Exclude<AgentTaskStatus, "running" | "lost">; stopReason?: string; output?: string },
  ): Promise<AgentTaskRecord | undefined> {
    const record = this.records.get(taskId);
    if (!record || TERMINAL.has(record.status)) return record ? cloneRecord(record) : undefined;
    await this.outputTails.get(taskId)?.catch(() => undefined);
    if (settlement.output && record.outputSizeBytes === 0) await this.appendOutput(taskId, settlement.output);
    record.status = settlement.status;
    record.endedAt = Date.now();
    if (settlement.stopReason) record.stopReason = settlement.stopReason;
    const live = this.live.get(taskId);
    if (live?.timeout) clearTimeout(live.timeout);
    this.live.delete(taskId);
    if (record.detached && record.notification === "none") record.notification = "pending";
    await this.persist(record);
    for (const waiter of live?.waiters ?? []) waiter();
    live?.foregroundRelease?.resolve("terminal");
    this.changed();
    if (record.notification === "pending") setImmediate(() => void this.deliver(taskId));
    return cloneRecord(record);
  }

  async stop(
    taskId: string,
    reason = "Stopped by TaskStop",
    status: "killed" | "failed" | "timed_out" = "killed",
    ownerAgentId?: string,
  ): Promise<AgentTaskRecord | undefined> {
    const record = this.records.get(taskId);
    if (!record || (ownerAgentId !== undefined && record.ownerAgentId !== ownerAgentId)) return;
    if (TERMINAL.has(record.status)) return cloneRecord(record);
    const live = this.live.get(taskId);
    live?.controller.abort(new Error(reason));
    return this.settle(taskId, { status, stopReason: reason });
  }

  async detach(taskId: string, ownerAgentId: string): Promise<AgentTaskRecord | undefined> {
    const record = this.records.get(taskId);
    if (!record || record.ownerAgentId !== ownerAgentId) return;
    if (TERMINAL.has(record.status) || record.detached) return cloneRecord(record);
    record.detached = true;
    const live = this.live.get(taskId);
    live?.foregroundRelease?.resolve("detached");
    await this.persist(record);
    this.changed();
    return cloneRecord(record);
  }

  async waitForForegroundRelease(taskId: string): Promise<"detached" | "terminal" | undefined> {
    const record = this.records.get(taskId);
    if (!record) return;
    if (TERMINAL.has(record.status)) return "terminal";
    if (record.detached) return "detached";
    return this.live.get(taskId)?.foregroundRelease?.promise;
  }

  async wait(taskId: string, ownerAgentId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentTaskRecord> {
    const record = this.records.get(taskId);
    if (!record || record.ownerAgentId !== ownerAgentId) throw new Error(`Unknown background task: ${taskId}`);
    if (!TERMINAL.has(record.status)) {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const live = this.live.get(taskId);
        if (!live) return resolvePromise();
        const done = () => {
          cleanup();
          resolvePromise();
        };
        const abort = () => {
          cleanup();
          rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("WaitFor aborted"));
        };
        const timer = setTimeout(done, Math.max(1, timeoutMs));
        timer.unref();
        const cleanup = () => {
          clearTimeout(timer);
          live.waiters.delete(done);
          signal?.removeEventListener("abort", abort);
        };
        live.waiters.add(done);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const current = this.records.get(taskId);
    if (!current) throw new Error(`Unknown background task: ${taskId}`);
    if (TERMINAL.has(current.status) && current.notification === "pending") {
      current.notification = "suppressed";
      await this.persist(current);
      this.changed();
    }
    return cloneRecord(current);
  }

  async waitAny(ownerAgentId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentTaskRecord[]> {
    const initial = this.list(ownerAgentId, true, 100).map((record) => record.taskId);
    if (initial.length === 0) return [];
    await Promise.race(initial.map((taskId) => this.waitWithoutDelivery(taskId, timeoutMs, signal)));
    const finished: AgentTaskRecord[] = [];
    for (const taskId of initial) {
      const record = this.records.get(taskId);
      if (!record || !TERMINAL.has(record.status)) continue;
      if (record.notification === "pending") {
        record.notification = "suppressed";
        await this.persist(record);
      }
      finished.push(cloneRecord(record));
    }
    this.changed();
    return finished;
  }

  async output(
    taskId: string,
    ownerAgentId: string,
    maxPreviewBytes = DEFAULT_PREVIEW_BYTES,
  ): Promise<AgentTaskOutputSnapshot> {
    const record = this.records.get(taskId);
    if (!record || record.ownerAgentId !== ownerAgentId) throw new Error(`Unknown background task: ${taskId}`);
    let data: Uint8Array = new Uint8Array();
    try {
      data = await readFile(this.outputPath(taskId));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const previewBytes = Math.min(data.byteLength, Math.max(0, maxPreviewBytes));
    return {
      taskId,
      status: record.status,
      ...(data.byteLength > 0 ? { outputPath: this.outputPath(taskId) } : {}),
      outputSizeBytes: data.byteLength,
      previewBytes,
      truncated: previewBytes < data.byteLength,
      fullOutputAvailable: data.byteLength > 0,
      preview: Buffer.from(data.subarray(data.byteLength - previewBytes)).toString("utf8"),
      task: cloneRecord(record),
    };
  }

  async outputRange(
    taskId: string,
    ownerAgentId: string,
    offset: number,
    maxBytes: number,
  ): Promise<{ taskId: string; offset: number; nextOffset: number; totalBytes: number; content: string }> {
    const record = this.records.get(taskId);
    if (!record || record.ownerAgentId !== ownerAgentId) throw new Error(`Unknown background task: ${taskId}`);
    let data: Uint8Array = new Uint8Array();
    try {
      data = await readFile(this.outputPath(taskId));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const start = Math.max(0, Math.min(data.byteLength, Math.trunc(offset)));
    const end = Math.min(data.byteLength, start + Math.max(1, Math.min(65_536, Math.trunc(maxBytes))));
    return {
      taskId,
      offset: start,
      nextOffset: end,
      totalBytes: data.byteLength,
      content: Buffer.from(data.subarray(start, end)).toString("utf8"),
    };
  }

  async retryNotifications(): Promise<void> {
    for (const record of this.records.values())
      if (record.notification === "pending") await this.deliver(record.taskId);
  }

  async close(reason = "Session closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const taskId of this.live.keys()) {
      const record = this.records.get(taskId);
      if (record) record.notification = "suppressed";
    }
    await Promise.all(
      [...this.live.keys()].map((taskId) => this.stop(taskId, reason, "killed").catch(() => undefined)),
    );
    await Promise.all([...this.writeTails.values()].map((tail) => tail.catch(() => undefined)));
    await Promise.all([...this.outputTails.values()].map((tail) => tail.catch(() => undefined)));
  }

  private async restore(): Promise<void> {
    for (const name of await readdir(this.tasksDirectory()).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(this.tasksDirectory(), name), "utf8")) as AgentTaskRecord;
        if (!validRecord(record)) continue;
        if (record.status === "running") {
          record.status = "lost";
          record.endedAt = Date.now();
          record.stopReason = "Task belonged to a previous VSPi process";
          if (record.detached && record.notification === "none") record.notification = "pending";
          await this.persist(record);
        }
        this.records.set(record.taskId, record);
      } catch {
        // A corrupt individual task must not make the Session unavailable.
      }
    }
    this.changed();
  }

  private async deliver(taskId: string): Promise<void> {
    const record = this.records.get(taskId);
    if (!record || record.notification !== "pending" || !this.options.deliverNotification) return;
    const output = (await this.output(taskId, record.ownerAgentId, DEFAULT_PREVIEW_BYTES)).preview;
    try {
      await this.options.deliverNotification(cloneRecord(record), output);
      if (record.notification !== "pending") return;
      record.notification = "delivered";
      await this.persist(record);
      this.changed();
    } catch {
      // Pending is durable; retry on the next idle/startup reconciliation pass.
    }
  }

  private async waitWithoutDelivery(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const record = this.records.get(taskId);
    if (!record || TERMINAL.has(record.status)) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const live = this.live.get(taskId);
      if (!live) return resolvePromise();
      const done = () => {
        cleanup();
        resolvePromise();
      };
      const abort = () => {
        cleanup();
        rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("WaitFor aborted"));
      };
      const timer = setTimeout(done, Math.max(1, timeoutMs));
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        live.waiters.delete(done);
        signal?.removeEventListener("abort", abort);
      };
      live.waiters.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private persist(record: AgentTaskRecord): Promise<void> {
    const previous = (this.writeTails.get(record.taskId) ?? Promise.resolve()).catch(() => undefined);
    const next = previous.then(() => writeJsonAtomic(this.recordPath(record.taskId), record));
    this.writeTails.set(record.taskId, next);
    void next.then(
      () => {
        if (this.writeTails.get(record.taskId) === next) this.writeTails.delete(record.taskId);
      },
      () => {
        if (this.writeTails.get(record.taskId) === next) this.writeTails.delete(record.taskId);
      },
    );
    return next;
  }

  private changed(): void {
    this.options.onChange?.(this.all());
  }

  private tasksDirectory(): string {
    return join(this.options.directory, "tasks");
  }

  private outputsDirectory(): string {
    return join(this.options.directory, "output");
  }

  private outputTaskDirectory(taskId: string): string {
    validateTaskId(taskId);
    return join(this.outputsDirectory(), taskId);
  }

  private outputPath(taskId: string): string {
    return join(this.outputTaskDirectory(taskId), "output.log");
  }

  private recordPath(taskId: string): string {
    validateTaskId(taskId);
    return join(this.tasksDirectory(), `${taskId}.json`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function cloneRecord(record: AgentTaskRecord): AgentTaskRecord {
  return structuredClone(record);
}

function taskIdFor(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function validateTaskId(taskId: string): void {
  if (!TASK_ID.test(taskId)) throw new Error(`Invalid agent task id: ${taskId}`);
}

function validRecord(value: unknown): value is AgentTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AgentTaskRecord>;
  return (
    record.version === 1 &&
    typeof record.taskId === "string" &&
    TASK_ID.test(record.taskId) &&
    typeof record.agentId === "string" &&
    typeof record.ownerAgentId === "string" &&
    typeof record.description === "string" &&
    typeof record.status === "string" &&
    ["running", "completed", "failed", "timed_out", "killed", "lost"].includes(record.status) &&
    typeof record.detached === "boolean" &&
    typeof record.startedAt === "number" &&
    (record.endedAt === null || typeof record.endedAt === "number")
  );
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code) === code);
}

function foregroundRelease(): NonNullable<LiveTask["foregroundRelease"]> {
  let settled = false;
  let resolvePromise!: (reason: "detached" | "terminal") => void;
  const promise = new Promise<"detached" | "terminal">((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(reason) {
      if (settled) return;
      settled = true;
      resolvePromise(reason);
    },
  };
}
