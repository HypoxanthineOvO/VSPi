import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";

export const SESSION_CONTROL_VERSION = 1 as const;

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\vspi-control-";
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_CLIENT_QUEUE_BYTES = 1024 * 1024;
const DEFAULT_EVENT_CAPACITY = 512;
const DEFAULT_IDEMPOTENCY_CAPACITY = 512;
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;

export interface SessionControlDescriptor {
  version: typeof SESSION_CONTROL_VERSION;
  sessionPath: string;
  pid: number;
  startedAt: string;
  socketPath: string;
  token: string;
}

export interface SessionControlHandlers {
  status(): Promise<unknown> | unknown;
  snapshot(): Promise<unknown> | unknown;
  send(payload: unknown): Promise<unknown> | unknown;
  wait(payload: unknown): Promise<unknown> | unknown;
}

export interface SessionControlServerOptions {
  agentDir: string;
  sessionFile: string;
  handlers: SessionControlHandlers;
  eventCapacity?: number;
  idempotencyCapacity?: number;
  maxLineBytes?: number;
  maxClientQueueBytes?: number;
}

export interface SessionControlEvent {
  sequence: number;
  timestamp: string;
  kind: string;
  payload?: unknown;
}

export interface SessionControlSubscription {
  readonly closed: Promise<void>;
  close(): void;
}

export interface SessionControlClientOptions {
  token?: string;
  connectTimeoutMs?: number;
  maxLineBytes?: number;
}

interface ControlRequest {
  type: "request";
  id: string;
  method: "status" | "snapshot" | "subscribe" | "send" | "wait";
  params?: unknown;
  idempotencyKey?: string;
}

interface IdempotentSend {
  fingerprint: string;
  promise: Promise<unknown>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class SessionControlServer {
  readonly descriptor: SessionControlDescriptor;
  readonly descriptorPath: string;
  private readonly clients = new Set<ServerClient>();
  private readonly events: SessionControlEvent[] = [];
  private readonly idempotentSends = new Map<string, IdempotentSend>();
  private nextSequence = 1;
  private closed = false;

  private constructor(
    descriptor: SessionControlDescriptor,
    descriptorPath: string,
    private readonly server: Server,
    private readonly handlers: SessionControlHandlers,
    private readonly eventCapacity: number,
    private readonly idempotencyCapacity: number,
    private readonly maxLineBytes: number,
    private readonly maxClientQueueBytes: number,
  ) {
    this.descriptor = descriptor;
    this.descriptorPath = descriptorPath;
  }

  static async start(options: SessionControlServerOptions): Promise<SessionControlServer> {
    const sessionPath = resolve(options.sessionFile);
    const directory = join(resolve(options.agentDir), "session-controls");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const identity = sessionControlIdentity(sessionPath);
    const token = randomBytes(32).toString("hex");
    const socketPath = sessionControlSocketPath(directory, identity, process.pid, token);
    const descriptorPath = join(directory, `${identity}.json`);
    const descriptor: SessionControlDescriptor = {
      version: SESSION_CONTROL_VERSION,
      sessionPath,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      socketPath,
      token,
    };
    let control: SessionControlServer | undefined;
    const server = createServer((socket) => control?.accept(socket));
    try {
      await listen(server, socketPath);
      if (process.platform !== "win32") await chmod(socketPath, 0o600);
      control = new SessionControlServer(
        descriptor,
        descriptorPath,
        server,
        options.handlers,
        positiveInteger(options.eventCapacity, DEFAULT_EVENT_CAPACITY),
        positiveInteger(options.idempotencyCapacity, DEFAULT_IDEMPOTENCY_CAPACITY),
        positiveInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES),
        positiveInteger(options.maxClientQueueBytes, DEFAULT_MAX_CLIENT_QUEUE_BYTES),
      );
      await writeDescriptor(descriptorPath, descriptor);
      return control;
    } catch (error) {
      await closeServer(server);
      await removeSocket(socketPath);
      throw error;
    }
  }

  publish(kind: string, payload?: unknown): SessionControlEvent {
    if (this.closed) throw new Error("Session control server is closed");
    if (!kind) throw new Error("Session control event kind is required");
    const event: SessionControlEvent = {
      sequence: this.nextSequence++,
      timestamp: new Date().toISOString(),
      kind,
      ...(payload !== undefined ? { payload } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.eventCapacity) this.events.shift();
    for (const client of this.clients) client.emit(event);
    return event;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) client.close();
    this.clients.clear();
    await closeServer(this.server);
    await removeDescriptorIfOwned(this.descriptorPath, this.descriptor.token);
    await removeSocket(this.descriptor.socketPath);
  }

  private accept(socket: Socket): void {
    const client = new ServerClient(this, socket, this.maxLineBytes, this.maxClientQueueBytes);
    this.clients.add(client);
    void client.closed.then(() => this.clients.delete(client));
  }

  async handle(client: ServerClient, request: ControlRequest): Promise<void> {
    try {
      switch (request.method) {
        case "status":
          return client.respond(request.id, true, await this.handlers.status());
        case "snapshot":
          return client.respond(request.id, true, await this.handlers.snapshot());
        case "send":
          return client.respond(request.id, true, await this.handleSend(request));
        case "wait":
          return client.respond(request.id, true, await this.handlers.wait(request.params));
        case "subscribe": {
          const afterSequence = parseAfterSequence(request.params);
          const oldestSequence = this.events[0]?.sequence ?? this.nextSequence;
          if (afterSequence < oldestSequence - 1) {
            throw new Error(`Event history starts at sequence ${oldestSequence}`);
          }
          client.respond(request.id, true, {
            afterSequence,
            latestSequence: this.nextSequence - 1,
            oldestSequence,
          });
          for (const event of this.events) {
            if (event.sequence > afterSequence) client.writeEvent(event);
          }
          client.subscribed = true;
          return;
        }
      }
    } catch (error) {
      client.respond(request.id, false, undefined, errorMessage(error));
    }
  }

  private handleSend(request: ControlRequest): Promise<unknown> {
    const key = request.idempotencyKey;
    if (!key || key.length > 256) throw new Error("send requires a valid idempotencyKey");
    const fingerprint = stableFingerprint(request.params);
    const existing = this.idempotentSends.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("idempotencyKey was reused with a different payload");
      return existing.promise;
    }
    const promise = Promise.resolve().then(() => this.handlers.send(request.params));
    this.idempotentSends.set(key, { fingerprint, promise });
    while (this.idempotentSends.size > this.idempotencyCapacity) {
      const oldest = this.idempotentSends.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.idempotentSends.delete(oldest);
    }
    return promise;
  }
}

class ServerClient {
  readonly closed: Promise<void>;
  subscribed = false;
  private authenticated = false;
  private input = "";
  private blocked = false;
  private queuedBytes = 0;
  private readonly queue: string[] = [];
  private resolveClosed!: () => void;

  constructor(
    private readonly owner: SessionControlServer,
    private readonly socket: Socket,
    private readonly maxLineBytes: number,
    private readonly maxQueueBytes: number,
  ) {
    this.closed = new Promise((resolvePromise) => {
      this.resolveClosed = resolvePromise;
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(String(chunk)));
    socket.on("drain", () => this.flush());
    socket.once("error", () => this.close());
    socket.once("close", () => this.resolveClosed());
  }

  emit(event: SessionControlEvent): void {
    if (this.subscribed) this.writeEvent(event);
  }

  writeEvent(event: SessionControlEvent): void {
    this.write({ type: "event", event });
  }

  respond(id: string, ok: boolean, result?: unknown, error?: string): void {
    this.write({
      type: "response",
      id,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  close(): void {
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private receive(chunk: string): void {
    this.input += chunk;
    while (this.input.includes("\n")) {
      const end = this.input.indexOf("\n");
      const line = this.input.slice(0, end);
      this.input = this.input.slice(end + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes || !this.handleLine(line)) {
        this.close();
        return;
      }
    }
    if (Buffer.byteLength(this.input, "utf8") > this.maxLineBytes) this.close();
  }

  private handleLine(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return false;
    }
    if (!this.authenticated) {
      if (!isHello(value) || value.version !== SESSION_CONTROL_VERSION || value.token !== this.owner.descriptor.token) {
        this.write({ type: "hello", version: SESSION_CONTROL_VERSION, status: "rejected" });
        this.socket.end();
        return true;
      }
      this.authenticated = true;
      this.write({
        type: "hello",
        version: SESSION_CONTROL_VERSION,
        status: "accepted",
      });
      return true;
    }
    const request = parseRequest(value);
    if (!request) return false;
    void this.owner.handle(this, request);
    return true;
  }

  private write(value: unknown): void {
    if (this.socket.destroyed) return;
    const encoded = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > this.maxLineBytes || this.socket.writableLength + this.queuedBytes + bytes > this.maxQueueBytes) {
      this.close();
      return;
    }
    if (this.blocked) {
      this.queue.push(encoded);
      this.queuedBytes += bytes;
      return;
    }
    this.blocked = !this.socket.write(encoded);
  }

  private flush(): void {
    this.blocked = false;
    while (!this.blocked && this.queue.length > 0) {
      const encoded = this.queue.shift();
      if (encoded === undefined) return;
      this.queuedBytes -= Buffer.byteLength(encoded, "utf8");
      this.blocked = !this.socket.write(encoded);
    }
  }
}

export class SessionControlClient {
  readonly closed: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Set<(event: SessionControlEvent) => void>();
  private input = "";
  private nextRequestId = 1;
  private resolveClosed!: () => void;
  private closeError: Error | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly maxLineBytes: number,
  ) {
    this.closed = new Promise((resolvePromise) => {
      this.resolveClosed = resolvePromise;
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(String(chunk)));
    socket.once("error", (error) => this.finish(error));
    socket.once("close", () => this.finish(this.closeError ?? new Error("Session control connection closed")));
  }

  static async connect(
    descriptor: SessionControlDescriptor,
    options: SessionControlClientOptions = {},
  ): Promise<SessionControlClient> {
    if (!isDescriptor(descriptor)) throw new Error("Invalid Session control descriptor");
    const socket = createConnection(descriptor.socketPath);
    const client = new SessionControlClient(socket, positiveInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES));
    const timeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("Session control connection timed out")), timeoutMs);
        timer.unref();
        const cleanup = () => clearTimeout(timer);
        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({
              type: "hello",
              version: SESSION_CONTROL_VERSION,
              token: options.token ?? descriptor.token,
            })}\n`,
          );
        });
        client.onceHello = (accepted, error) => {
          cleanup();
          if (accepted) resolvePromise();
          else rejectPromise(error ?? new Error("Session control authentication failed"));
        };
        socket.once("error", (error) => {
          cleanup();
          rejectPromise(error);
        });
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  status(): Promise<unknown> {
    return this.request("status");
  }

  snapshot(): Promise<unknown> {
    return this.request("snapshot");
  }

  send(payload: unknown, idempotencyKey: string): Promise<unknown> {
    return this.request("send", payload, idempotencyKey);
  }

  wait(payload: unknown): Promise<unknown> {
    return this.request("wait", payload);
  }

  async subscribe(
    afterSequence: number,
    onEvent: (event: SessionControlEvent) => void,
  ): Promise<SessionControlSubscription> {
    this.subscriptions.add(onEvent);
    try {
      await this.request("subscribe", { afterSequence });
    } catch (error) {
      this.subscriptions.delete(onEvent);
      throw error;
    }
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    void this.closed.then(resolveClosed);
    return {
      closed,
      close: () => {
        this.subscriptions.delete(onEvent);
        resolveClosed();
      },
    };
  }

  close(): void {
    if (!this.socket.destroyed) this.socket.end();
  }

  private onceHello: ((accepted: boolean, error?: Error) => void) | undefined;

  private request(method: ControlRequest["method"], params?: unknown, idempotencyKey?: string): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new Error("Session control connection is closed"));
    const id = String(this.nextRequestId++);
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      const request: ControlRequest = {
        type: "request",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      };
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  private receive(chunk: string): void {
    this.input += chunk;
    while (this.input.includes("\n")) {
      const end = this.input.indexOf("\n");
      const line = this.input.slice(0, end);
      this.input = this.input.slice(end + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this.socket.destroy(new Error("Session control message is too large"));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.socket.destroy(new Error("Session control response is invalid"));
        return;
      }
      if (isHelloResponse(value)) {
        const callback = this.onceHello;
        this.onceHello = undefined;
        callback?.(value.status === "accepted", new Error("Session control authentication failed"));
        continue;
      }
      if (isResponse(value)) {
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        this.pending.delete(value.id);
        if (value.ok) pending.resolve(value.result);
        else pending.reject(new Error(value.error ?? "Session control request failed"));
        continue;
      }
      if (isEventMessage(value)) {
        for (const subscriber of this.subscriptions) subscriber(value.event);
        continue;
      }
      this.socket.destroy(new Error("Session control response is invalid"));
      return;
    }
    if (Buffer.byteLength(this.input, "utf8") > this.maxLineBytes) {
      this.socket.destroy(new Error("Session control message is too large"));
    }
  }

  private finish(error: Error): void {
    if (this.closeError) return;
    this.closeError = error;
    this.onceHello?.(false, error);
    this.onceHello = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.resolveClosed();
  }
}

export async function startSessionControlServer(options: SessionControlServerOptions): Promise<SessionControlServer> {
  return SessionControlServer.start(options);
}

export async function readSessionControlDescriptor(
  sessionFile: string,
  agentDir: string,
): Promise<SessionControlDescriptor | undefined> {
  const path = sessionControlDescriptorPath(sessionFile, agentDir);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isDescriptor(parsed) ? parsed : undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function sessionControlDescriptorPath(sessionFile: string, agentDir: string): string {
  return join(resolve(agentDir), "session-controls", `${sessionControlIdentity(resolve(sessionFile))}.json`);
}

export function sessionControlSocketPath(
  directory: string,
  identity: string,
  pid: number,
  token: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const suffix = `${identity}-${pid}-${token.slice(0, 12)}`;
  return platform === "win32" ? `${WINDOWS_PIPE_PREFIX}${suffix}` : join(directory, `${suffix}.sock`);
}

function sessionControlIdentity(sessionPath: string): string {
  return createHash("sha256").update(sessionPath).digest("hex").slice(0, 20);
}

async function writeDescriptor(path: string, descriptor: SessionControlDescriptor): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeDescriptorIfOwned(path: string, token: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isDescriptor(parsed) && parsed.token === token) await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
  }
}

function listen(server: Server, path: string): Promise<void> {
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

async function removeSocket(path: string): Promise<void> {
  if (process.platform === "win32") return;
  await unlink(path).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
}

function parseRequest(value: unknown): ControlRequest | undefined {
  if (!isRecord(value) || value.type !== "request" || typeof value.id !== "string" || value.id.length === 0) {
    return undefined;
  }
  if (
    value.method !== "status" &&
    value.method !== "snapshot" &&
    value.method !== "subscribe" &&
    value.method !== "send" &&
    value.method !== "wait"
  ) {
    return undefined;
  }
  if (value.idempotencyKey !== undefined && typeof value.idempotencyKey !== "string") return undefined;
  return {
    type: "request",
    id: value.id,
    method: value.method,
    ...(value.params !== undefined ? { params: value.params } : {}),
    ...(typeof value.idempotencyKey === "string" ? { idempotencyKey: value.idempotencyKey } : {}),
  };
}

function parseAfterSequence(value: unknown): number {
  if (!isRecord(value) || !Number.isSafeInteger(value.afterSequence) || (value.afterSequence as number) < 0) {
    throw new Error("subscribe requires a non-negative afterSequence");
  }
  return value.afterSequence as number;
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function isHello(value: unknown): value is { type: "hello"; version: number; token: string } {
  return (
    isRecord(value) && value.type === "hello" && typeof value.version === "number" && typeof value.token === "string"
  );
}

function isHelloResponse(value: unknown): value is { type: "hello"; version: number; status: string } {
  return (
    isRecord(value) && value.type === "hello" && typeof value.version === "number" && typeof value.status === "string"
  );
}

function isResponse(
  value: unknown,
): value is { type: "response"; id: string; ok: boolean; result?: unknown; error?: string } {
  return (
    isRecord(value) &&
    value.type === "response" &&
    typeof value.id === "string" &&
    typeof value.ok === "boolean" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isEventMessage(value: unknown): value is { type: "event"; event: SessionControlEvent } {
  if (!isRecord(value) || value.type !== "event" || !isRecord(value.event)) return false;
  return (
    Number.isSafeInteger(value.event.sequence) &&
    typeof value.event.timestamp === "string" &&
    typeof value.event.kind === "string"
  );
}

function isDescriptor(value: unknown): value is SessionControlDescriptor {
  return (
    isRecord(value) &&
    value.version === SESSION_CONTROL_VERSION &&
    typeof value.sessionPath === "string" &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.startedAt === "string" &&
    typeof value.socketPath === "string" &&
    typeof value.token === "string" &&
    value.token.length >= 32
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Session control request failed";
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && String(error.code) === code;
}
