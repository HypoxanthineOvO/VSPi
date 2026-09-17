import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function pastedImagePath(text: string, cwd: string): string | undefined {
  let value = text.trim();
  if (!value || value.length > 8192 || /[\r\n\u0000-\u001F\u007F]/u.test(value)) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  else {
    const unescaped = value.replaceAll(/\\([ \t'"()])/gu, '$1');
    if (/\s/u.test(value.replaceAll(/\\[ \t]/gu, ''))) return undefined;
    value = unescaped;
  }
  if (value.startsWith('file:')) {
    try {
      const url = new URL(value);
      if (url.search || url.hash || url.username || url.password) return undefined;
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      value = fileURLToPath(url);
    } catch { return undefined; }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return undefined;
  if (process.platform !== 'win32' && (/^[a-z]:[\\/]/iu.test(value) || value.startsWith('\\\\'))) return undefined;
  if (value.startsWith('~/')) value = resolve(homedir(), value.slice(2));
  if (!MIME_TYPES[extname(value).toLowerCase()]) return undefined;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export async function readImagePath(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
  signal?.throwIfAborted();
  const mimeType = MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error('仅支持 PNG、JPEG、WebP 和 GIF 图片');
  const resolved = await realpath(path);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    signal?.throwIfAborted();
    if (!before.isFile()) throw new Error('图片路径不是普通文件');
    if (before.size <= 0 || before.size > maxBytes) throw new Error(`图片为空或超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 限制`);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat();
    signal?.throwIfAborted();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('读取期间图片发生变化，请重新粘贴');
    return { bytes: bytes.subarray(0, length), mimeType };
  } finally { await file.close(); }
}

export class ImagePathPasteHandler {
  private buffer: string | undefined;
  private pending = false;
  private queued: string[] = [];
  private queuedSize = 0;
  private revision = 0;
  private passing = false;
  private passingTail = '';
  private controller: AbortController | undefined;

  constructor(private readonly options: {
    cwd: string;
    attach: (path: string, signal: AbortSignal) => Promise<unknown>;
    insert: (data: string) => void;
    replay: (data: string) => void;
    notice: (message: string) => void;
  }) {}

  get active(): boolean { return this.pending || this.buffer !== undefined || this.passing; }

  reset(): void { this.revision++; this.controller?.abort(); this.controller = undefined; this.buffer = undefined; this.queued = []; this.queuedSize = 0; this.pending = false; this.passing = false; this.passingTail = ''; }

  handle(data: string): boolean {
    const start = '\u001B[200~';
    const end = '\u001B[201~';
    if (this.pending) {
      if (data === '\u001B' || data === '\u0003') { this.reset(); this.options.notice('图片导入已取消'); return true; }
      if (this.queuedSize + data.length <= 1024 * 1024) { this.queued.push(data); this.queuedSize += data.length; }
      else this.options.notice('图片导入期间输入过大，请等待完成后重新输入');
      return true;
    }
    if (this.passing) {
      const combined = this.passingTail + data;
      const stop = combined.indexOf(end);
      if (stop < 0) { this.options.insert(data); this.passingTail = combined.slice(-5); }
      else {
        const consumed = stop + end.length - this.passingTail.length;
        this.passing = false;
        this.passingTail = '';
        this.options.insert(data.slice(0, consumed));
        if (data.length > consumed) this.options.replay(data.slice(consumed));
      }
      return true;
    }
    if (this.buffer === undefined) {
      const index = data.indexOf(start);
      if (index < 0) {
        if (data.length > 1 && !data.includes('\u001B') && pastedImagePath(data, this.options.cwd)) return this.consume(data, '');
        return false;
      }
      if (index > 0) this.options.insert(data.slice(0, index));
      this.buffer = '';
      data = data.slice(index + start.length);
    }
    this.buffer += data;
    const stop = this.buffer.indexOf(end);
    if (stop >= 0) {
      const content = this.buffer.slice(0, stop);
      const remaining = this.buffer.slice(stop + end.length);
      this.buffer = undefined;
      return this.consume(content, remaining);
    }
    if (this.buffer.length > 8192) {
      this.options.insert(start + this.buffer);
      this.passingTail = this.buffer.slice(-5);
      this.buffer = undefined;
      this.passing = true;
    }
    return true;
  }

  private consume(content: string, remaining: string): boolean {
    const path = pastedImagePath(content, this.options.cwd);
    if (!path) {
      this.options.insert(`\u001B[200~${content}\u001B[201~`);
      if (remaining) this.options.replay(remaining);
      return true;
    }
    this.pending = true;
    this.queued = remaining ? [remaining] : [];
    this.queuedSize = remaining.length;
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    let failed = false;
    void this.options.attach(path, controller.signal).catch(() => {
      if (this.revision !== revision) return;
      failed = true;
      this.options.insert(`\u001B[200~${content}\u001B[201~`);
      this.options.notice('未能导入图片：请检查运行 VSPi 的机器上的路径、权限、图片格式和大小；原路径已保留');
    }).finally(() => {
      if (this.revision !== revision) return;
      this.pending = false;
      this.controller = undefined;
      const queued = this.queued;
      this.queued = [];
      this.queuedSize = 0;
      for (const data of queued) if (!failed || (data !== '\r' && data !== '\n')) this.options.replay(data);
    });
    return true;
  }
}
