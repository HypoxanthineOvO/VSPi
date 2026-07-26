import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

const HEARTBEAT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 2_000;
const WAIT_POLL_MS = 200;

export interface SessionLeaseOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  sessionPath: string;
  socketPath: string;
  token: string;
}

export interface SessionLeaseAcquireOptions {
  agentDir: string;
  signal?: AbortSignal;
  onTakeover: () => Promise<void> | void;
  onWait?: (owner: SessionLeaseOwner) => void;
}

export interface AcquiredSessionLease {
  lease: SessionLease;
  waited: boolean;
}

interface StoredLeaseOwner extends Omit<SessionLeaseOwner, "heartbeatAt"> {
  schemaVersion: 1;
}

export class SessionLease {
  private heartbeat: NodeJS.Timeout | undefined;
  private released = false;
  private sockets = new Set<Socket>();

  constructor(
    readonly sessionPath: string,
    readonly leasePath: string,
    readonly owner: StoredLeaseOwner,
    private readonly server: Server,
  ) {
    this.heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(this.leasePath, now, now).catch(() => {});
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.sockets) socket.destroy();
    await closeServer(this.server);
    await removeIfOwned(this.leasePath, this.owner.token);
    await unlink(this.owner.socketPath).catch(ignoreMissing);
  }
}

export async function acquireSessionLease(
  sessionFile: string,
  options: SessionLeaseAcquireOptions,
): Promise<AcquiredSessionLease> {
  const sessionPath = resolve(sessionFile);
  const directory = join(resolve(options.agentDir), "session-leases");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const identity = createHash("sha256").update(sessionPath).digest("hex").slice(0, 20);
  const leasePath = join(directory, `${identity}.json`);
  const token = randomBytes(16).toString("hex");
  const socketPath = join(directory, `${identity}-${process.pid}-${token.slice(0, 8)}.sock`);
  let takeoverStarted = false;
  let lease: SessionLease | undefined;
  const owner: StoredLeaseOwner = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    sessionPath,
    socketPath,
    token,
  };
  const server = createServer((socket) => {
    lease?.track(socket);
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = parseTakeoverRequest(input);
      if (!request || request.token !== token) {
        socket.end(`${JSON.stringify({ status: "rejected" })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ status: "accepted" })}\n`);
      if (takeoverStarted) return;
      takeoverStarted = true;
      void Promise.resolve(options.onTakeover()).catch(() => {
        takeoverStarted = false;
      });
    });
  });
  await listenUnix(server, socketPath);
  await chmod(socketPath, 0o600);

  let waited = false;
  let requestedOwnerToken: string | undefined;
  try {
    while (true) {
      throwIfAborted(options.signal);
      try {
        const handle = await open(leasePath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        lease = new SessionLease(sessionPath, leasePath, owner, server);
        return { lease, waited };
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }

      const existing = await readLeaseOwner(leasePath);
      if (!existing) {
        if (await recentlyCreated(leasePath)) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, WAIT_POLL_MS));
          continue;
        }
        await unlink(leasePath).catch(ignoreMissing);
        continue;
      }
      if (!(await ownerIsAlive(existing))) {
        await removeIfOwned(leasePath, existing.token);
        await unlink(existing.socketPath).catch(ignoreMissing);
        continue;
      }
      if (requestedOwnerToken !== existing.token) {
        waited = true;
        requestedOwnerToken = existing.token;
        options.onWait?.(existing);
        try {
          await requestTakeover(existing, options.signal);
        } catch (error) {
          await waitForPoll(options.signal);
          const current = await readLeaseOwner(leasePath);
          if (!current || current.token !== existing.token || !(await ownerIsAlive(current))) {
            requestedOwnerToken = undefined;
            continue;
          }
          throw error;
        }
      }
      await waitForLeaseRelease(leasePath, existing.token, options.signal);
    }
  } catch (error) {
    await closeServer(server);
    await unlink(socketPath).catch(ignoreMissing);
    throw error;
  }
}

export async function readSessionLease(sessionFile: string, agentDir: string): Promise<SessionLeaseOwner | undefined> {
  const sessionPath = resolve(sessionFile);
  const identity = createHash("sha256").update(sessionPath).digest("hex").slice(0, 20);
  const leasePath = join(resolve(agentDir), "session-leases", `${identity}.json`);
  const owner = await readLeaseOwner(leasePath);
  if (!owner || (await ownerIsAlive(owner))) return owner;
  await removeIfOwned(leasePath, owner.token);
  await unlink(owner.socketPath).catch(ignoreMissing);
  return undefined;
}

async function readLeaseOwner(path: string): Promise<SessionLeaseOwner | undefined> {
  try {
    const [raw, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const value: unknown = JSON.parse(raw);
    if (!isStoredOwner(value)) return undefined;
    return { ...value, heartbeatAt: metadata.mtime.toISOString() };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    return undefined;
  }
}

async function recentlyCreated(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return Date.now() - metadata.mtimeMs < 5_000;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

async function ownerIsAlive(owner: SessionLeaseOwner): Promise<boolean> {
  if (owner.hostname !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

async function requestTakeover(owner: SessionLeaseOwner, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection(owner.socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error("Session owner 未响应接管请求"));
    }, CONNECT_TIMEOUT_MS);
    const onAbort = () => {
      socket.destroy();
      rejectPromise(new Error("Session 接管已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let response = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "takeover", token: owner.token })}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\n")) return;
      try {
        const parsed = JSON.parse(response.split("\n", 1)[0] ?? "") as { status?: string };
        if (parsed.status === "accepted") finish();
        else finish(new Error("Session owner 拒绝了接管请求"));
      } catch {
        finish(new Error("Session owner 返回了无效响应"));
      } finally {
        socket.end();
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

async function waitForLeaseRelease(path: string, token: string, signal?: AbortSignal): Promise<void> {
  while (true) {
    throwIfAborted(signal);
    const current = await readLeaseOwner(path);
    if (!current || current.token !== token) return;
    await waitForPoll(signal);
  }
}

async function waitForPoll(signal?: AbortSignal): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, WAIT_POLL_MS));
  throwIfAborted(signal);
}

async function removeIfOwned(path: string, token: string): Promise<void> {
  const current = await readLeaseOwner(path);
  if (current?.token !== token) return;
  await unlink(path).catch(ignoreMissing);
}

function parseTakeoverRequest(input: string): { token: string } | undefined {
  try {
    const parsed = JSON.parse(input.split("\n", 1)[0] ?? "") as { type?: unknown; token?: unknown };
    return parsed.type === "takeover" && typeof parsed.token === "string" ? { token: parsed.token } : undefined;
  } catch {
    return undefined;
  }
}

function isStoredOwner(value: unknown): value is StoredLeaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<StoredLeaseOwner>;
  return (
    owner.schemaVersion === 1 &&
    Number.isInteger(owner.pid) &&
    (owner.pid ?? 0) > 0 &&
    typeof owner.hostname === "string" &&
    typeof owner.startedAt === "string" &&
    typeof owner.sessionPath === "string" &&
    typeof owner.socketPath === "string" &&
    typeof owner.token === "string"
  );
}

function listenUnix(server: Server, path: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(path, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Session 接管已取消");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && String(error.code) === code;
}

function ignoreMissing(error: unknown): void {
  if (!hasCode(error, "ENOENT")) throw error;
}
