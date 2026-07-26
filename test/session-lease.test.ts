import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireSessionLease, readSessionLease, type SessionLease } from "../src/sessions/lease.js";

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

  it("requests handoff again when ownership changes while another terminal is waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-session-owner-change-"));
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(agentDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"owner-change-test"}\n');
    let firstLease: SessionLease | undefined;
    firstLease = (
      await acquireSessionLease(sessionFile, {
        agentDir,
        onTakeover: () => firstLease?.release(),
      })
    ).lease;

    const ownerTokens: string[] = [];
    let secondLease: SessionLease | undefined;
    const second = acquireSessionLease(sessionFile, {
      agentDir,
      onWait: (owner) => ownerTokens.push(owner.token),
      onTakeover: () => secondLease?.release(),
    }).then((acquired) => {
      secondLease = acquired.lease;
      return acquired;
    });
    let thirdLease: SessionLease | undefined;
    const third = acquireSessionLease(sessionFile, {
      agentDir,
      onWait: (owner) => ownerTokens.push(owner.token),
      onTakeover: () => thirdLease?.release(),
    }).then((acquired) => {
      thirdLease = acquired.lease;
      return acquired;
    });

    const [secondAcquired, thirdAcquired] = await Promise.all([second, third]);
    expect(secondAcquired.waited).toBe(true);
    expect(thirdAcquired.waited).toBe(true);
    expect(new Set(ownerTokens).size).toBeGreaterThanOrEqual(2);
    const finalOwner = await readSessionLease(sessionFile, agentDir);
    expect([secondAcquired.lease.owner.token, thirdAcquired.lease.owner.token]).toContain(finalOwner?.token);
    await secondAcquired.lease.release();
    await thirdAcquired.lease.release();
  });
});
