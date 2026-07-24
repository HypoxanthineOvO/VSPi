import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentBridge } from "../src/attachments/bridge.js";
import { AttachmentStore } from "../src/attachments/store.js";
import { PNG_1X1 } from "./helpers.js";

const active: AttachmentBridge[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map((bridge) => bridge.stop()));
});

describe("loopback attachment bridge", () => {
  it("rejects caller-supplied tokens below the minimum entropy budget", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-bridge-token-"));
    const store = new AttachmentStore("bridge-token", { home });
    expect(() => new AttachmentBridge(store, { token: "short" })).toThrow("too short");
  });

  it("binds loopback and requires both token and local origin", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-bridge-"));
    const store = new AttachmentStore("bridge-test", { home });
    await store.initialize();
    const token = "test-token-with-at-least-192-bits";
    const bridge = new AttachmentBridge(store, { port: 0, token });
    active.push(bridge);
    await bridge.start();
    const base = `http://127.0.0.1:${bridge.port}`;
    const page = await fetch(base);
    expect(await page.text()).toContain("VSPi Attachment Bridge");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

    const unauthorized = await fetch(`${base}/attachment`, {
      method: "POST",
      headers: { origin: base, "content-type": "image/png" },
      body: PNG_1X1,
    });
    expect(unauthorized.status).toBe(401);

    const crossOrigin = await fetch(`${base}/attachment`, {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "image/png", "x-vspi-token": token },
      body: PNG_1X1,
    });
    expect(crossOrigin.status).toBe(403);

    const accepted = await fetch(`${base}/attachment`, {
      method: "POST",
      headers: { origin: base, "content-type": "image/png", "x-vspi-token": token },
      body: PNG_1X1,
    });
    expect(accepted.status).toBe(201);
    expect(store.list()).toHaveLength(1);
  });
});
