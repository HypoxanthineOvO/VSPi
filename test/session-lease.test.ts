import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSessionLease,
  readSessionLease,
  type SessionHandoffChannel,
  type SessionLease,
} from "../src/sessions/lease.js";

describe("session owner lease", () => {
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for session relay state");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
