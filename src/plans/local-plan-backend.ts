import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { LocalPlanBackend, PlanInput, PlanStatus, PlanWorkItem, StoredPlan } from "./types.js";

type FaultStage = "after_lock_acquired" | "after_revision_persisted" | "after_head_persisted";

export interface LocalPlanBackendOptions {
  rootDir: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  faultInjector?: (
    stage: FaultStage,
    context: { planId?: string; revision?: number; semanticHash?: string },
  ) => void | Promise<void>;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
const STATUSES = new Set<PlanStatus>(["pending", "in_progress", "blocked", "done"]);

export function createLocalPlanBackend(options: LocalPlanBackendOptions): LocalPlanBackend {
  const plansDir = join(options.rootDir, "plans");
  const lockDir = join(options.rootDir, ".writer.lock");

  async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(options.rootDir, { recursive: true });
    const timeout = options.lockTimeoutMs ?? 5_000;
    const stale = options.staleLockMs ?? 30_000;
    const started = Date.now();
    const token = randomUUID();
    const ownerPath = join(lockDir, "owner.json");
    for (;;) {
      try {
        await mkdir(lockDir);
        try {
          await writeNewFile(ownerPath, `${JSON.stringify({ token, pid: process.pid })}\n`);
        } catch (error) {
          await rm(lockDir, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const owner = await readLockOwner(ownerPath);
        const lockStat = await stat(ownerPath).catch(() => stat(lockDir).catch(() => undefined));
        const age = lockStat ? Date.now() - lockStat.mtimeMs : Number.NaN;
        if (Number.isFinite(age) && age > stale && (!owner || !processIsAlive(owner.pid))) {
          const claimed = `${lockDir}.stale-${randomUUID()}`;
          try {
            await rename(lockDir, claimed);
            await rm(claimed, { recursive: true, force: true });
            continue;
          } catch (claimError) {
            if (!isCode(claimError, "ENOENT")) throw claimError;
          }
        }
        if (Date.now() - started >= timeout) throw new Error("Local Plan writer lock timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const heartbeat = setInterval(
      () => void utimes(ownerPath, new Date(), new Date()).catch(() => undefined),
      Math.max(5, Math.floor(stale / 3)),
    );
    heartbeat.unref();
    try {
      await options.faultInjector?.("after_lock_acquired", {});
      return await operation();
    } finally {
      clearInterval(heartbeat);
      const owner = await readLockOwner(ownerPath);
      if (owner?.token === token) {
        const released = `${lockDir}.release-${token}`;
        await rename(lockDir, released).catch((error: unknown) => {
          if (!isCode(error, "ENOENT")) throw error;
        });
        await rm(released, { recursive: true, force: true });
      }
    }
  }

  async function persist(plan: StoredPlan): Promise<StoredPlan> {
    const directory = planDirectory(plansDir, plan.id);
    const revisions = join(directory, "revisions");
    await ensureSafePlansDirectory(plansDir);
    const directoryExisted = await lstat(directory).then(
      () => true,
      (error: unknown) => {
        if (isCode(error, "ENOENT")) return false;
        throw error;
      },
    );
    await mkdir(revisions, { recursive: true });
    await assertOrdinaryDirectory(directory, "Local Plan directory");
    await assertOrdinaryDirectory(revisions, "Local Plan revisions directory");
    if (!directoryExisted) await syncDirectory(plansDir);
    const file = `${String(plan.revision).padStart(8, "0")}-${plan.semanticHash.slice(0, 12)}.json`;
    const revisionPath = join(revisions, file);
    const bytes = `${JSON.stringify(plan, null, 2)}\n`;
    try {
      await writeNewFile(revisionPath, bytes);
    } catch (error) {
      if (!isCode(error, "EEXIST") || (await readFile(revisionPath, "utf8").catch(() => undefined)) !== bytes)
        throw error;
    }
    await syncDirectory(revisions);
    await options.faultInjector?.("after_revision_persisted", {
      planId: plan.id,
      revision: plan.revision,
      semanticHash: plan.semanticHash,
    });
    const headTemp = join(directory, `.HEAD.${process.pid}.${randomUUID()}.tmp`);
    const head = await open(headTemp, "wx");
    try {
      await head.writeFile(
        `${JSON.stringify({ file, revision: plan.revision, semanticHash: plan.semanticHash })}\n`,
        "utf8",
      );
      await head.sync();
    } finally {
      await head.close();
    }
    await rename(headTemp, join(directory, "HEAD"));
    await syncDirectory(directory);
    await options.faultInjector?.("after_head_persisted", {
      planId: plan.id,
      revision: plan.revision,
      semanticHash: plan.semanticHash,
    });
    return structuredClone(plan);
  }

  async function read(planId: string): Promise<StoredPlan | undefined> {
    assertIdentifier(planId, "plan ID");
    const directory = planDirectory(plansDir, planId);
    await ensureSafePlansDirectory(plansDir);
    const headPath = join(directory, "HEAD");
    try {
      await assertOrdinaryDirectory(directory, "Local Plan directory");
      await assertOrdinaryFile(headPath, "Local Plan HEAD");
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    const pointer = JSON.parse(await readFile(headPath, "utf8")) as {
      file?: unknown;
      revision?: unknown;
      semanticHash?: unknown;
    };
    if (typeof pointer.file !== "string" || !/^\d{8}-[a-f0-9]{12}\.json$/.test(pointer.file)) {
      throw new Error("Local Plan HEAD is invalid");
    }
    const revisionPath = join(directory, "revisions", pointer.file);
    try {
      await assertOrdinaryFile(revisionPath, "Local Plan revision");
    } catch (error) {
      if (isCode(error, "ENOENT")) throw new Error("Local Plan HEAD references a missing revision", { cause: error });
      throw error;
    }
    const plan = JSON.parse(await readFile(revisionPath, "utf8")) as StoredPlan;
    validateStoredPlan(plan, planId);
    if (
      pointer.revision !== plan.revision ||
      pointer.semanticHash !== plan.semanticHash ||
      !pointer.file.startsWith(`${String(plan.revision).padStart(8, "0")}-${plan.semanticHash.slice(0, 12)}`)
    ) {
      throw new Error("Local Plan HEAD integrity metadata does not match its revision");
    }
    return structuredClone(plan);
  }

  return {
    async create(input) {
      return withLock(async () => {
        const plan = sanitizePlanInput(input);
        let id = `plan-${randomUUID()}`;
        while (await read(id)) id = `plan-${randomUUID()}`;
        return persist(stored(id, 1, false, plan));
      });
    },
    async list(listOptions = {}) {
      await ensureSafePlansDirectory(plansDir);
      const entries = await readdir(plansDir, { withFileTypes: true }).catch((error: unknown) => {
        if (isCode(error, "ENOENT")) return [];
        throw error;
      });
      const plans = await Promise.all(
        entries.filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name)).map((entry) => read(entry.name)),
      );
      return plans
        .filter((plan): plan is StoredPlan => plan !== undefined && (listOptions.includeArchived || !plan.archived))
        .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    },
    read,
    async update(planId, input) {
      return withLock(async () => {
        const current = await read(planId);
        if (!current) throw new Error(`Local Plan ${planId} was not found`);
        if (current.revision !== input.expectedRevision) {
          throw new Error(
            `Local Plan revision conflict: expected ${input.expectedRevision}, current ${current.revision}`,
          );
        }
        return persist(stored(planId, current.revision + 1, current.archived, sanitizePlanInput(input.plan)));
      });
    },
    async archive(planId, input) {
      return withLock(async () => {
        const current = await read(planId);
        if (!current) throw new Error(`Local Plan ${planId} was not found`);
        if (current.revision !== input.expectedRevision) {
          throw new Error(
            `Local Plan revision conflict: expected ${input.expectedRevision}, current ${current.revision}`,
          );
        }
        return persist(stored(planId, current.revision + 1, true, sanitizePlanInput(current)));
      });
    },
  };
}

function stored(id: string, revision: number, archived: boolean, plan: PlanInput): StoredPlan {
  const semanticHash = createHash("sha256")
    .update(canonicalJson({ ...plan, archived }))
    .digest("hex");
  return { id, ...plan, revision, semanticHash, archived };
}

function sanitizePlanInput(input: PlanInput): PlanInput {
  const title = text(input.title, 500, "title");
  const goal = text(input.goal, 4_000, "goal");
  const background = input.background === undefined ? undefined : text(input.background, 8_000, "background");
  const challenges = stringArray(input.challenges, 100, 2_000, "challenges");
  const blockers = stringArray(input.blockers, 100, 2_000, "blockers");
  if (!Array.isArray(input.items) || input.items.length > 500) throw new Error("Plan items are invalid");
  const ids = new Set<string>();
  const items = input.items.map((item) => sanitizeItem(item, 1, ids));
  const focusItemId = input.focusItemId;
  if (focusItemId !== undefined) {
    assertIdentifier(focusItemId, "focus item ID");
    if (!ids.has(focusItemId)) throw new Error("Plan focus item must reference an existing item");
  }
  const nextAction = input.nextAction === undefined ? undefined : text(input.nextAction, 4_000, "next action");
  return {
    title,
    goal,
    ...(background === undefined ? {} : { background }),
    challenges,
    items,
    ...(focusItemId === undefined ? {} : { focusItemId }),
    blockers,
    ...(nextAction === undefined ? {} : { nextAction }),
  };
}

function sanitizeItem(item: PlanWorkItem, depth: number, ids: Set<string>): PlanWorkItem {
  if (depth > 3) throw new Error("Plan work item depth cannot exceed three levels");
  assertIdentifier(item.id, "item ID");
  if (ids.has(item.id)) throw new Error(`Duplicate Plan item ID: ${item.id}`);
  ids.add(item.id);
  if (!STATUSES.has(item.status)) throw new Error(`Invalid Plan item status: ${String(item.status)}`);
  const blocker = item.blocker === undefined ? undefined : text(item.blocker, 2_000, "item blocker");
  if (item.children !== undefined && !Array.isArray(item.children)) throw new Error("Plan item children are invalid");
  const children = item.children?.map((child) => sanitizeItem(child, depth + 1, ids));
  return {
    id: item.id,
    title: text(item.title, 500, "item title"),
    status: item.status,
    ...(blocker === undefined ? {} : { blocker }),
    ...(children === undefined ? {} : { children }),
  };
}

function validateStoredPlan(plan: StoredPlan, expectedId: string): void {
  if (plan.id !== expectedId || !Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    throw new Error("Stored Local Plan metadata is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(plan.semanticHash) || typeof plan.archived !== "boolean") {
    throw new Error("Stored Local Plan integrity metadata is invalid");
  }
  const clean = sanitizePlanInput(plan);
  const expectedHash = createHash("sha256")
    .update(canonicalJson({ ...clean, archived: plan.archived }))
    .digest("hex");
  if (expectedHash !== plan.semanticHash) throw new Error("Stored Local Plan semantic hash mismatch");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function text(value: unknown, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Array.from(value).length > max ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    })
  ) {
    throw new Error(`Plan ${label} is invalid`);
  }
  return value.normalize("NFC");
}

function stringArray(value: unknown, maxItems: number, maxText: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Plan ${label} are invalid`);
  return value.map((item) => text(item, maxText, label));
}

function assertIdentifier(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function planDirectory(plansDir: string, id: string): string {
  assertIdentifier(id, "plan ID");
  return join(plansDir, id);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function writeNewFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureSafePlansDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await assertOrdinaryDirectory(path, "Local Plan root");
}

async function assertOrdinaryDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be an ordinary directory`);
}

async function assertOrdinaryFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be an ordinary file`);
}

async function readLockOwner(path: string): Promise<{ token: string; pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { token?: unknown; pid?: unknown };
    return typeof value.token === "string" && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      ? { token: value.token, pid: Number(value.pid) }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}
