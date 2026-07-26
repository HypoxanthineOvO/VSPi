import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

const HEARTBEAT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 2_000;
const WAIT_POLL_MS = 200;
const MAX_CONTROL_BYTES = 1024 * 1024;

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
  onTakeover: (channel: SessionHandoffChannel) => Promise<void> | void;
  onWait?: (owner: SessionLeaseOwner) => void;
  onInteraction?: (interaction: SessionHandoffInteraction, signal?: AbortSignal) => Promise<unknown>;
}

export interface SessionHandoffInteraction {
  kind: "question" | "approval";
  payload: unknown;
}

export interface SessionHandoffChannel {
  readonly closed: Promise<void>;
  request(interaction: SessionHandoffInteraction): Promise<unknown>;
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
  const socketsBeforeLease = new Set<Socket>();
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
    if (lease) lease.track(socket);
    else {
      socketsBeforeLease.add(socket);
      socket.once("close", () => socketsBeforeLease.delete(socket));
    }
    let input = "";
    let channel: SocketHandoffChannel | undefined;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_BYTES) {
        socket.destroy(new Error("Session handoff control message is too large"));
        return;
      }
      while (input.includes("\n")) {
        const end = input.indexOf("\n");
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        if (channel) {
          channel.handle(line);
          continue;
        }
        const request = parseTakeoverRequest(line);
        if (!request || request.token !== token) {
          socket.end(`${JSON.stringify({ status: "rejected" })}\n`);
          return;
        }
        if (takeoverStarted) {
          socket.end(`${JSON.stringify({ status: "waiting" })}\n`);
          return;
        }
        takeoverStarted = true;
        channel = new SocketHandoffChannel(socket);
        void channel.closed.then(() => {
          takeoverStarted = false;
        });
        socket.write(`${JSON.stringify({ status: "accepted" })}\n`);
        void Promise.resolve(options.onTakeover(channel)).catch(() => {
          takeoverStarted = false;
          channel?.close(new Error("Session owner failed to prepare handoff"));
        });
      }
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
        for (const socket of socketsBeforeLease) lease.track(socket);
        socketsBeforeLease.clear();
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
          await requestTakeover(existing, options.signal, options.onInteraction);
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

async function requestTakeover(
  owner: SessionLeaseOwner,
  signal?: AbortSignal,
  onInteraction?: SessionLeaseAcquireOptions["onInteraction"],
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection(owner.socketPath);
    let settled = false;
    let accepted = false;
    let input = "";
    const interactionControllers = new Set<AbortController>();
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error("Session owner 未响应接管请求"));
    }, CONNECT_TIMEOUT_MS);
    const onAbort = () => {
      socket.destroy();
      rejectPromise(new Error("Session 接管已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
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
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_BYTES) {
        socket.destroy(new Error("Session handoff control message is too large"));
        return;
      }
      while (input.includes("\n")) {
        const end = input.indexOf("\n");
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        if (!accepted) {
          try {
            const parsed = JSON.parse(line) as { status?: string };
            if (parsed.status === "accepted") {
              accepted = true;
              clearTimeout(timer);
            } else if (parsed.status === "waiting") {
              finish();
              socket.end();
            } else {
              finish(new Error("Session owner 拒绝了接管请求"));
              socket.end();
            }
          } catch {
            finish(new Error("Session owner 返回了无效响应"));
            socket.end();
          }
          continue;
        }
        const request = parseInteractionRequest(line);
        if (!request) {
          socket.destroy(new Error("Session owner 返回了无效交互请求"));
          return;
        }
        const controller = new AbortController();
        interactionControllers.add(controller);
        const interaction = onInteraction
          ? onInteraction(request.interaction, controller.signal)
          : Promise.reject(new Error("Session handoff interaction UI is unavailable"));
        void Promise.resolve(interaction)
          .then(
            (value) => writeControl(socket, { type: "interaction_response", id: request.id, ok: true, value }),
            (error: unknown) =>
              writeControl(socket, {
                type: "interaction_response",
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : "Handoff interaction failed",
              }),
          )
          .finally(() => interactionControllers.delete(controller));
      }
    });
    socket.once("close", () => {
      for (const controller of interactionControllers) controller.abort();
      if (accepted) finish();
    });
    socket.once("error", (error) => {
      finish(error);
    });
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
    const parsed = JSON.parse(input) as { type?: unknown; token?: unknown };
    return parsed.type === "takeover" && typeof parsed.token === "string" ? { token: parsed.token } : undefined;
  } catch {
    return undefined;
  }
}

class SocketHandoffChannel implements SessionHandoffChannel {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolvePromise) => {
    this.resolveClosed = resolvePromise;
  });
  private sequence = 0;

  constructor(private readonly socket: Socket) {
    socket.once("close", () => this.close(new Error("Session handoff channel closed")));
    socket.once("error", (error) => this.close(error));
  }

  request(interaction: SessionHandoffInteraction): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new Error("Session handoff channel is unavailable"));
    const id = `${process.pid}-${++this.sequence}`;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      writeControl(this.socket, { type: "interaction", id, interaction });
    });
  }

  handle(line: string): void {
    const response = parseInteractionResponse(line);
    if (!response) {
      this.close(new Error("Session handoff response is invalid"));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error ?? "Session handoff interaction failed"));
  }

  close(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.resolveClosed();
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

function parseInteractionRequest(line: string): { id: string; interaction: SessionHandoffInteraction } | undefined {
  try {
    const value = JSON.parse(line) as { type?: unknown; id?: unknown; interaction?: unknown };
    if (value.type !== "interaction" || typeof value.id !== "string" || !isHandoffInteraction(value.interaction)) {
      return undefined;
    }
    return { id: value.id, interaction: value.interaction };
  } catch {
    return undefined;
  }
}

function parseInteractionResponse(
  line: string,
): { id: string; ok: boolean; value?: unknown; error?: string } | undefined {
  try {
    const value = JSON.parse(line) as { type?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    if (value.type !== "interaction_response" || typeof value.id !== "string" || typeof value.ok !== "boolean") {
      return undefined;
    }
    return {
      id: value.id,
      ok: value.ok,
      ...(value.value !== undefined ? { value: value.value } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
  } catch {
    return undefined;
  }
}

function isHandoffInteraction(value: unknown): value is SessionHandoffInteraction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const interaction = value as { kind?: unknown; payload?: unknown };
  return (interaction.kind === "question" || interaction.kind === "approval") && "payload" in interaction;
}

function writeControl(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
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
