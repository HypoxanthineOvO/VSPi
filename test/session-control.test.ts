import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readSessionControlDescriptor,
  SessionControlClient,
  type SessionControlEvent,
  type SessionControlServer,
  sessionControlSocketPath,
  startSessionControlServer,
} from "../src/sessions/control.js";

describe("Session control path", () => {
  it("uses an isolated named pipe namespace on Windows", () => {
    expect(sessionControlSocketPath("C:\\agent\\session-controls", "abc", 42, "0123456789abcdef", "win32")).toBe(
      "\\\\.\\pipe\\vspi-control-abc-42-0123456789ab",
    );
    expect(sessionControlSocketPath("/agent/session-controls", "abc", 42, "0123456789abcdef", "linux")).toBe(
      "/agent/session-controls/abc-42-0123456789ab.sock",
    );
  });
});

describe("Session control protocol", () => {
  it("serves multiple clients without transferring Session ownership", async () => {
    const fixture = await createFixture();
    const first = await SessionControlClient.connect(fixture.server.descriptor);
    const second = await SessionControlClient.connect(fixture.server.descriptor);
    try {
      expect(await first.status()).toEqual({ busy: false });
      expect(await second.snapshot()).toEqual({ messages: ["ready"] });
      expect(await first.wait({ turnId: "turn-1" })).toEqual({ turnId: "turn-1", status: "completed" });
      expect(await readSessionControlDescriptor(fixture.sessionFile, fixture.agentDir)).toEqual(
        fixture.server.descriptor,
      );
      expect(fixture.handlers.status).toHaveBeenCalledOnce();
      expect(fixture.handlers.snapshot).toHaveBeenCalledOnce();
    } finally {
      first.close();
      second.close();
      await fixture.server.close();
    }
  });

  it("rejects a bad capability token", async () => {
    const fixture = await createFixture();
    try {
      await expect(SessionControlClient.connect(fixture.server.descriptor, { token: "0".repeat(64) })).rejects.toThrow(
        "authentication failed",
      );
      expect(fixture.handlers.status).not.toHaveBeenCalled();
    } finally {
      await fixture.server.close();
    }
  });

  it("deduplicates concurrent and repeated sends by idempotency key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const fixture = await createFixture({
      send: vi.fn(async (payload: unknown) => {
        await gate;
        return { accepted: payload };
      }),
    });
    const first = await SessionControlClient.connect(fixture.server.descriptor);
    const second = await SessionControlClient.connect(fixture.server.descriptor);
    try {
      const left = first.send({ text: "fix it" }, "message-1");
      const right = second.send({ text: "fix it" }, "message-1");
      await waitUntil(() => fixture.handlers.send.mock.calls.length === 1);
      release();
      await expect(Promise.all([left, right])).resolves.toEqual([
        { accepted: { text: "fix it" } },
        { accepted: { text: "fix it" } },
      ]);
      await expect(first.send({ text: "different" }, "message-1")).rejects.toThrow("different payload");
      expect(fixture.handlers.send).toHaveBeenCalledOnce();
    } finally {
      first.close();
      second.close();
      await fixture.server.close();
    }
  });

  it("replays retained events after reconnecting from a sequence cursor", async () => {
    const fixture = await createFixture();
    fixture.server.publish("turn.started", { id: "one" });
    fixture.server.publish("turn.delta", { text: "two" });
    fixture.server.publish("turn.completed", { id: "one" });
    const firstEvents: SessionControlEvent[] = [];
    const first = await SessionControlClient.connect(fixture.server.descriptor);
    try {
      await first.subscribe(1, (event) => firstEvents.push(event));
      await waitUntil(() => firstEvents.length === 2);
      expect(firstEvents.map((event) => event.sequence)).toEqual([2, 3]);
    } finally {
      first.close();
      await first.closed;
    }

    fixture.server.publish("turn.started", { id: "two" });
    const resumedEvents: SessionControlEvent[] = [];
    const resumed = await SessionControlClient.connect(fixture.server.descriptor);
    try {
      await resumed.subscribe(3, (event) => resumedEvents.push(event));
      await waitUntil(() => resumedEvents.length === 1);
      expect(resumedEvents[0]).toMatchObject({ sequence: 4, kind: "turn.started", payload: { id: "two" } });
    } finally {
      resumed.close();
      await fixture.server.close();
    }
  });

  it("closes an unauthenticated connection that exceeds the line budget", async () => {
    const fixture = await createFixture({}, { maxLineBytes: 128 });
    const socket = createConnection(fixture.server.descriptor.socketPath);
    try {
      await new Promise<void>((resolvePromise) => socket.once("connect", resolvePromise));
      const closed = onceClosed(socket);
      socket.write("x".repeat(256));
      await closed;
      expect(fixture.handlers.status).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await fixture.server.close();
    }
  });

  it("accepts multiple bounded JSONL messages delivered in one chunk", async () => {
    const fixture = await createFixture({}, { maxLineBytes: 160, maxClientQueueBytes: 2_048 });
    const socket = createConnection(fixture.server.descriptor.socketPath);
    socket.setEncoding("utf8");
    try {
      await new Promise<void>((resolvePromise) => socket.once("connect", resolvePromise));
      const responses = new Promise<string>((resolvePromise) => {
        let input = "";
        socket.on("data", (chunk) => {
          input += String(chunk);
          if (input.includes('"id":"two"')) resolvePromise(input);
        });
      });
      socket.write(
        `${JSON.stringify({ type: "hello", version: 1, token: fixture.server.descriptor.token })}\n${JSON.stringify({
          type: "request",
          id: "one",
          method: "status",
        })}\n${JSON.stringify({ type: "request", id: "two", method: "snapshot" })}\n`,
      );
      await expect(responses).resolves.toContain('"id":"two"');
      expect(fixture.handlers.status).toHaveBeenCalledOnce();
      expect(fixture.handlers.snapshot).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
      await fixture.server.close();
    }
  });

  it("disconnects only the subscriber whose outbound event exceeds its bounded queue", async () => {
    const fixture = await createFixture({}, { maxLineBytes: 2_048, maxClientQueueBytes: 256 });
    const slow = await openRawSubscriber(fixture.server);
    const healthy = await SessionControlClient.connect(fixture.server.descriptor);
    try {
      expect(await healthy.status()).toEqual({ busy: false });
      const closed = onceClosed(slow);
      fixture.server.publish("turn.delta", { text: "x".repeat(512) });
      await closed;
      expect(await healthy.status()).toEqual({ busy: false });
    } finally {
      slow.destroy();
      healthy.close();
      await fixture.server.close();
    }
  });

  it.runIf(process.platform !== "win32")("creates private descriptor, directory, and socket permissions", async () => {
    const fixture = await createFixture();
    try {
      expect((await stat(dirname(fixture.server.descriptorPath))).mode & 0o777).toBe(0o700);
      expect((await stat(fixture.server.descriptorPath)).mode & 0o777).toBe(0o600);
      expect((await stat(fixture.server.descriptor.socketPath)).mode & 0o777).toBe(0o600);
    } finally {
      await fixture.server.close();
      expect(await readSessionControlDescriptor(fixture.sessionFile, fixture.agentDir)).toBeUndefined();
    }
  });
});

async function createFixture(
  handlerOverrides: Partial<{
    status: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    wait: ReturnType<typeof vi.fn>;
  }> = {},
  serverOverrides: Partial<{
    eventCapacity: number;
    idempotencyCapacity: number;
    maxLineBytes: number;
    maxClientQueueBytes: number;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "vspi-session-control-"));
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, '{"type":"session","version":3,"id":"control-test"}\n');
  const handlers = {
    status: handlerOverrides.status ?? vi.fn(() => ({ busy: false })),
    snapshot: handlerOverrides.snapshot ?? vi.fn(() => ({ messages: ["ready"] })),
    send: handlerOverrides.send ?? vi.fn(async (payload: unknown) => ({ accepted: payload })),
    wait:
      handlerOverrides.wait ??
      vi.fn(async (payload: unknown) => ({ ...(payload as Record<string, unknown>), status: "completed" })),
  };
  const server = await startSessionControlServer({ agentDir, sessionFile, handlers, ...serverOverrides });
  return { agentDir, sessionFile, handlers, server };
}

async function openRawSubscriber(server: SessionControlServer): Promise<Socket> {
  const socket = createConnection(server.descriptor.socketPath);
  socket.setEncoding("utf8");
  await new Promise<void>((resolvePromise) => socket.once("connect", resolvePromise));
  socket.write(
    `${JSON.stringify({ type: "hello", version: 1, token: server.descriptor.token })}\n${JSON.stringify({
      type: "request",
      id: "subscribe",
      method: "subscribe",
      params: { afterSequence: 0 },
    })}\n`,
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let input = "";
    const timer = setTimeout(() => rejectPromise(new Error("raw subscriber did not authenticate")), 1_000);
    socket.on("data", (chunk) => {
      input += String(chunk);
      if (!input.includes('"id":"subscribe"')) return;
      clearTimeout(timer);
      resolvePromise();
    });
  });
  return socket;
}

function onceClosed(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolvePromise) => socket.once("close", () => resolvePromise()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
