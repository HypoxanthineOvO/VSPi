import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { getImageDimensions } from "@moonshot-ai/pi-tui";
import type { Attachment } from "../domain/types.js";

const MIME_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export type SupportedImageMime = keyof typeof MIME_EXTENSIONS;

export interface AttachmentStoreOptions {
  home?: string;
  maxBytes?: number;
}

export interface VerifiedAttachmentReadOptions {
  expectedDirectory?: string;
  maxBytes?: number;
}

export interface AttachmentManifest {
  schemaVersion: 1;
  sessionId: string;
  attachments: Array<{
    id: string;
    alias: string;
    mimeType: SupportedImageMime;
    width: number;
    height: number;
    size: number;
    filename: string;
  }>;
}

export async function cleanupAttachmentSessions(options: {
  home?: string;
  retainSessionIds: string[];
  olderThanMs: number;
  now?: Date;
}): Promise<{ removedSessionIds: string[] }> {
  if (!Number.isFinite(options.olderThanMs) || options.olderThanMs < 0) {
    throw new Error("Attachment retention age is invalid");
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Attachment retention clock is invalid");
  const root = join(options.home ?? homedir(), ".cache", "vspi", "attachments");
  const retained = new Set(options.retainSessionIds.map((id) => validateSessionId(id)));
  const cutoff = now.getTime() - options.olderThanMs;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removedSessionIds: [] };
    throw error;
  }
  const removedSessionIds: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || retained.has(entry.name) || !isSessionId(entry.name)) continue;
    const directory = join(root, entry.name);
    const metadata = await stat(directory);
    if (metadata.mtimeMs >= cutoff) continue;
    await rm(directory, { recursive: true, force: false });
    removedSessionIds.push(entry.name);
  }
  return { removedSessionIds };
}

export class AttachmentStore {
  readonly directory: string;
  readonly manifestPath: string;
  readonly maxBytes: number;
  private attachments = new Map<string, Attachment>();

  constructor(
    readonly sessionId: string,
    options: AttachmentStoreOptions = {},
  ) {
    validateSessionId(sessionId);
    this.directory = join(options.home ?? homedir(), ".cache", "vspi", "attachments", sessionId);
    this.manifestPath = join(this.directory, "manifest.json");
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.attachments.clear();
    try {
      const directoryMetadata = await lstat(this.directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new Error("Attachment session directory is unsafe");
      }
      const parentRealpath = await realpath(dirname(this.directory));
      const directoryRealpath = await realpath(this.directory);
      if (directoryRealpath !== join(parentRealpath, basename(this.directory))) {
        throw new Error("Attachment session directory is unsafe");
      }
      const manifest = await this.readManifest(directoryRealpath);
      if (!manifest) return;
      if (manifest.schemaVersion !== 1 || manifest.sessionId !== this.sessionId || !Array.isArray(manifest.attachments))
        return;
      const restoredIds = new Set<string>();
      for (const item of manifest.attachments) {
        const mimeType = normalizeMime(item.mimeType);
        if (
          !mimeType ||
          typeof item.id !== "string" ||
          !/^[a-zA-Z0-9._-]{1,160}$/.test(item.id) ||
          restoredIds.has(item.id) ||
          typeof item.filename !== "string" ||
          basename(item.filename) !== item.filename ||
          extname(item.filename).toLowerCase() !== `.${MIME_EXTENSIONS[mimeType ?? "image/png"]}` ||
          !Number.isSafeInteger(item.width) ||
          item.width < 1 ||
          !Number.isSafeInteger(item.height) ||
          item.height < 1 ||
          !Number.isSafeInteger(item.size) ||
          item.size < 1 ||
          item.size > this.maxBytes
        ) {
          continue;
        }
        let alias: string;
        try {
          alias = normalizeAlias(item.alias);
        } catch {
          continue;
        }
        const attachment = await this.restoreEntry(item, alias, mimeType, directoryRealpath);
        if (!attachment) continue;
        restoredIds.add(item.id);
        this.attachments.set(item.id, attachment);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  private async readManifest(directoryRealpath: string): Promise<AttachmentManifest | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const metadata = await lstat(this.manifestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 1024 * 1024) {
        return undefined;
      }
      if ((await realpath(this.manifestPath)) !== join(directoryRealpath, "manifest.json")) return undefined;
      handle = await open(this.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.size !== metadata.size
      ) {
        return undefined;
      }
      const source = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) return undefined;
      return JSON.parse(source) as AttachmentManifest;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP" || error instanceof SyntaxError) return undefined;
      throw new Error("Attachment manifest could not be validated");
    } finally {
      await handle?.close();
    }
  }

  private async restoreEntry(
    item: AttachmentManifest["attachments"][number],
    alias: string,
    mimeType: SupportedImageMime,
    directoryRealpath: string,
  ): Promise<Attachment | undefined> {
    const filename = basename(item.filename);
    const path = join(this.directory, filename);
    const attachment: Attachment = {
      id: item.id,
      alias,
      mimeType,
      width: item.width,
      height: item.height,
      size: item.size,
      path,
      status: "ready",
    };
    try {
      await readVerifiedAttachmentBytes(attachment, {
        expectedDirectory: directoryRealpath,
        maxBytes: this.maxBytes,
      });
      return attachment;
    } catch {
      return undefined;
    }
  }

  list(): Attachment[] {
    return Array.from(this.attachments.values(), (item) => ({ ...item }));
  }

  get(id: string): Attachment | undefined {
    const attachment = this.attachments.get(id);
    return attachment ? { ...attachment } : undefined;
  }

  async add(bytes: Uint8Array, mimeType: string, alias?: string): Promise<Attachment> {
    const mime = normalizeMime(mimeType);
    if (!mime) throw new Error("仅支持 PNG、JPEG、WebP 和 GIF 图片");
    if (bytes.byteLength === 0) throw new Error("图片内容为空");
    if (bytes.byteLength > this.maxBytes)
      throw new Error(`图片超过 ${Math.floor(this.maxBytes / 1024 / 1024)} MiB 限制`);
    if (!hasExpectedMagic(bytes, mime)) throw new Error("图片内容与 MIME 类型不一致");
    const base64 = Buffer.from(bytes).toString("base64");
    const dimensions = getImageDimensions(base64, mime);
    if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1) throw new Error("无法读取图片尺寸");

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const filename = `${id}.${MIME_EXTENSIONS[mime]}`;
    const path = join(this.directory, filename);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    const attachment: Attachment = {
      id,
      alias: normalizeAlias(alias ?? `图片-${this.attachments.size + 1}`),
      mimeType: mime,
      width: dimensions.widthPx,
      height: dimensions.heightPx,
      size: bytes.byteLength,
      path,
      status: "ready",
    };
    this.attachments.set(id, attachment);
    await this.persistManifest();
    return { ...attachment };
  }

  async rename(id: string, alias: string): Promise<Attachment> {
    const current = this.attachments.get(id);
    if (!current) throw new Error("附件不存在");
    current.alias = normalizeAlias(alias);
    await this.persistManifest();
    return { ...current };
  }

  async remove(id: string): Promise<void> {
    const current = this.attachments.get(id);
    if (!current) return;
    this.attachments.delete(id);
    try {
      await unlink(current.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.persistManifest();
  }

  async saveToProject(id: string, cwd: string): Promise<string> {
    const current = this.attachments.get(id);
    if (!current) throw new Error("附件不存在");
    const projectRoot = resolve(cwd);
    const bytes = await readVerifiedAttachmentBytes(current, {
      expectedDirectory: this.directory,
      maxBytes: this.maxBytes,
    });
    const project = await verifyDirectory(projectRoot);
    const vspi = await ensureDirectory(join(projectRoot, ".vspi"), project.realpath);
    const targetDirectory = join(projectRoot, ".vspi", "attachments");
    const attachments = await ensureDirectory(targetDirectory, vspi.realpath);
    const target = join(targetDirectory, `${fileSafeAlias(current.alias)}.${MIME_EXTENSIONS[current.mimeType]}`);
    const relation = relative(projectRoot, resolve(target));
    if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("附件目标路径越界");
    await writeProjectAttachment(target, bytes, attachments);
    return target;
  }

  async readBase64(id: string): Promise<string> {
    const current = this.attachments.get(id);
    if (!current) throw new Error("附件不存在");
    return (
      await readVerifiedAttachmentBytes(current, {
        expectedDirectory: this.directory,
        maxBytes: this.maxBytes,
      })
    ).toString("base64");
  }

  manifestFor(ids: string[]): AttachmentManifest {
    const selected = ids.map((id) => this.attachments.get(id)).filter((item): item is Attachment => Boolean(item));
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      attachments: selected.map((item) => ({
        id: item.id,
        alias: item.alias,
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
        size: item.size,
        filename: basename(item.path),
      })),
    };
  }

  private async persistManifest(): Promise<void> {
    const manifest = this.manifestFor(Array.from(this.attachments.keys()));
    const temporary = `${this.manifestPath}.${process.pid}-${randomUUID()}.tmp`;
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.manifestPath);
  }
}

interface VerifiedDirectory {
  path: string;
  realpath: string;
  dev: number;
  ino: number;
}

export async function readVerifiedAttachmentBytes(
  attachment: Attachment,
  options: VerifiedAttachmentReadOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const mimeType = normalizeMime(attachment.mimeType);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (
      !mimeType ||
      !isAbsolute(attachment.path) ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 1 ||
      attachment.size > maxBytes ||
      !Number.isSafeInteger(attachment.width) ||
      attachment.width < 1 ||
      !Number.isSafeInteger(attachment.height) ||
      attachment.height < 1
    ) {
      throw new Error("invalid attachment metadata");
    }
    const path = resolve(attachment.path);
    const directory = await verifyDirectory(resolve(options.expectedDirectory ?? dirname(path)));
    const expectedRealpath = join(directory.realpath, basename(path));
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || (await realpath(path)) !== expectedRealpath) {
      throw new Error("unsafe attachment path");
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== attachment.size ||
      opened.size < 1 ||
      opened.size > maxBytes
    ) {
      throw new Error("attachment changed before read");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const finalPath = await lstat(path);
    if (
      bytes.byteLength !== attachment.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      (await realpath(path)) !== expectedRealpath ||
      !hasExpectedMagic(bytes, mimeType)
    ) {
      throw new Error("attachment changed during read");
    }
    const dimensions = getImageDimensions(bytes.toString("base64"), mimeType);
    if (!dimensions || dimensions.widthPx !== attachment.width || dimensions.heightPx !== attachment.height) {
      throw new Error("attachment dimensions changed");
    }
    await assertDirectoryUnchanged(directory);
    return bytes;
  } catch {
    throw new Error("附件文件验证失败");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureDirectory(path: string, parentRealpath: string): Promise<VerifiedDirectory> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return verifyDirectory(path, parentRealpath);
}

async function verifyDirectory(path: string, parentRealpath?: string): Promise<VerifiedDirectory> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("附件目录不安全");
  const canonical = await realpath(path);
  if (parentRealpath !== undefined && canonical !== join(parentRealpath, basename(path))) {
    throw new Error("附件目录越界");
  }
  const after = await lstat(path);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("附件目录发生变化");
  }
  return { path, realpath: canonical, dev: after.dev, ino: after.ino };
}

async function assertDirectoryUnchanged(directory: VerifiedDirectory): Promise<void> {
  const current = await verifyDirectory(directory.path);
  if (current.realpath !== directory.realpath || current.dev !== directory.dev || current.ino !== directory.ino) {
    throw new Error("附件目录发生变化");
  }
}

async function writeProjectAttachment(target: string, bytes: Buffer, directory: VerifiedDirectory): Promise<void> {
  const targetName = basename(target);
  if (target !== join(directory.path, targetName)) throw new Error("附件目标路径越界");
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("附件目标文件不安全");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory.path, `.${targetName}.${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryUnchanged(directory);
    await rename(temporary, target);
    renamed = true;
    await assertDirectoryUnchanged(directory);
    const saved = await lstat(target);
    if (
      !saved.isFile() ||
      saved.isSymbolicLink() ||
      saved.size !== bytes.byteLength ||
      (await realpath(target)) !== join(directory.realpath, targetName)
    ) {
      throw new Error("附件保存结果不安全");
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) {
      try {
        await assertDirectoryUnchanged(directory);
        await unlink(temporary);
      } catch {
        // Cleanup cannot relax or replace the primary failure.
      }
    }
  }
}

function isSessionId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,160}$/.test(value) && value !== "." && value !== "..";
}

function validateSessionId(value: string): string {
  if (!isSessionId(value)) throw new Error("Attachment session ID is invalid");
  return value;
}

function normalizeMime(value: string): SupportedImageMime | undefined {
  const base = value.split(";", 1)[0]?.trim().toLowerCase();
  return base && base in MIME_EXTENSIONS ? (base as SupportedImageMime) : undefined;
}

function normalizeAlias(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[〔〕<>]/g, "")
    .trim();
  if (!normalized) throw new Error("附件名称不能为空");
  return Array.from(normalized).slice(0, 48).join("");
}

function fileSafeAlias(value: string): string {
  const safe = value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.+$/g, "")
    .trim();
  return safe || "image";
}

function hasExpectedMagic(bytes: Uint8Array, mime: SupportedImageMime): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (mime === "image/gif")
    return (
      Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF87a" ||
      Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF89a"
    );
  return (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  );
}
