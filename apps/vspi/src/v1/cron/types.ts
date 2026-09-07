export const MAX_CRON_TASKS = 50;
export const MAX_CRON_PROMPT_BYTES = 8 * 1024;
export const CRON_STORE_ENTRY = "vspi.cron";

export interface CronTask {
  readonly id: string;
  readonly cron?: string;
  readonly runAt?: number;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly lastFiredAt?: number;
  readonly lastAttemptAt?: number;
  readonly lastError?: string;
}

export type CronStoreEvent =
  | { readonly version: 1; readonly operation: "add"; readonly task: CronTask }
  | { readonly version: 1; readonly operation: "delete"; readonly id: string }
  | { readonly version: 1; readonly operation: "cursor"; readonly id: string; readonly lastFiredAt: number }
  | {
      readonly version: 1;
      readonly operation: "failure";
      readonly id: string;
      readonly lastAttemptAt: number;
      readonly error: string;
    };

export interface CronStore {
  read(): readonly unknown[] | Promise<readonly unknown[]>;
  append(event: CronStoreEvent): void | Promise<void>;
}

export interface CronFire {
  readonly task: CronTask;
  readonly firedAt: number;
  readonly coalescedCount: number;
}

export interface CronRuntimeOptions {
  readonly store: CronStore;
  readonly isIdle: () => boolean;
  readonly injectPrompt: (prompt: string, fire: CronFire) => void | Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onChange?: (tasks: readonly CronTask[]) => void;
}
