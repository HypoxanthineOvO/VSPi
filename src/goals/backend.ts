import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { GoalBackend, GoalBlocker, GoalInput, GoalMarker, GoalOwner, GoalState, StoredGoal } from "./types.js";

export interface GoalBackendOptions {
  rootDir: string;
  clock?: () => Date;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
const STATES = new Set<GoalState>([
  "executing",
  "paused",
  "blocked",
  "stalled",
  "pending_acceptance",
  "completed",
  "cancelled",
]);
const MAX_MARKERS = 100;

export function createGoalBackend(options: GoalBackendOptions): GoalBackend {
  const goalsDir = join(options.rootDir, "goals");
  const lockDir = join(options.rootDir, ".writer.lock");
  const now = () => (options.clock ?? (() => new Date()))().toISOString();

  async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
    const timeout = options.lockTimeoutMs ?? 5_000;
    const stale = options.staleLockMs ?? 30_000;
    const started = Date.now();
    const token = randomUUID();
    const ownerPath = join(lockDir, "owner.json");
    for (;;) {
      try {
        await mkdir(lockDir);
        await writeNewFile(ownerPath, `${JSON.stringify({ token, pid: process.pid })}\n`);
        break;
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        const owner = await readLockOwner(ownerPath);
        const lockStat = await stat(ownerPath).catch(() => stat(lockDir).catch(() => undefined));
        if (lockStat && Date.now() - lockStat.mtimeMs > stale && (!owner || !processIsAlive(owner.pid))) {
          const claimed = `${lockDir}.stale-${randomUUID()}`;
          try {
            await rename(lockDir, claimed);
            await rm(claimed, { recursive: true, force: true });
            continue;
          } catch (claimError) {
            if (!isCode(claimError, "ENOENT")) throw claimError;
          }
        }
        if (Date.now() - started >= timeout) throw new Error("Goal writer lock timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const heartbeat = setInterval(() => void utimes(ownerPath, new Date(), new Date()).catch(() => undefined), 10_000);
    heartbeat.unref();
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      const owner = await readLockOwner(ownerPath);
      if (owner?.token === token) await rm(lockDir, { recursive: true, force: true });
    }
  }

  async function read(goalId: string): Promise<StoredGoal | undefined> {
    assertId(goalId, "goal ID");
    await ensureGoalsDirectory(goalsDir);
    const directory = join(goalsDir, goalId);
    const headPath = join(directory, "HEAD");
    try {
      await assertDirectory(directory);
      await assertFile(headPath);
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    const head = JSON.parse(await readFile(headPath, "utf8")) as { file?: unknown; hash?: unknown };
    if (typeof head.file !== "string" || !/^\d{8}-[a-f0-9]{12}\.json$/.test(head.file)) {
      throw new Error("Goal HEAD is invalid");
    }
    const revisionPath = join(directory, "revisions", head.file);
    await assertFile(revisionPath);
    const goal = JSON.parse(await readFile(revisionPath, "utf8")) as StoredGoal;
    validateStoredGoal(goal, goalId);
    if (head.hash !== goal.semanticHash) throw new Error("Goal HEAD integrity metadata does not match its revision");
    return structuredClone(goal);
  }

  async function persist(goal: StoredGoal): Promise<StoredGoal> {
    await ensureGoalsDirectory(goalsDir);
    const directory = join(goalsDir, goal.id);
    const revisions = join(directory, "revisions");
    await ensureOrdinaryChildDirectory(directory);
    await ensureOrdinaryChildDirectory(revisions);
    const file = `${String(goal.revision).padStart(8, "0")}-${goal.semanticHash.slice(0, 12)}.json`;
    const revisionPath = join(revisions, file);
    const bytes = `${JSON.stringify(goal, null, 2)}\n`;
    try {
      await writeNewFile(revisionPath, bytes);
    } catch (error) {
      if (!isCode(error, "EEXIST") || (await readFile(revisionPath, "utf8")) !== bytes) throw error;
    }
    const temporary = join(directory, `.HEAD.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ file, hash: goal.semanticHash })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, "HEAD"));
    return structuredClone(goal);
  }

  async function mutate(goalId: string, expectedRevision: number, operation: (goal: StoredGoal) => StoredGoal) {
    return withLock(async () => {
      const current = await read(goalId);
      if (!current) throw new Error(`Goal ${goalId} was not found`);
      if (current.revision !== expectedRevision) {
        throw new Error(`Goal revision conflict: expected ${expectedRevision}, current ${current.revision}`);
      }
      return persist(revise(operation(current), now()));
    });
  }

  return {
    async create(input) {
      return withLock(async () => {
        const clean = sanitizeInput(input);
        let id = `goal-${randomUUID()}`;
        while (await read(id)) id = `goal-${randomUUID()}`;
        const timestamp = now();
        return persist(
          seal({
            id,
            ...clean,
            revision: 1,
            state: "executing",
            autoRounds: 0,
            noProgressRounds: 0,
            consumedTokens: 0,
            markers: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      });
    },
    async list() {
      await ensureGoalsDirectory(goalsDir);
      const entries = await readdir(goalsDir, { withFileTypes: true }).catch((error: unknown) => {
        if (isCode(error, "ENOENT")) return [];
        throw error;
      });
      const goals = await Promise.all(
        entries.filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name)).map((entry) => read(entry.name)),
      );
      return goals
        .filter((goal): goal is StoredGoal => goal !== undefined)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    read,
    checkpoint(goalId, input) {
      return mutate(goalId, input.expectedRevision, (goal) => {
        assertExecuting(goal);
        const marker = sanitizeMarker({
          sequence: (goal.markers.at(-1)?.sequence ?? 0) + 1,
          recordedAt: now(),
          completedWork: input.completedWork,
          evidence: input.evidence,
          ...(input.currentItem === undefined ? {} : { currentItem: input.currentItem }),
          ...(input.nextItem === undefined ? {} : { nextItem: input.nextItem }),
          ...(input.note === undefined ? {} : { note: input.note }),
        });
        return { ...goal, markers: [...goal.markers, marker].slice(-MAX_MARKERS) };
      });
    },
    recordRound(goalId, input) {
      return mutate(goalId, input.expectedRevision, (goal) => {
        assertExecuting(goal);
        const autoRounds = goal.autoRounds + 1;
        const noProgressRounds = input.progressed ? 0 : goal.noProgressRounds + 1;
        const consumedTokens = integer(input.consumedTokens, 0, Number.MAX_SAFE_INTEGER, "consumed tokens");
        if (consumedTokens >= goal.limits.maxTokens) {
          return {
            ...goal,
            autoRounds,
            noProgressRounds,
            consumedTokens,
            state: "paused",
            stateReason: "token_budget",
          };
        }
        if (autoRounds >= goal.limits.maxAutoRounds) {
          return {
            ...goal,
            autoRounds,
            noProgressRounds,
            consumedTokens,
            state: "paused",
            stateReason: "round_budget",
          };
        }
        if (noProgressRounds >= goal.limits.maxNoProgressRounds) {
          return {
            ...goal,
            autoRounds,
            noProgressRounds,
            consumedTokens,
            state: "stalled",
            stateReason: "no_progress",
          };
        }
        return { ...goal, autoRounds, noProgressRounds, consumedTokens };
      });
    },
    block(goalId, input) {
      return mutate(goalId, input.expectedRevision, (goal) => {
        assertExecuting(goal);
        const blocker: GoalBlocker = {
          reason: text(input.reason, 4_000, "blocker reason"),
          attempts: texts(input.attempts, 50, 4_000, "blocker attempts"),
          neededInput: text(input.neededInput, 4_000, "needed input"),
          recordedAt: now(),
        };
        return { ...goal, state: "blocked", blocker, stateReason: "model_blocked" };
      });
    },
    claimComplete(goalId, input) {
      return mutate(goalId, input.expectedRevision, (goal) => {
        assertExecuting(goal);
        const marker = sanitizeMarker({
          sequence: (goal.markers.at(-1)?.sequence ?? 0) + 1,
          recordedAt: now(),
          completedWork: [text(input.summary, 4_000, "completion summary")],
          evidence: texts(input.evidence, 100, 4_000, "completion evidence"),
          note: "completion_claim",
        });
        return {
          ...goal,
          state: "pending_acceptance",
          stateReason: "model_claimed_complete",
          markers: [...goal.markers, marker].slice(-MAX_MARKERS),
        };
      });
    },
    transition(goalId, input) {
      return mutate(goalId, input.expectedRevision, (goal) =>
        transition(goal, input.state, input.reason, input.owner, input.initialTokens),
      );
    },
  };
}

function transition(
  goal: StoredGoal,
  state: "executing" | "paused" | "completed" | "cancelled",
  reason?: string,
  owner?: GoalOwner,
  initialTokens?: number,
): StoredGoal {
  if (state === "completed" && goal.state !== "pending_acceptance")
    throw new Error("Only a pending Goal can be accepted");
  if (state === "executing" && (goal.state === "completed" || goal.state === "cancelled"))
    throw new Error("A terminal Goal cannot resume");
  if ((state === "paused" || state === "cancelled") && goal.state === "completed")
    throw new Error("A completed Goal cannot transition");
  const { blocker: _blocker, stateReason: previousReason, ...base } = goal;
  return {
    ...base,
    state,
    ...(owner ? { owner: sanitizeOwner(owner) } : {}),
    ...(state === "executing"
      ? {
          autoRounds: 0,
          noProgressRounds: 0,
          consumedTokens: 0,
          initialTokens: integer(initialTokens ?? goal.initialTokens, 0, Number.MAX_SAFE_INTEGER, "initial tokens"),
        }
      : goal.blocker
        ? { blocker: goal.blocker }
        : {}),
    ...(reason
      ? { stateReason: text(reason, 2_000, "state reason") }
      : state === "executing"
        ? {}
        : previousReason
          ? { stateReason: previousReason }
          : {}),
  };
}

function sanitizeInput(input: GoalInput): GoalInput {
  assertId(input.planId, "plan ID");
  return {
    contract: {
      objective: text(input.contract.objective, 16_000, "objective"),
      completionCriteria: texts(input.contract.completionCriteria, 100, 4_000, "completion criteria"),
    },
    planId: input.planId,
    limits: {
      maxAutoRounds: integer(input.limits.maxAutoRounds, 1, 1_000, "maximum rounds"),
      maxNoProgressRounds: integer(input.limits.maxNoProgressRounds, 1, 100, "maximum no-progress rounds"),
      maxTokens: integer(input.limits.maxTokens, 1_000, 100_000_000, "maximum tokens"),
    },
    owner: sanitizeOwner(input.owner),
    initialTokens: integer(input.initialTokens, 0, Number.MAX_SAFE_INTEGER, "initial tokens"),
  };
}

function sanitizeOwner(owner: GoalOwner): GoalOwner {
  assertId(owner.sessionId, "owner session ID");
  return {
    sessionId: owner.sessionId,
    processId: text(owner.processId, 200, "owner process ID"),
    acquiredAt: iso(owner.acquiredAt, "owner acquired time"),
  };
}

function sanitizeMarker(marker: GoalMarker): GoalMarker {
  return {
    sequence: integer(marker.sequence, 1, Number.MAX_SAFE_INTEGER, "marker sequence"),
    recordedAt: iso(marker.recordedAt, "marker time"),
    ...(marker.currentItem === undefined ? {} : { currentItem: text(marker.currentItem, 2_000, "current item") }),
    completedWork: texts(marker.completedWork, 100, 4_000, "completed work"),
    evidence: texts(marker.evidence, 100, 4_000, "evidence"),
    ...(marker.nextItem === undefined ? {} : { nextItem: text(marker.nextItem, 2_000, "next item") }),
    ...(marker.note === undefined ? {} : { note: text(marker.note, 4_000, "marker note") }),
  };
}

function revise(goal: StoredGoal, updatedAt: string): StoredGoal {
  return seal({ ...goal, revision: goal.revision + 1, updatedAt });
}

function seal(goal: Omit<StoredGoal, "semanticHash"> | StoredGoal): StoredGoal {
  const { semanticHash: _ignored, ...semantic } = goal as StoredGoal;
  const semanticHash = createHash("sha256").update(canonicalJson(semantic)).digest("hex");
  return { ...semantic, semanticHash } as StoredGoal;
}

function validateStoredGoal(goal: StoredGoal, expectedId: string): void {
  if (goal.id !== expectedId || !Number.isSafeInteger(goal.revision) || goal.revision < 1 || !STATES.has(goal.state)) {
    throw new Error("Stored Goal metadata is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(goal.semanticHash)) throw new Error("Stored Goal semantic hash is invalid");
  sanitizeInput(goal);
  goal.markers.forEach(sanitizeMarker);
  const expected = seal(goal).semanticHash;
  if (expected !== goal.semanticHash) throw new Error("Stored Goal semantic hash mismatch");
}

function assertExecuting(goal: StoredGoal): void {
  if (goal.state !== "executing") throw new Error(`Goal is ${goal.state}, not executing`);
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
    value.trim().length < 1 ||
    Array.from(value).length > max ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    })
  )
    throw new Error(`Goal ${label} is invalid`);
  return value.normalize("NFC");
}

function texts(value: unknown, maxItems: number, maxText: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Goal ${label} are invalid`);
  return value.map((item) => text(item, maxText, label));
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Goal ${label} is invalid`);
  return value as number;
}

function iso(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Goal ${label} is invalid`);
  return value;
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

async function assertDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error("Goal path is not an ordinary directory");
}

async function ensureGoalsDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertDirectory(path);
}

async function ensureOrdinaryChildDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  await assertDirectory(path);
}

async function assertFile(path: string): Promise<void> {
  if (!(await lstat(path)).isFile()) throw new Error("Goal path is not an ordinary file");
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

async function readLockOwner(path: string): Promise<{ token: string; pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { token?: unknown; pid?: unknown };
    return typeof value.token === "string" && Number.isSafeInteger(value.pid)
      ? { token: value.token, pid: value.pid as number }
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
