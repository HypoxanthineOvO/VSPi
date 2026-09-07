import { randomBytes } from "node:crypto";
import { computeNextCronRun, parseCronExpression } from "./expression.js";
import { MAX_CRON_DELAY_MS } from "./schedule.js";
import { replayCronEvents } from "./store.js";
import {
  type CronFire,
  type CronRuntimeOptions,
  type CronTask,
  MAX_CRON_PROMPT_BYTES,
  MAX_CRON_TASKS,
} from "./types.js";

const MAX_COALESCE_ITERATIONS = 10_000;

export class CronRuntime {
  private readonly tasks = new Map<string, CronTask>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;

  private constructor(private readonly options: CronRuntimeOptions) {}

  static async restore(options: CronRuntimeOptions): Promise<CronRuntime> {
    const runtime = new CronRuntime(options);
    const restored = replayCronEvents(await options.store.read());
    for (const [id, task] of restored) runtime.tasks.set(id, task);
    runtime.notifyChange();
    return runtime;
  }

  now(): number {
    return (this.options.now ?? Date.now)();
  }

  list(): readonly CronTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  async create(input: { cron: string; prompt: string; recurring?: boolean }): Promise<CronTask> {
    this.validateCreate(input.prompt);
    const parsed = parseCronExpression(input.cron);
    const normalized = parsed.raw;
    if (computeNextCronRun(parsed, this.now()) === null) throw new Error("cron expression has no fire within 5 years");
    const task: CronTask = {
      id: this.uniqueId(),
      cron: normalized,
      prompt: input.prompt,
      recurring: input.recurring !== false,
      createdAt: this.now(),
    };
    await this.options.store.append({ version: 1, operation: "add", task });
    this.tasks.set(task.id, task);
    this.notifyChange();
    return { ...task };
  }

  async createAt(input: { runAt: number; prompt: string }): Promise<CronTask> {
    this.validateCreate(input.prompt);
    const now = this.now();
    if (!Number.isFinite(input.runAt) || input.runAt <= now) throw new Error("runAt must be in the future");
    if (input.runAt - now > MAX_CRON_DELAY_MS) throw new Error("runAt must be within 366 days");
    const task: CronTask = {
      id: this.uniqueId(),
      runAt: input.runAt,
      prompt: input.prompt,
      recurring: false,
      createdAt: now,
    };
    await this.options.store.append({ version: 1, operation: "add", task });
    this.tasks.set(task.id, task);
    this.notifyChange();
    return { ...task };
  }

  async delete(id: string): Promise<boolean> {
    if (!this.tasks.has(id)) return false;
    await this.options.store.append({ version: 1, operation: "delete", id });
    this.tasks.delete(id);
    this.notifyChange();
    return true;
  }

  start(): void {
    if (this.timer) return;
    const schedule = this.options.setInterval ?? globalThis.setInterval;
    this.timer = schedule(() => void this.tick().catch(() => {}), this.options.pollIntervalMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    (this.options.clearInterval ?? globalThis.clearInterval)(this.timer);
    this.timer = undefined;
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    if (!this.options.isIdle()) return;
    const now = this.now();
    for (const task of [...this.tasks.values()]) {
      if (!this.options.isIdle()) return;
      await this.processTask(task, now);
    }
  }

  private async processTask(task: CronTask, now: number): Promise<void> {
    if (task.lastError) return;
    const expression = task.cron ? parseCronExpression(task.cron) : undefined;
    const base = Math.max(task.createdAt, task.lastFiredAt ?? task.createdAt);
    const firstDue = task.runAt ?? (expression ? computeNextCronRun(expression, base) : null);
    if (firstDue === null || firstDue > now) return;

    let coalescedCount = 1;
    let lastDue = firstDue;
    if (task.recurring && expression) {
      while (coalescedCount < MAX_COALESCE_ITERATIONS) {
        const next = computeNextCronRun(expression, lastDue);
        if (next === null || next > now) break;
        lastDue = next;
        coalescedCount += 1;
      }
    }
    const fire: CronFire = { task: { ...task }, firedAt: now, coalescedCount };
    try {
      await this.options.injectPrompt(renderCronPrompt(fire), fire);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const failed = { ...task, lastAttemptAt: now, lastError: message };
      await this.options.store.append({
        version: 1,
        operation: "failure",
        id: task.id,
        lastAttemptAt: now,
        error: message,
      });
      this.tasks.set(task.id, failed);
      this.notifyChange();
      return;
    }
    if (!this.tasks.has(task.id)) return;
    if (!task.recurring) {
      await this.delete(task.id);
      return;
    }
    const updated = { ...task, lastFiredAt: lastDue };
    await this.options.store.append({ version: 1, operation: "cursor", id: task.id, lastFiredAt: lastDue });
    this.tasks.set(task.id, updated);
    this.notifyChange();
  }

  private validateCreate(prompt: string): void {
    if (this.tasks.size >= MAX_CRON_TASKS) throw new Error(`cron task limit reached (${MAX_CRON_TASKS})`);
    if (!prompt) throw new Error("cron prompt must not be empty");
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > MAX_CRON_PROMPT_BYTES) {
      throw new Error(`cron prompt exceeds ${MAX_CRON_PROMPT_BYTES} UTF-8 bytes`);
    }
  }

  private notifyChange(): void {
    this.options.onChange?.(this.list());
  }

  private uniqueId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomBytes(4).toString("hex");
      if (!this.tasks.has(id)) return id;
    }
    throw new Error("failed to generate a unique cron task id");
  }
}

export function renderCronPrompt(fire: CronFire): string {
  const attrs = [
    `jobId="${attribute(fire.task.id)}"`,
    ...(fire.task.cron ? [`cron="${attribute(fire.task.cron)}"`] : []),
    ...(fire.task.runAt ? [`runAt="${new Date(fire.task.runAt).toISOString()}"`] : []),
    `recurring="${String(fire.task.recurring)}"`,
    `coalescedCount="${String(fire.coalescedCount)}"`,
  ].join(" ");
  return `<cron-fire ${attrs}>\n<prompt>\n${fire.task.prompt}\n</prompt>\n</cron-fire>`;
}

export function nextCronTaskRun(task: CronTask): number | null {
  if (task.lastError) return null;
  if (task.runAt !== undefined) return task.runAt;
  if (!task.cron) return null;
  return computeNextCronRun(
    parseCronExpression(task.cron),
    Math.max(task.createdAt, task.lastFiredAt ?? task.createdAt),
  );
}

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
