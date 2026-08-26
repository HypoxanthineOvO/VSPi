import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, utimes } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

const HEARTBEAT_MS = 2_000;
const HEARTBEAT_STALE_MS = 15_000;
const CONNECT_TIMEOUT_MS = 2_000;
const WAIT_POLL_MS = 200;
const OWNER_EXIT_WAIT_MS = 3_000;
const RECOVERY_CLAIM_GRACE_MS = 5_000;
const MAX_CONTROL_BYTES = 16 * 1024 * 1024;
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\vspi-session-";

export interface SessionLeaseOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  sessionPath: string;
  socketPath: string;
  token: string;
  schemaVersion: 1 | 2;
  processIdentity?: LinuxProcessIdentity;
}

export interface LinuxProcessIdentity {
  kind: "linux-proc";
  bootId: string;
  startTimeTicks: string;
  uid: number;
}

export type SessionOwnerRecoveryResult = "released" | "still-running" | "owner-changed";

export class SessionLeaseUnresponsiveError extends Error {
  constructor(readonly owner: SessionLeaseOwner) {
    super("Session owner 未响应接管请求");
    this.name = "SessionLeaseUnresponsiveError";
  }
}

export interface SessionLeaseAcquireOptions {
  agentDir: string;
  signal?: AbortSignal;
  onTakeover: (channel: SessionHandoffChannel) => Promise<void> | void;
  onWait?: (owner: SessionLeaseOwner) => void;
  onInteraction?: (interaction: SessionHandoffInteraction, signal?: AbortSignal) => Promise<unknown>;
  onProjection?: (projection: SessionHandoffProjection) => void;
  onConnected?: (client: SessionHandoffClient) => void;
  onUnresponsiveOwner?: (owner: SessionLeaseOwner) => Promise<void>;
}

export interface SessionHandoffInteraction {
  kind: "question" | "approval";
  payload: unknown;
}

export interface SessionHandoffProjection {
  kind: string;
  payload?: unknown;
}

export interface SessionHandoffCommand {
  kind: "interrupt" | "enqueue";
  payload?: unknown;
}

export interface SessionHandoffClient {
  readonly closed: Promise<void>;
  command(command: SessionHandoffCommand): Promise<unknown>;
}

export interface SessionHandoffChannel {
  readonly closed: Promise<void>;
  readonly successor: SessionLeaseSuccessor;
  request(interaction: SessionHandoffInteraction): Promise<unknown>;
  project(projection: SessionHandoffProjection): void;
  setCommandHandler(handler: (command: SessionHandoffCommand) => Promise<unknown>): void;
}

export interface AcquiredSessionLease {
  lease: SessionLease;
  waited: boolean;
}

export type SessionLeaseSuccessor = Omit<SessionLeaseOwner, "heartbeatAt">;

type StoredLeaseOwner = SessionLeaseSuccessor;

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
    await removeSocketFile(this.owner.socketPath);
  }

  async transfer(successor: SessionLeaseSuccessor): Promise<void> {
    if (this.released) throw new Error("Cannot transfer a released Session lease");
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const current = await readLeaseOwner(this.leasePath);
    if (current?.token !== this.owner.token) throw new Error("Session lease ownership changed before transfer");
    const temporary = `${this.leasePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(successor, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.leasePath);
    } finally {
      await rm(temporary, { force: true });
    }
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
  const socketPath = sessionSocketPath(directory, identity, process.pid, token);
  let takeoverStarted = false;
  let lease: SessionLease | undefined;
  const socketsBeforeLease = new Set<Socket>();
  const processIdentity = await currentLinuxProcessIdentity();
  const owner: StoredLeaseOwner = {
    schemaVersion: processIdentity ? 2 : 1,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    sessionPath,
    socketPath,
    token,
    ...(processIdentity ? { processIdentity } : {}),
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
        const request = parseTakeoverRequest(line, sessionPath, directory);
        if (!request || request.token !== token) {
          socket.end(`${JSON.stringify({ status: "rejected" })}\n`);
          return;
        }
        if (takeoverStarted) {
          socket.end(`${JSON.stringify({ status: "waiting" })}\n`);
          return;
        }
        takeoverStarted = true;
        channel = new SocketHandoffChannel(socket, request.successor);
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
  if (process.platform !== "win32") await chmod(socketPath, 0o600);

  let waited = false;
  let requestedOwnerToken: string | undefined;
  try {
    while (true) {
      throwIfAborted(options.signal);
      if (await recoveryClaimIsActive(leasePath)) {
        await waitForPoll(options.signal);
        continue;
      }
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
        if (!(await removeDeadOwnerLease(leasePath, existing))) {
          await waitForPoll(options.signal);
          continue;
        }
        await removeSocketFile(existing.socketPath);
        continue;
      }
      if (existing.token === token) {
        lease = new SessionLease(sessionPath, leasePath, owner, server);
        for (const socket of socketsBeforeLease) lease.track(socket);
        socketsBeforeLease.clear();
        return { lease, waited };
      }
      if (requestedOwnerToken !== existing.token) {
        waited = true;
        requestedOwnerToken = existing.token;
        options.onWait?.(existing);
        try {
          await requestTakeover(leasePath, existing, owner, options);
        } catch (error) {
          if (error instanceof SessionLeaseUnresponsiveError && options.onUnresponsiveOwner) {
            await options.onUnresponsiveOwner(error.owner);
            requestedOwnerToken = undefined;
            continue;
          }
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
    await removeSocketFile(socketPath);
    throw error;
  }
}

export async function readSessionLease(sessionFile: string, agentDir: string): Promise<SessionLeaseOwner | undefined> {
  const sessionPath = resolve(sessionFile);
  const identity = createHash("sha256").update(sessionPath).digest("hex").slice(0, 20);
  const leasePath = join(resolve(agentDir), "session-leases", `${identity}.json`);
  const owner = await readLeaseOwner(leasePath);
  if (!owner || (await ownerIsAlive(owner))) return owner;
  if (!(await removeDeadOwnerLease(leasePath, owner))) return owner;
  await removeSocketFile(owner.socketPath);
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
  if (owner.schemaVersion === 2 && owner.processIdentity) {
    if (process.platform !== "linux") return true;
    try {
      return sameProcessIdentity(await readLinuxProcessIdentity(owner.pid), owner.processIdentity);
    } catch {
      return true;
    }
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

async function requestTakeover(
  leasePath: string,
  owner: SessionLeaseOwner,
  successor: SessionLeaseSuccessor,
  options: SessionLeaseAcquireOptions,
): Promise<void> {
  const signal = options.signal;
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection(owner.socketPath);
    let settled = false;
    let accepted = false;
    let input = "";
    const interactionControllers = new Set<AbortController>();
    let client: SocketHandoffClient | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new SessionLeaseUnresponsiveError(owner));
    }, CONNECT_TIMEOUT_MS);
    const onAbort = () => {
      socket.destroy();
      finish(new Error("Session 接管已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const monitorHeartbeat = () => {
      heartbeatTimer = setTimeout(() => {
        void readLeaseOwner(leasePath).then(
          (current) => {
            if (settled) return;
            if (!current || current.token !== owner.token) {
              finish();
              socket.end();
              return;
            }
            const heartbeatAt = Date.parse(current.heartbeatAt);
            if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt > HEARTBEAT_STALE_MS) {
              finish(new SessionLeaseUnresponsiveError(current));
              socket.destroy();
              return;
            }
            monitorHeartbeat();
          },
          (error: unknown) => {
            finish(error instanceof Error ? error : new Error("Session owner heartbeat check failed"));
            socket.destroy();
          },
        );
      }, WAIT_POLL_MS);
      heartbeatTimer.unref();
    };
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ type: "takeover", token: owner.token, successor })}\n`),
    );
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
              client = new SocketHandoffClient(socket);
              options.onConnected?.(client);
              monitorHeartbeat();
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
        if (request) {
          const controller = new AbortController();
          interactionControllers.add(controller);
          const interaction = options.onInteraction
            ? options.onInteraction(request.interaction, controller.signal)
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
          continue;
        }
        const projection = parseProjection(line);
        if (projection) {
          options.onProjection?.(projection);
          continue;
        }
        if (client?.handle(line)) continue;
        socket.destroy(new Error("Session owner 返回了无效控制消息"));
        return;
      }
    });
    socket.once("close", () => {
      for (const controller of interactionControllers) controller.abort();
      client?.close(new Error("Session handoff channel closed"));
      if (accepted) finish();
    });
    socket.once("error", (error) => {
      finish(accepted ? error : new SessionLeaseUnresponsiveError(owner));
    });
  });
}

export async function terminateUnresponsiveSessionOwner(
  sessionFile: string,
  agentDir: string,
  owner: SessionLeaseSuccessor,
  waitMs = OWNER_EXIT_WAIT_MS,
): Promise<SessionOwnerRecoveryResult> {
  return signalUnresponsiveSessionOwner(sessionFile, agentDir, owner, "SIGTERM", waitMs);
}

export async function killUnresponsiveSessionOwner(
  sessionFile: string,
  agentDir: string,
  owner: SessionLeaseSuccessor,
  waitMs = OWNER_EXIT_WAIT_MS,
): Promise<SessionOwnerRecoveryResult> {
  return signalUnresponsiveSessionOwner(sessionFile, agentDir, owner, "SIGKILL", waitMs);
}

async function signalUnresponsiveSessionOwner(
  sessionFile: string,
  agentDir: string,
  expected: SessionLeaseSuccessor,
  signal: "SIGTERM" | "SIGKILL",
  waitMs: number,
): Promise<SessionOwnerRecoveryResult> {
  const sessionPath = resolve(sessionFile);
  const identity = createHash("sha256").update(sessionPath).digest("hex").slice(0, 20);
  const leasePath = join(resolve(agentDir), "session-leases", `${identity}.json`);
  const claim = await acquireRecoveryClaim(leasePath, expected);
  if (!claim) throw new Error("另一个进程正在恢复这个 Session");
  try {
    const current = await readLeaseOwner(leasePath);
    if (!current || !sameRecoveryOwner(current, expected)) return "owner-changed";
    const processIdentity = requireRecoverableIdentity(current);
    const observed = await readLinuxProcessIdentity(current.pid);
    if (!sameProcessIdentity(observed, processIdentity)) {
      return (await removeRecoveredLease(leasePath, current)) ? "released" : "owner-changed";
    }
    try {
      process.kill(current.pid, signal);
    } catch (error) {
      if (!hasCode(error, "ESRCH")) throw error;
      const liveIdentity = await readLinuxProcessIdentity(current.pid);
      if (sameProcessIdentity(liveIdentity, processIdentity)) throw error;
      return (await removeRecoveredLease(leasePath, current)) ? "released" : "owner-changed";
    }
    const deadline = Date.now() + Math.max(0, waitMs);
    do {
      await waitForPoll();
      const latest = await readLeaseOwner(leasePath);
      if (!sameRecoveryOwner(latest, current)) return "owner-changed";
      const liveIdentity = await readLinuxProcessIdentity(current.pid);
      if (!sameProcessIdentity(liveIdentity, processIdentity)) {
        return (await removeRecoveredLease(leasePath, current)) ? "released" : "owner-changed";
      }
    } while (Date.now() < deadline);
    return "still-running";
  } finally {
    await releaseRecoveryClaim(claim);
  }
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

interface RecoveryClaim {
  path: string;
  token: string;
}

interface StoredRecoveryClaim {
  schemaVersion: 1;
  token: string;
  ownerToken: string;
  pid: number;
  processIdentity?: LinuxProcessIdentity;
}

async function acquireRecoveryClaim(
  leasePath: string,
  owner: SessionLeaseSuccessor,
): Promise<RecoveryClaim | undefined> {
  const path = `${leasePath}.recovery`;
  const token = randomBytes(16).toString("hex");
  const processIdentity = await currentLinuxProcessIdentity();
  const stored: StoredRecoveryClaim = {
    schemaVersion: 1,
    token,
    ownerToken: owner.token,
    pid: process.pid,
    ...(processIdentity ? { processIdentity } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { path, token };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readRecoveryClaim(path);
      if (!existing) {
        if (await removeStaleMalformedRecoveryClaim(path)) continue;
        return undefined;
      }
      if (
        !existing.processIdentity ||
        process.platform !== "linux" ||
        sameProcessIdentity(await readLinuxProcessIdentity(existing.pid), existing.processIdentity)
      ) {
        return undefined;
      }
      await removeRecoveryClaimIfOwned(path, existing.token);
    }
  }
  return undefined;
}

async function releaseRecoveryClaim(claim: RecoveryClaim): Promise<void> {
  await removeRecoveryClaimIfOwned(claim.path, claim.token);
}

async function readRecoveryClaim(path: string): Promise<StoredRecoveryClaim | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<StoredRecoveryClaim>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.token !== "string" ||
      typeof value.ownerToken !== "string" ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      (value.processIdentity !== undefined && !isLinuxProcessIdentity(value.processIdentity))
    ) {
      return undefined;
    }
    return value as StoredRecoveryClaim;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    return undefined;
  }
}

async function removeRecoveryClaimIfOwned(path: string, token: string): Promise<void> {
  const current = await readRecoveryClaim(path);
  if (current?.token === token) await unlink(path).catch(ignoreMissing);
}

async function recoveryClaimIsActive(leasePath: string): Promise<boolean> {
  const path = `${leasePath}.recovery`;
  const claim = await readRecoveryClaim(path);
  if (!claim) {
    return !(await removeStaleMalformedRecoveryClaim(path));
  }
  if (
    claim.processIdentity &&
    process.platform === "linux" &&
    !sameProcessIdentity(await readLinuxProcessIdentity(claim.pid), claim.processIdentity)
  ) {
    await removeRecoveryClaimIfOwned(path, claim.token);
    return false;
  }
  return true;
}

async function removeStaleMalformedRecoveryClaim(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs <= RECOVERY_CLAIM_GRACE_MS) return false;
    await unlink(path).catch(ignoreMissing);
    return true;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

async function removeDeadOwnerLease(path: string, owner: SessionLeaseOwner): Promise<boolean> {
  const claim = await acquireRecoveryClaim(path, owner);
  if (!claim) return false;
  try {
    if (await ownerIsAlive(owner)) return false;
    return removeRecoveredLease(path, owner);
  } finally {
    await releaseRecoveryClaim(claim);
  }
}

async function removeRecoveredLease(path: string, owner: SessionLeaseOwner): Promise<boolean> {
  const current = await readLeaseOwner(path);
  if (!sameRecoveryOwner(current, owner)) return false;
  await unlink(path).catch(ignoreMissing);
  return true;
}

function sameRecoveryOwner(left: SessionLeaseOwner | undefined, right: SessionLeaseSuccessor): boolean {
  if (left?.token !== right.token) return false;
  if (!left.processIdentity || !right.processIdentity) {
    return left.processIdentity === undefined && right.processIdentity === undefined;
  }
  return sameProcessIdentity(left.processIdentity, right.processIdentity);
}

function requireRecoverableIdentity(owner: SessionLeaseOwner): LinuxProcessIdentity {
  if (
    process.platform !== "linux" ||
    owner.hostname !== hostname() ||
    owner.schemaVersion !== 2 ||
    !owner.processIdentity
  ) {
    throw new Error("Session owner 缺少可验证的同主机 Linux 进程身份，拒绝强制恢复");
  }
  if (typeof process.getuid !== "function" || owner.processIdentity.uid !== process.getuid()) {
    throw new Error("Session owner UID 与当前用户不一致，拒绝发送信号");
  }
  return owner.processIdentity;
}

async function currentLinuxProcessIdentity(): Promise<LinuxProcessIdentity | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return await readLinuxProcessIdentity(process.pid);
  } catch {
    return undefined;
  }
}

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const [bootIdRaw, statRaw, statusRaw] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
    ]);
    const closing = statRaw.lastIndexOf(")");
    if (closing < 0) return undefined;
    const fields = statRaw
      .slice(closing + 2)
      .trim()
      .split(/\s+/u);
    const startTimeTicks = fields[19];
    const uidMatch = /^Uid:\s+(\d+)/mu.exec(statusRaw);
    const uid = Number(uidMatch?.[1]);
    const bootId = bootIdRaw.trim();
    if (!startTimeTicks || !/^\d+$/u.test(startTimeTicks) || !Number.isSafeInteger(uid) || uid < 0 || !bootId)
      return undefined;
    return { kind: "linux-proc", bootId, startTimeTicks, uid };
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return undefined;
    throw error;
  }
}

function sameProcessIdentity(left: LinuxProcessIdentity | undefined, right: LinuxProcessIdentity | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.kind === right.kind &&
    left.bootId === right.bootId &&
    left.startTimeTicks === right.startTimeTicks &&
    left.uid === right.uid
  );
}

function parseTakeoverRequest(
  input: string,
  sessionPath: string,
  directory: string,
): { token: string; successor: SessionLeaseSuccessor } | undefined {
  try {
    const parsed = JSON.parse(input) as { type?: unknown; token?: unknown; successor?: unknown };
    if (parsed.type !== "takeover" || typeof parsed.token !== "string" || !isStoredOwner(parsed.successor)) {
      return undefined;
    }
    const successor = parsed.successor;
    if (successor.sessionPath !== sessionPath || !sessionSocketNamespaceMatches(successor.socketPath, directory)) {
      return undefined;
    }
    return { token: parsed.token, successor };
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
  private commandHandler: ((command: SessionHandoffCommand) => Promise<unknown>) | undefined;

  constructor(
    private readonly socket: Socket,
    readonly successor: SessionLeaseSuccessor,
  ) {
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

  project(projection: SessionHandoffProjection): void {
    writeControl(this.socket, { type: "projection", projection });
  }

  setCommandHandler(handler: (command: SessionHandoffCommand) => Promise<unknown>): void {
    this.commandHandler = handler;
  }

  handle(line: string): void {
    const response = parseInteractionResponse(line);
    if (response) {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error ?? "Session handoff interaction failed"));
      return;
    }
    const request = parseCommandRequest(line);
    if (!request) {
      this.close(new Error("Session handoff response is invalid"));
      return;
    }
    const operation = this.commandHandler
      ? this.commandHandler(request.command)
      : Promise.reject(new Error("Session handoff command handler is unavailable"));
    void operation.then(
      (value) => writeControl(this.socket, { type: "command_response", id: request.id, ok: true, value }),
      (error: unknown) =>
        writeControl(this.socket, {
          type: "command_response",
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : "Session handoff command failed",
        }),
    );
  }

  close(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.resolveClosed();
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

class SocketHandoffClient implements SessionHandoffClient {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolvePromise) => {
    this.resolveClosed = resolvePromise;
  });
  private sequence = 0;

  constructor(private readonly socket: Socket) {}

  command(command: SessionHandoffCommand): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new Error("Session handoff channel is unavailable"));
    const id = `${process.pid}-command-${++this.sequence}`;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      writeControl(this.socket, { type: "command", id, command });
    });
  }

  handle(line: string): boolean {
    const response = parseCommandResponse(line);
    if (!response) return false;
    const pending = this.pending.get(response.id);
    if (!pending) return true;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error ?? "Session handoff command failed"));
    return true;
  }

  close(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.resolveClosed();
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

function parseProjection(line: string): SessionHandoffProjection | undefined {
  try {
    const value = JSON.parse(line) as { type?: unknown; projection?: unknown };
    if (value.type !== "projection" || !isProjection(value.projection)) return undefined;
    return value.projection;
  } catch {
    return undefined;
  }
}

function parseCommandRequest(line: string): { id: string; command: SessionHandoffCommand } | undefined {
  try {
    const value = JSON.parse(line) as { type?: unknown; id?: unknown; command?: unknown };
    if (value.type !== "command" || typeof value.id !== "string" || !isCommand(value.command)) return undefined;
    return { id: value.id, command: value.command };
  } catch {
    return undefined;
  }
}

function parseCommandResponse(line: string): { id: string; ok: boolean; value?: unknown; error?: string } | undefined {
  try {
    const value = JSON.parse(line) as { type?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    if (value.type !== "command_response" || typeof value.id !== "string" || typeof value.ok !== "boolean") {
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

function isProjection(value: unknown): value is SessionHandoffProjection {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

function isCommand(value: unknown): value is SessionHandoffCommand {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    (value.kind === "interrupt" || value.kind === "enqueue")
  );
}

function writeControl(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function isStoredOwner(value: unknown): value is StoredLeaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<StoredLeaseOwner>;
  return (
    (owner.schemaVersion === 1 || owner.schemaVersion === 2) &&
    Number.isInteger(owner.pid) &&
    (owner.pid ?? 0) > 0 &&
    typeof owner.hostname === "string" &&
    typeof owner.startedAt === "string" &&
    typeof owner.sessionPath === "string" &&
    typeof owner.socketPath === "string" &&
    typeof owner.token === "string" &&
    (owner.schemaVersion === 1 || isLinuxProcessIdentity(owner.processIdentity))
  );
}

function isLinuxProcessIdentity(value: unknown): value is LinuxProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Partial<LinuxProcessIdentity>;
  return (
    identity.kind === "linux-proc" &&
    typeof identity.bootId === "string" &&
    typeof identity.startTimeTicks === "string" &&
    Number.isSafeInteger(identity.uid) &&
    (identity.uid ?? -1) >= 0
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

export function sessionSocketPath(
  directory: string,
  identity: string,
  pid: number,
  token: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const suffix = `${identity}-${pid}-${token.slice(0, 8)}`;
  return platform === "win32" ? `${WINDOWS_PIPE_PREFIX}${suffix}` : join(directory, `${suffix}.sock`);
}

export function sessionSocketNamespaceMatches(
  socketPath: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    ? socketPath.startsWith(WINDOWS_PIPE_PREFIX)
    : dirname(resolve(socketPath)) === resolve(directory);
}

async function removeSocketFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  await unlink(path).catch(ignoreMissing);
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
