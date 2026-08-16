import { mkdir, mkdtemp, readFile, rename, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as clipboardModule from "../src/attachments/clipboard.js";
import { AttachmentService } from "../src/attachments/service.js";
import * as storeModule from "../src/attachments/store.js";
import { PNG_1X1, plainTheme } from "./helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("M5 attachment session lifecycle", () => {
  it("restores a valid manifest and keeps attachments owned by their session", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-attachment-restore-"));
    const first = new storeModule.AttachmentStore("session-one", { home });
    await first.initialize();
    const attachment = await first.add(PNG_1X1, "image/png", "恢复图片");

    const restored = new storeModule.AttachmentStore("session-one", { home });
    const other = new storeModule.AttachmentStore("session-two", { home });
    await restored.initialize();
    await other.initialize();

    expect(restored.list()).toEqual([attachment]);
    expect(await restored.readBase64(attachment.id)).toBe(Buffer.from(PNG_1X1).toString("base64"));
    expect(other.list()).toEqual([]);
    expect(other.directory).not.toBe(restored.directory);
  });

  it("switches AttachmentService ownership and restores the target session manifest", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-attachment-switch-"));
    const service = new AttachmentService("session-one", plainTheme(), { home });
    await service.start({ onAttachment: vi.fn(), onNotice: vi.fn() });
    const first = await service.store.add(PNG_1X1, "image/png", "会话一");
    const contract = service as unknown as { switchSession?: (sessionId: string) => Promise<void> };

    expect(contract.switchSession, "AttachmentService must follow the active Pi session").toBeTypeOf("function");
    if (!contract.switchSession) return;
    await contract.switchSession("session-two");
    expect(service.store.sessionId).toBe("session-two");
    expect(service.store.list()).toEqual([]);
    await service.store.add(PNG_1X1, "image/png", "会话二");

    await contract.switchSession("session-one");
    expect(service.store.sessionId).toBe("session-one");
    expect(service.store.list()).toEqual([first]);
    await service.dispose();
  });

  it("prunes only expired unretained session caches", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-attachment-prune-"));
    const stores = {
      retained: new storeModule.AttachmentStore("retained", { home }),
      stale: new storeModule.AttachmentStore("stale", { home }),
      fresh: new storeModule.AttachmentStore("fresh", { home }),
    };
    for (const store of Object.values(stores)) {
      await store.initialize();
      await store.add(PNG_1X1, "image/png");
    }
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(stores.retained.directory, old, old);
    await utimes(stores.stale.directory, old, old);

    const cleanup = (
      storeModule as unknown as {
        cleanupAttachmentSessions?: (options: {
          home: string;
          retainSessionIds: string[];
          olderThanMs: number;
          now: Date;
        }) => Promise<{ removedSessionIds: string[] }>;
      }
    ).cleanupAttachmentSessions;
    expect(cleanup, "attachment cleanup policy must be callable and deterministic").toBeTypeOf("function");
    if (!cleanup) return;
    const result = await cleanup({
      home,
      retainSessionIds: ["retained"],
      olderThanMs: 24 * 60 * 60 * 1000,
      now: new Date("2026-07-24T00:00:00.000Z"),
    });

    expect(result.removedSessionIds).toEqual(["stale"]);
    await expect(stat(stores.stale.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stores.retained.directory)).resolves.toBeDefined();
    await expect(stat(stores.fresh.directory)).resolves.toBeDefined();
  });

  it("rejects restored symlinks and regular files whose bytes contradict the manifest", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-attachment-integrity-"));
    const outside = join(home, "outside-private.txt");
    const store = new storeModule.AttachmentStore("integrity-session", { home, maxBytes: PNG_1X1.length });
    await store.initialize();
    await writeFile(outside, "PRIVATE_OUTSIDE_BYTES");
    await symlink(outside, join(store.directory, "borrowed.png"));
    await writeFile(join(store.directory, "tampered.png"), "not png bytes");
    await writeFile(
      store.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "integrity-session",
        attachments: [
          {
            id: "external-link",
            alias: "外链",
            mimeType: "image/png",
            width: 1,
            height: 1,
            size: Buffer.byteLength("PRIVATE_OUTSIDE_BYTES"),
            filename: "borrowed.png",
          },
          {
            id: "tampered-bytes",
            alias: "篡改",
            mimeType: "image/png",
            width: 1,
            height: 1,
            size: Buffer.byteLength("not png bytes"),
            filename: "tampered.png",
          },
        ],
      }),
    );

    const restored = new storeModule.AttachmentStore("integrity-session", { home, maxBytes: PNG_1X1.length });
    await restored.initialize();

    expect(restored.list(), "unowned or byte-inconsistent cache entries must not become ready").toEqual([]);
    await expect(restored.readBase64("external-link")).rejects.toThrow(/附件不存在|not found/i);
    await expect(restored.readBase64("tampered-bytes")).rejects.toThrow(/附件不存在|not found/i);
  });

  it("revalidates a restored attachment when its file is replaced before reading", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-attachment-read-swap-"));
    const outside = join(home, "outside-after-restore.txt");
    const first = new storeModule.AttachmentStore("read-swap-session", { home });
    await first.initialize();
    const attachment = await first.add(PNG_1X1, "image/png", "有效图片");
    const restored = new storeModule.AttachmentStore("read-swap-session", { home });
    await restored.initialize();
    expect(restored.list()).toEqual([attachment]);

    await writeFile(outside, "PRIVATE_AFTER_RESTORE");
    const replacement = `${attachment.path}.replacement`;
    await symlink(outside, replacement);
    await rename(replacement, attachment.path);

    await expect(restored.readBase64(attachment.id)).rejects.toThrow();
  });

  it("rejects a symlinked project attachment directory without writing outside", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-save-home-"));
    const project = await mkdtemp(join(tmpdir(), "vspi-m5-save-project-"));
    const normalProject = await mkdtemp(join(tmpdir(), "vspi-m5-save-normal-"));
    const outside = await mkdtemp(join(tmpdir(), "vspi-m5-save-outside-"));
    const store = new storeModule.AttachmentStore("save-session", { home });
    await store.initialize();
    const attachment = await store.add(PNG_1X1, "image/png", "outside-write");
    await mkdir(join(project, ".vspi"));
    await symlink(outside, join(project, ".vspi", "attachments"));

    const saveResult = await Promise.allSettled([store.saveToProject(attachment.id, project)]);

    expect(saveResult[0]?.status).toBe("rejected");
    await expect(stat(join(outside, "outside-write.png"))).rejects.toMatchObject({ code: "ENOENT" });
    const normalPath = await store.saveToProject(attachment.id, normalProject);
    expect(await readFile(normalPath)).toEqual(Buffer.from(PNG_1X1));
  });

  it("fences a slow old-session paste when a session switch starts", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m5-attachment-race-"));
    const onAttachment = vi.fn();
    const service = new AttachmentService("old-session", plainTheme(), { home });
    await service.start({ onAttachment, onNotice: vi.fn() });
    const oldStore = service.store;
    const originalAdd = oldStore.add.bind(oldStore);
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const addStarted = vi.fn();
    vi.spyOn(oldStore, "add").mockImplementation(async (...args) => {
      addStarted();
      await addGate;
      return originalAdd(...args);
    });
    vi.spyOn(clipboardModule, "readClipboardImage").mockResolvedValue({ bytes: PNG_1X1, mimeType: "image/png" });

    const paste = service.pasteLocal();
    await vi.waitFor(() => expect(addStarted).toHaveBeenCalledOnce());
    const switching = service.switchSession("new-session");
    await new Promise((resolve) => setImmediate(resolve));
    releaseAdd?.();
    const [pasteResult, switchResult] = await Promise.allSettled([paste, switching]);

    expect(switchResult.status).toBe("fulfilled");
    expect(service.store.sessionId).toBe("new-session");
    expect(service.store.list()).toEqual([]);
    expect(oldStore.list(), "a stale completion must be rolled back from its captured store").toEqual([]);
    expect(onAttachment, "a stale attachment must not be projected into the new Session UI").not.toHaveBeenCalled();
    expect(pasteResult.status === "rejected" || pasteResult.value === undefined).toBe(true);
    await service.dispose();
  });
});

describe("M5 injectable local clipboard adapters", () => {
  it("selects Wayland and macOS image commands through an injected runner only", async () => {
    type Runner = (command: string, args: string[], timeout?: number) => { ok: boolean; stdout: Buffer };
    const readWithRunner = (
      clipboardModule as unknown as {
        readClipboardImageWithRunner?: (options: {
          platform: NodeJS.Platform;
          env: NodeJS.ProcessEnv;
          run: Runner;
        }) => Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
      }
    ).readClipboardImageWithRunner;
    expect(readWithRunner, "clipboard adapters must support a no-process injected runner").toBeTypeOf("function");
    if (!readWithRunner) return;

    const waylandRun = vi.fn<Runner>((command, args) => {
      if (command === "wl-paste" && args[0] === "--list-types")
        return { ok: true, stdout: Buffer.from("text/plain\nimage/png\n") };
      if (command === "wl-paste") return { ok: true, stdout: Buffer.from(PNG_1X1) };
      throw new Error(`unexpected real-command route: ${command}`);
    });
    const wayland = await readWithRunner({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      run: waylandRun,
    });
    expect(wayland).toMatchObject({ mimeType: "image/png", bytes: PNG_1X1 });
    expect(waylandRun.mock.calls.map(([command]) => command)).toEqual(["wl-paste", "wl-paste"]);

    const macRun = vi.fn<Runner>(() => ({ ok: true, stdout: Buffer.from(PNG_1X1) }));
    const mac = await readWithRunner({ platform: "darwin", env: {}, run: macRun });
    expect(mac).toMatchObject({ mimeType: "image/png", bytes: PNG_1X1 });
    expect(macRun).toHaveBeenCalledWith("pngpaste", ["-"], undefined);
  });
});
