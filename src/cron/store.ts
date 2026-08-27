import { CRON_STORE_ENTRY, type CronStore, type CronStoreEvent, type CronTask } from "./types.js";

export interface SessionEntryLike {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface SessionManagerCronPort {
  getEntries(): readonly SessionEntryLike[];
  appendCustomEntry(customType: string, data?: unknown): unknown;
}

export function sessionManagerCronStore(manager: SessionManagerCronPort): CronStore {
  return {
    read: () =>
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === CRON_STORE_ENTRY)
        .map((entry) => entry.data),
    append: (event) => {
      manager.appendCustomEntry(CRON_STORE_ENTRY, event);
    },
  };
}

export function replayCronEvents(values: readonly unknown[]): Map<string, CronTask> {
  const tasks = new Map<string, CronTask>();
  for (const value of values) {
    const event = parseEvent(value);
    if (!event) continue;
    if (event.operation === "add") tasks.set(event.task.id, event.task);
    else if (event.operation === "delete") tasks.delete(event.id);
    else if (event.operation === "cursor") {
      const task = tasks.get(event.id);
      if (task) tasks.set(event.id, { ...task, lastFiredAt: event.lastFiredAt });
    } else {
      const task = tasks.get(event.id);
      if (task) tasks.set(event.id, { ...task, lastAttemptAt: event.lastAttemptAt, lastError: event.error });
    }
  }
  return tasks;
}

function parseEvent(value: unknown): CronStoreEvent | undefined {
  if (!record(value) || value.version !== 1 || typeof value.operation !== "string") return undefined;
  if (value.operation === "add" && validTask(value.task)) return { version: 1, operation: "add", task: value.task };
  if (value.operation === "delete" && typeof value.id === "string") {
    return { version: 1, operation: "delete", id: value.id };
  }
  if (value.operation === "cursor" && typeof value.id === "string" && finite(value.lastFiredAt)) {
    return { version: 1, operation: "cursor", id: value.id, lastFiredAt: value.lastFiredAt };
  }
  if (
    value.operation === "failure" &&
    typeof value.id === "string" &&
    finite(value.lastAttemptAt) &&
    typeof value.error === "string"
  ) {
    return { version: 1, operation: "failure", id: value.id, lastAttemptAt: value.lastAttemptAt, error: value.error };
  }
  return undefined;
}

function validTask(value: unknown): value is CronTask {
  return (
    record(value) &&
    typeof value.id === "string" &&
    (typeof value.cron === "string" || finite(value.runAt)) &&
    !(typeof value.cron === "string" && finite(value.runAt)) &&
    typeof value.prompt === "string" &&
    typeof value.recurring === "boolean" &&
    (value.runAt === undefined || value.recurring === false) &&
    finite(value.createdAt) &&
    (value.lastFiredAt === undefined || finite(value.lastFiredAt)) &&
    (value.lastAttemptAt === undefined || finite(value.lastAttemptAt)) &&
    (value.lastError === undefined || typeof value.lastError === "string")
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
