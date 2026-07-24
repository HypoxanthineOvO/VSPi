import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/attachments/store.js";
import { PNG_1X1 } from "./helpers.js";

describe("attachment store", () => {
  it("stores images outside the project and persists aliases separately from random filenames", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-attachment-home-"));
    const project = await mkdtemp(join(tmpdir(), "vspi-attachment-project-"));
    const store = new AttachmentStore("session-test", { home });
    await store.initialize();
    const attachment = await store.add(PNG_1X1, "image/png", "登录页-修改前");
    expect(attachment.path.startsWith(project)).toBe(false);
    expect(attachment.path).not.toContain("登录页-修改前");
    expect(attachment).toMatchObject({ width: 1, height: 1, mimeType: "image/png", status: "ready" });
    const manifest = JSON.parse(await readFile(store.manifestPath, "utf8"));
    expect(manifest.attachments[0].alias).toBe("登录页-修改前");
    expect(manifest.attachments[0].filename).toMatch(/^[a-f0-9-]+\.png$/);

    const renamed = await store.rename(attachment.id, "登录页-最终版");
    expect(renamed.alias).toBe("登录页-最终版");
    const saved = await store.saveToProject(attachment.id, project);
    expect(saved).toBe(join(project, ".vspi", "attachments", "登录页-最终版.png"));
  });

  it("rejects unsupported, oversized and MIME-confused input", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-attachment-reject-"));
    const store = new AttachmentStore("session-reject", { home, maxBytes: PNG_1X1.length });
    await store.initialize();
    await expect(store.add(PNG_1X1, "text/plain")).rejects.toThrow("仅支持");
    await expect(store.add(Buffer.from("not a png"), "image/png")).rejects.toThrow("MIME");
    await expect(store.add(Buffer.concat([PNG_1X1, Buffer.from([0])]), "image/png")).rejects.toThrow("限制");
  });

  it("removes cached bytes and manifest entries together", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-attachment-remove-"));
    const store = new AttachmentStore("session-remove", { home });
    await store.initialize();
    const attachment = await store.add(PNG_1X1, "image/png");
    await store.remove(attachment.id);
    expect(store.list()).toEqual([]);
    await expect(readFile(attachment.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on tampered manifest paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-attachment-tamper-"));
    const store = new AttachmentStore("session-tamper", { home });
    await store.initialize();
    await writeFile(
      store.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-tamper",
        attachments: [
          {
            id: "bad",
            alias: "bad",
            mimeType: "image/png",
            width: 1,
            height: 1,
            size: 1,
            filename: "../outside.png",
          },
        ],
      }),
    );
    const restored = new AttachmentStore("session-tamper", { home });
    await restored.initialize();
    expect(restored.list()).toEqual([]);
  });
});
