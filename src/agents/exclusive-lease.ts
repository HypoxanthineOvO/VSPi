import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

const POLL_MS = 50;
const REMOTE_STALE_MS = 15_000;

interface StoredOwner {
  schemaVersion: 1;
  pid: number;
  hostname: string;
  token: string;
  identity: string;
  acquiredAt: string;
}

export class AgentLeaseConflictError extends Error {
  override readonly name = "AgentLeaseConflictError";

  constructor(
    namespace: string,
    readonly owner: { pid: number; hostname: string },
  ) {
    super(`Agent ${namespace} lease is already held by pid ${owner.pid}`);
  }
}

export interface AgentExclusiveLease {
  readonly owner: StoredOwner;
  readonly path: string;
  release(): Promise<void>;
}

export async function acquireAgentExclusiveLease(input: {
  agentDir: string;
  namespace: string;
  identity: string;
  signal?: AbortSignal;
  wait?: boolean;
  timeoutMs?: number;
}): Promise<AgentExclusiveLease> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.namespace)) throw new Error("Agent lease namespace is invalid");
  const directory = join(resolve(input.agentDir), "vspi-agent-leases");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Agent lease path is not a directory");
  const key = createHash("sha256").update(input.identity).digest("hex").slice(0, 24);
  const path = join(directory, `${input.namespace}-${key}.json`);
  const owner: StoredOwner = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomBytes(16).toString("hex"),
    identity: input.identity,
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  while (true) {
    throwIfAborted(input.signal);
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      const heartbeat = setInterval(() => void utimes(path, new Date(), new Date()).catch(() => undefined), 2_000);
      heartbeat.unref();
      return {
        owner,
        path,
        async release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          if ((await readOwner(path))?.token === owner.token) await unlink(path).catch(ignoreMissing);
        },
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const current = await readOwner(path);
    if (!current || !(await ownerAlive(current, path))) {
      if (!current || (await readOwner(path))?.token === current.token) await unlink(path).catch(ignoreMissing);
      continue;
    }
    if (!input.wait) {
      throw new AgentLeaseConflictError(input.namespace, { pid: current.pid, hostname: current.hostname });
    }
    if (Date.now() >= deadline) throw new Error(`Agent ${input.namespace} lease wait timed out`);
    await wait(POLL_MS, input.signal);
  }
}

async function readOwner(path: string): Promise<StoredOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      (value as StoredOwner).schemaVersion !== 1 ||
      !Number.isSafeInteger((value as StoredOwner).pid) ||
      typeof (value as StoredOwner).hostname !== "string" ||
      typeof (value as StoredOwner).token !== "string" ||
      typeof (value as StoredOwner).identity !== "string"
    )
      return undefined;
    return value as StoredOwner;
  } catch {
    return undefined;
  }
}

async function ownerAlive(owner: StoredOwner, path: string): Promise<boolean> {
  if (owner.hostname !== hostname()) {
    try {
      return Date.now() - (await stat(path)).mtimeMs < REMOTE_STALE_MS;
    } catch {
      return false;
    }
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectPromise(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  throwIfAborted(signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Agent lease wait was cancelled");
  error.name = "AbortError";
  return error;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function ignoreMissing(error: unknown): void {
  if (!hasCode(error, "ENOENT")) throw error;
}
