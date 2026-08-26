import { mkdir, mkdtemp, unlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSessionLease,
  killUnresponsiveSessionOwner,
  readSessionLease,
  type SessionHandoffChannel,
  type SessionLease,
  SessionLeaseUnresponsiveError,
  sessionSocketNamespaceMatches,
  sessionSocketPath,
  terminateUnresponsiveSessionOwner,
} from "../src/sessions/lease.js";

describe("session socket path", () => {
  it("uses a named pipe on Windows instead of a filesystem socket path", () => {
    const directory = "C:\\Users\\hyx02\\.pi\\agent\\session-leases";
    expect(sessionSocketPath(directory, "abc123", 12345, "token1234", "win32")).toBe(
      "\\\\.\\pipe\\vspi-session-abc123-12345-token123",
    );
    expect(sessionSocketPath("/home/user/.pi/agent/session-leases", "abc123", 12345, "token1234", "linux")).toBe(
      "/home/user/.pi/agent/session-leases/abc123-12345-token123.sock",
    );
  });

  it("accepts only the Windows pipe namespace on Windows", () => {
    expect(
      sessionSocketNamespaceMatches("\\\\.\\pipe\\vspi-session-abc123-12345-token1234", "C:\\leases", "win32"),
    ).toBe(true);
    expect(sessionSocketNamespaceMatches("C:\\leases\\abc123-12345-token1234.sock", "C:\\leases", "win32")).toBe(false);
    expect(sessionSocketNamespaceMatches("\\\\.\\pipe\\other-abc123-12345-token1234", "C:\\leases", "win32")).toBe(
      false,
    );
  });

  it("accepts only sockets inside the lease directory on POSIX", () => {
    const directory = "/home/user/.pi/agent/session-leases";
    expect(sessionSocketNamespaceMatches(`${directory}/abc123-12345-token1234.sock`, directory, "linux")).toBe(true);
    expect(sessionSocketNamespaceMatches("/tmp/outside/abc123-12345-token1234.sock", directory, "linux")).toBe(false);
    expect(sessionSocketNamespaceMatches("\\\\.\\pipe\\vspi-session-abc123-12345-token1234", directory, "linux")).toBe(
      false,
    );
  });
});

describe("session owner lease", () => {
  it.runIf(process.platform === "linux")("records a Linux kernel process identity in new leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-identity-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"identity-test"}\n');
    const acquired = await acquireSessionLease(sessionFile, { agentDir, onTakeover: vi.fn() });

    expect(acquired.lease.owner).toMatchObject({
      schemaVersion: 2,
      processIdentity: {
        kind: "linux-proc",
        bootId: expect.stringMatching(/^[0-9a-f-]+$/u),
        startTimeTicks: expect.stringMatching(/^\d+$/u),
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      },
    });
    await acquired.lease.release();
  });

  it("hands the same Session to a waiting owner only after the current owner releases it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-lease-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"lease-test"}\n');
    let firstLease: SessionLease | undefined;
    let takeoverRequestedAt = 0;
    let releasedAt = 0;
    firstLease = (
      await acquireSessionLease(sessionFile, {
        agentDir,
        onTakeover: async () => {
          takeoverRequestedAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 30));
          await firstLease?.release();
          releasedAt = Date.now();
        },
      })
    ).lease;

    const onWait = vi.fn();
    const second = await acquireSessionLease(sessionFile, {
      agentDir,
      onWait,
      onTakeover: vi.fn(),
    });

    expect(second.waited).toBe(true);
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ sessionPath: sessionFile, pid: process.pid }));
    expect(takeoverRequestedAt).toBeGreaterThan(0);
    expect(releasedAt).toBeGreaterThanOrEqual(takeoverRequestedAt);
    expect((await readSessionLease(sessionFile, agentDir))?.token).toBe(second.lease.owner.token);
    await second.lease.release();
    expect(await readSessionLease(sessionFile, agentDir)).toBeUndefined();
  });

  it("atomically assigns the lease to the accepted successor instead of reopening a lock race", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-transfer-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"transfer-test"}\n');
    let firstLease: SessionLease | undefined;
    let assignedToken: string | undefined;
    firstLease = (
      await acquireSessionLease(sessionFile, {
        agentDir,
        onTakeover: async (channel) => {
          await firstLease?.transfer(channel.successor);
          assignedToken = (await readSessionLease(sessionFile, agentDir))?.token;
          await firstLease?.release();
        },
      })
    ).lease;

    const second = await acquireSessionLease(sessionFile, {
      agentDir,
      onTakeover: vi.fn(),
    });

    expect(assignedToken).toBe(second.lease.owner.token);
    expect((await readSessionLease(sessionFile, agentDir))?.token).toBe(second.lease.owner.token);
    await second.lease.release();
  });

  it("relays a pending interaction to the accepted waiting owner before releasing the Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-relay-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"relay-test"}\n');
    const interaction = {
      kind: "question" as const,
      payload: [{ id: "choice", title: "Choose", prompt: "Continue?", kind: "singleChoice" }],
    };
    const answer = [{ ...interaction.payload[0], answer: "yes" }];
    let firstLease: SessionLease | undefined;
    let relayResult: unknown;
    firstLease = (
      await acquireSessionLease(sessionFile, {
        agentDir,
        onTakeover: async (channel: SessionHandoffChannel) => {
          relayResult = await channel.request(interaction);
          await firstLease?.release();
        },
      })
    ).lease;

    const onInteraction = vi.fn(async (received) => {
      expect(received).toEqual(interaction);
      return { kind: "question", questions: answer };
    });
    const second = await acquireSessionLease(sessionFile, {
      agentDir,
      onInteraction,
      onTakeover: vi.fn(),
    });

    expect(onInteraction).toHaveBeenCalledOnce();
    expect(relayResult).toEqual({ kind: "question", questions: answer });
    expect(second.waited).toBe(true);
    await second.lease.release();
  });

  it("rejects the old owner's pending relay when the waiting owner disconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-relay-disconnect-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"relay-disconnect-test"}\n');
    let relayError: Error | undefined;
    let interactionStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      interactionStarted = resolvePromise;
    });
    const firstLease = (
      await acquireSessionLease(sessionFile, {
        agentDir,
        onTakeover: async (channel) => {
          try {
            await channel.request({ kind: "approval", payload: { command: "rm file" } });
          } catch (error) {
            relayError = error instanceof Error ? error : new Error("unknown relay error");
          }
        },
      })
    ).lease;
    const controller = new AbortController();
    const waiting = acquireSessionLease(sessionFile, {
      agentDir,
      signal: controller.signal,
      onTakeover: vi.fn(),
      onInteraction: async () => {
        interactionStarted();
        await new Promise(() => {});
      },
    });

    await started;
    controller.abort();
    await expect(waiting).rejects.toThrow("Session 接管已取消");
    await waitUntil(() => relayError !== undefined);
    expect(relayError?.message).toContain("channel");
    expect((await readSessionLease(sessionFile, agentDir))?.token).toBe(firstLease.owner.token);
    await firstLease.release();
  });

  it("allows only one waiting owner to answer the active owner's interaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-single-relay-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"single-relay-test"}\n');
    let activeLease: SessionLease | undefined;
    let relayedAnswer: unknown;
    activeLease = (
      await acquireSessionLease(sessionFile, {
        agentDir,
        onTakeover: async (channel) => {
          relayedAnswer = await channel.request({ kind: "question", payload: { id: "only-one" } });
          await activeLease?.transfer(channel.successor);
          await activeLease?.release();
        },
      })
    ).lease;

    const firstInteraction = vi.fn(async () => ({ answeredBy: "first" }));
    const secondInteraction = vi.fn(async () => ({ answeredBy: "second" }));
    let firstLease: SessionLease | undefined;
    let secondLease: SessionLease | undefined;
    const first = acquireSessionLease(sessionFile, {
      agentDir,
      onInteraction: firstInteraction,
      onTakeover: async (channel) => {
        await waitUntil(() => firstLease !== undefined);
        await firstLease?.transfer(channel.successor);
        await firstLease?.release();
      },
    }).then((acquired) => {
      firstLease = acquired.lease;
      return acquired;
    });
    const second = acquireSessionLease(sessionFile, {
      agentDir,
      onInteraction: secondInteraction,
      onTakeover: async (channel) => {
        await waitUntil(() => secondLease !== undefined);
        await secondLease?.transfer(channel.successor);
        await secondLease?.release();
      },
    }).then((acquired) => {
      secondLease = acquired.lease;
      return acquired;
    });

    const acquired = await Promise.all([first, second]);
    expect(firstInteraction.mock.calls.length + secondInteraction.mock.calls.length).toBe(1);
    expect(relayedAnswer).toEqual(
      firstInteraction.mock.calls.length === 1 ? { answeredBy: "first" } : { answeredBy: "second" },
    );
    const finalOwner = await readSessionLease(sessionFile, agentDir);
    expect([acquired[0].lease.owner.token, acquired[1].lease.owner.token]).toContain(finalOwner?.token);
    await acquired[0].lease.release();
    await acquired[1].lease.release();
  });

  it("reclaims a stale same-host lease without contacting its missing socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-stale-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(join(agentDir, "session-leases"), { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"stale-test"}\n');
    const probe = await acquireSessionLease(sessionFile, { agentDir, onTakeover: vi.fn() });
    const leasePath = probe.lease.leasePath;
    await probe.lease.release();
    await writeFile(
      leasePath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        hostname: probe.lease.owner.hostname,
        startedAt: new Date(0).toISOString(),
        sessionPath: sessionFile,
        socketPath: join(root, "missing.sock"),
        token: "stale-token",
      })}\n`,
      { mode: 0o600 },
    );

    const acquired = await acquireSessionLease(sessionFile, { agentDir, onTakeover: vi.fn() });
    expect(acquired.waited).toBe(false);
    expect(acquired.lease.owner.token).not.toBe("stale-token");
    await acquired.lease.release();
  });

  it.runIf(process.platform === "linux")("returns a typed error with the owner when handoff times out", async () => {
    const fixture = await createRecoveryFixture("timeout");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolvePromise) => server.listen(fixture.socketPath, resolvePromise));
    const waiting = acquireSessionLease(fixture.sessionFile, { agentDir: fixture.agentDir, onTakeover: vi.fn() });

    await expect(waiting).rejects.toMatchObject({
      name: "SessionLeaseUnresponsiveError",
      owner: expect.objectContaining({ token: fixture.owner.token, processIdentity: fixture.owner.processIdentity }),
    });
    await expect(waiting).rejects.toBeInstanceOf(SessionLeaseUnresponsiveError);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it.runIf(process.platform === "linux")("retries acquisition after explicit owner recovery", async () => {
    const fixture = await createRecoveryFixture("callback");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolvePromise) => server.listen(fixture.socketPath, resolvePromise));
    const recovered = vi.fn(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await unlink(fixture.leasePath);
    });

    const acquired = await acquireSessionLease(fixture.sessionFile, {
      agentDir: fixture.agentDir,
      onTakeover: vi.fn(),
      onUnresponsiveOwner: recovered,
    });

    expect(recovered).toHaveBeenCalledOnce();
    expect(acquired.waited).toBe(true);
    expect(acquired.lease.owner.token).not.toBe(fixture.owner.token);
    await acquired.lease.release();
  });

  it.runIf(process.platform === "linux")(
    "recovers when an accepted handoff stops heartbeating without closing its socket",
    async () => {
      const fixture = await createRecoveryFixture("accepted-frozen");
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.once("data", () => socket.write(`${JSON.stringify({ status: "accepted" })}\n`));
      });
      await new Promise<void>((resolvePromise) => server.listen(fixture.socketPath, resolvePromise));
      const stale = new Date(Date.now() - 60_000);
      await utimes(fixture.leasePath, stale, stale);
      const recovered = vi.fn(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        await unlink(fixture.leasePath);
      });

      const acquired = await acquireSessionLease(fixture.sessionFile, {
        agentDir: fixture.agentDir,
        onTakeover: vi.fn(),
        onUnresponsiveOwner: recovered,
      });

      expect(recovered).toHaveBeenCalledWith(
        expect.objectContaining({ token: fixture.owner.token, heartbeatAt: stale.toISOString() }),
      );
      expect(acquired.waited).toBe(true);
      expect(acquired.lease.owner.token).not.toBe(fixture.owner.token);
      await acquired.lease.release();
    },
  );

  it.runIf(process.platform === "linux")("fails closed when an old-schema owner cannot be identified", async () => {
    const fixture = await createRecoveryFixture("legacy");
    const { processIdentity: _processIdentity, ...legacyOwner } = fixture.owner;
    const legacy = { ...legacyOwner, schemaVersion: 1 as const };
    await writeFile(fixture.leasePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const signal = vi.spyOn(process, "kill");
    await expect(terminateUnresponsiveSessionOwner(fixture.sessionFile, fixture.agentDir, legacy, 0)).rejects.toThrow(
      "缺少可验证",
    );
    expect(signal).not.toHaveBeenCalled();
    signal.mockRestore();
  });

  it.runIf(process.platform === "linux")(
    "removes a PID-reused lease without signalling the unrelated process",
    async () => {
      const fixture = await createRecoveryFixture("pid-reuse");
      const processIdentity = fixture.owner.processIdentity;
      if (!processIdentity) throw new Error("Linux process identity fixture is missing");
      const stale = {
        ...fixture.owner,
        processIdentity: {
          ...processIdentity,
          startTimeTicks: `${BigInt(processIdentity.startTimeTicks) + 1n}`,
        },
      };
      await writeFile(fixture.leasePath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
      const signal = vi.spyOn(process, "kill");

      await expect(terminateUnresponsiveSessionOwner(fixture.sessionFile, fixture.agentDir, stale, 0)).resolves.toBe(
        "released",
      );
      expect(signal).not.toHaveBeenCalled();
      expect(await readSessionLease(fixture.sessionFile, fixture.agentDir)).toBeUndefined();
      signal.mockRestore();
    },
  );

  it.runIf(process.platform === "linux")(
    "reports still-running after explicit TERM or KILL without stealing the lease",
    async () => {
      for (const [operation, expectedSignal] of [
        [terminateUnresponsiveSessionOwner, "SIGTERM"],
        [killUnresponsiveSessionOwner, "SIGKILL"],
      ] as const) {
        const fixture = await createRecoveryFixture(expectedSignal.toLowerCase());
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        await expect(operation(fixture.sessionFile, fixture.agentDir, fixture.owner, 0)).resolves.toBe("still-running");
        expect(signal).toHaveBeenCalledWith(process.pid, expectedSignal);
        expect((await readSessionLease(fixture.sessionFile, fixture.agentDir))?.token).toBe(fixture.owner.token);
        signal.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")("serializes recovery attempts with an exclusive claim", async () => {
    const fixture = await createRecoveryFixture("claim");
    await writeFile(`${fixture.leasePath}.recovery`, '{"token":"other"}\n', { mode: 0o600 });
    const signal = vi.spyOn(process, "kill");

    await expect(
      terminateUnresponsiveSessionOwner(fixture.sessionFile, fixture.agentDir, fixture.owner, 0),
    ).rejects.toThrow("另一个进程正在恢复");
    expect(signal).not.toHaveBeenCalled();
    expect((await readSessionLease(fixture.sessionFile, fixture.agentDir))?.token).toBe(fixture.owner.token);
    signal.mockRestore();
  });

  it.runIf(process.platform === "linux")("reclaims a recovery claim whose identified process has exited", async () => {
    const fixture = await createRecoveryFixture("stale-claim");
    const processIdentity = fixture.owner.processIdentity;
    if (!processIdentity) throw new Error("Linux process identity fixture is missing");
    await writeFile(
      `${fixture.leasePath}.recovery`,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "stale-claim-token",
        ownerToken: fixture.owner.token,
        pid: 2_147_483_647,
        processIdentity,
      })}\n`,
      { mode: 0o600 },
    );
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(
      terminateUnresponsiveSessionOwner(fixture.sessionFile, fixture.agentDir, fixture.owner, 0),
    ).resolves.toBe("still-running");
    expect(signal).toHaveBeenCalledWith(process.pid, "SIGTERM");
    signal.mockRestore();
  });

  it("cancels a waiting owner without disturbing the active owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-cancel-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"cancel-test"}\n');
    const active = await acquireSessionLease(sessionFile, {
      agentDir,
      onTakeover: () => {},
    });
    const controller = new AbortController();
    const waiting = acquireSessionLease(sessionFile, {
      agentDir,
      signal: controller.signal,
      onWait: () => controller.abort(),
      onTakeover: vi.fn(),
    });

    await expect(waiting).rejects.toThrow("Session 接管已取消");
    expect((await readSessionLease(sessionFile, agentDir))?.token).toBe(active.lease.owner.token);
    await active.lease.release();
  });

  it("serializes three terminals through atomic ownership transfers without a missing lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-owner-change-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"owner-change-test"}\n');
    let firstLease: SessionLease | undefined;
    firstLease = (
      await acquireSessionLease(sessionFile, {
        agentDir,
        onTakeover: async (channel) => {
          await firstLease?.transfer(channel.successor);
          await firstLease?.release();
        },
      })
    ).lease;

    const ownerTokens: string[] = [];
    let leaseMissing = false;
    let monitorLease = true;
    const monitor = (async () => {
      while (monitorLease) {
        if (!(await readSessionLease(sessionFile, agentDir))) leaseMissing = true;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      }
    })();
    let secondLease: SessionLease | undefined;
    const second = acquireSessionLease(sessionFile, {
      agentDir,
      onWait: (owner) => ownerTokens.push(owner.token),
      onTakeover: async (channel) => {
        await waitUntil(() => secondLease !== undefined);
        await secondLease?.transfer(channel.successor);
        await secondLease?.release();
      },
    }).then((acquired) => {
      secondLease = acquired.lease;
      return acquired;
    });
    let thirdLease: SessionLease | undefined;
    const third = acquireSessionLease(sessionFile, {
      agentDir,
      onWait: (owner) => ownerTokens.push(owner.token),
      onTakeover: async (channel) => {
        await waitUntil(() => thirdLease !== undefined);
        await thirdLease?.transfer(channel.successor);
        await thirdLease?.release();
      },
    }).then((acquired) => {
      thirdLease = acquired.lease;
      return acquired;
    });

    const [secondAcquired, thirdAcquired] = await Promise.all([second, third]);
    monitorLease = false;
    await monitor;
    expect(secondAcquired.waited).toBe(true);
    expect(thirdAcquired.waited).toBe(true);
    expect(new Set(ownerTokens).size).toBe(2);
    expect(leaseMissing).toBe(false);
    const finalOwner = await readSessionLease(sessionFile, agentDir);
    expect([secondAcquired.lease.owner.token, thirdAcquired.lease.owner.token]).toContain(finalOwner?.token);
    await secondAcquired.lease.release();
    await thirdAcquired.lease.release();
  });
});

async function createRecoveryFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `vspi-r-${name}-`));
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, `{"type":"session","version":3,"id":"${name}"}\n`);
  const acquired = await acquireSessionLease(sessionFile, { agentDir, onTakeover: vi.fn() });
  const { leasePath, owner } = acquired.lease;
  await acquired.lease.release();
  const socketPath = join(agentDir, "session-leases", `${name}.sock`);
  const stored = { ...owner, socketPath };
  await writeFile(leasePath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  return { agentDir, sessionFile, leasePath, socketPath, owner: stored };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for session relay state");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
