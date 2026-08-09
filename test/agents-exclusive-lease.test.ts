import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireAgentExclusiveLease } from "../src/agents/exclusive-lease.js";

describe("agent exclusive lease", () => {
  it("fails or waits cancelably while another live owner holds the identity", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "vspi-agent-lease-"));
    const first = await acquireAgentExclusiveLease({ agentDir, namespace: "lane", identity: "frontend/main" });
    await expect(
      acquireAgentExclusiveLease({ agentDir, namespace: "lane", identity: "frontend/main", wait: false }),
    ).rejects.toThrow("already held");

    const controller = new AbortController();
    const waiting = acquireAgentExclusiveLease({
      agentDir,
      namespace: "lane",
      identity: "frontend/main",
      wait: true,
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await first.release();
  });

  it("reclaims a stale same-host owner without deleting a newly acquired lease", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "vspi-agent-stale-"));
    const first = await acquireAgentExclusiveLease({ agentDir, namespace: "writer", identity: "workspace" });
    const path = first.path;
    await first.release();
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        hostname: first.owner.hostname,
        token: "stale-owner",
        identity: "workspace",
        acquiredAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const reclaimed = await acquireAgentExclusiveLease({ agentDir, namespace: "writer", identity: "workspace" });
    expect(reclaimed.owner.token).not.toBe("stale-owner");
    await reclaimed.release();
  });
});
