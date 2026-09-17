/**
 * Scenario: SSH clipboard routing and local image-path paste.
 * Wiring: stub only external clipboard commands/terminal writes; real temporary image files and attachment storage.
 * Run: pnpm --filter vspi test test/clipboard.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clipboardSequence, writeClipboardText } from '../src/v1/attachments/clipboard.js';
import { ImagePathPasteHandler, pastedImagePath, readImagePath } from '../src/v1/attachments/image-path.js';
import { AttachmentService } from '../src/v1/attachments/service.js';
import { createTheme } from '../src/v1/ui/theme.js';
import { detectTerminalCapabilities } from '../src/v1/ui/capabilities.js';

const roots: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', 'base64');
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vspi-paste-')); roots.push(root);
  const path = join(root, 'example image.png'); await writeFile(path, png);
  return { root, path };
}
const unavailable = () => ({ ok: false, stdout: Buffer.alloc(0) });

describe('clipboard copy routing', () => {
  it('uses the terminal rather than the remote system clipboard over SSH', async () => {
    const run = vi.fn(async () => unavailable());
    const writeTerminal = vi.fn();
    const message = await writeClipboardText('你好', { platform: 'linux', env: { SSH_CONNECTION: 'example', DISPLAY: ':0' }, run, writeTerminal });
    expect(run).not.toHaveBeenCalled();
    expect(writeTerminal).toHaveBeenCalledWith('\u001B]52;c;5L2g5aW9\u0007');
    expect(message).toContain('已请求终端复制');
  });
  it('prefers tmux clipboard forwarding when it is available', async () => {
    const run = vi.fn(async (_command: string, args: string[], _input?: Buffer) => ({ ok: true, stdout: Buffer.from(args[0] === 'show-options' ? 'external\n' : 'Ms: (string) enabled') }));
    const writeTerminal = vi.fn();
    await writeClipboardText('fixture', { env: { SSH_TTY: '/dev/pts/example', TMUX: 'example' }, run, writeTerminal });
    expect(run).toHaveBeenCalledWith('tmux', ['load-buffer', '-w', '-'], Buffer.from('fixture'));
    expect(writeTerminal).not.toHaveBeenCalled();
  });
  it('wraps OSC 52 for tmux if native tmux forwarding is disabled', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: Buffer.from('off\n') }));
    const writeTerminal = vi.fn();
    await writeClipboardText('hello', { env: { SSH_CLIENT: 'example', TMUX_PANE: '%1' }, run, writeTerminal });
    expect(writeTerminal).toHaveBeenCalledWith('\u001BPtmux;\u001B\u001B]52;c;aGVsbG8=\u0007\u001B\\');
  });
  it('uses the native clipboard locally before terminal fallback', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: Buffer.alloc(0) }));
    const writeTerminal = vi.fn();
    expect(await writeClipboardText('fixture', { platform: 'darwin', env: {}, run, writeTerminal })).toBe('已复制到系统剪贴板');
    expect(run).toHaveBeenCalledWith('pbcopy', [], Buffer.from('fixture'));
    expect(writeTerminal).not.toHaveBeenCalled();
  });
  it('falls back to the terminal when the local clipboard command fails', async () => {
    const writeTerminal = vi.fn();
    await writeClipboardText('hello', { platform: 'linux', env: { DISPLAY: ':0' }, run: async () => unavailable(), writeTerminal });
    expect(writeTerminal).toHaveBeenCalledWith('\u001B]52;c;aGVsbG8=\u0007');
  });
  it('recovers from a missing native executable without hanging on child process events', async () => {
    const writeTerminal = vi.fn();
    await writeClipboardText('hello', { platform: 'darwin', env: { PATH: '/nonexistent' }, writeTerminal });
    expect(writeTerminal).toHaveBeenCalledWith('\u001B]52;c;aGVsbG8=\u0007');
  });
  it('rejects oversized terminal copy without emitting a partial sequence', async () => {
    const writeTerminal = vi.fn();
    await expect(writeClipboardText('中'.repeat(33334), { env: { SSH_CONNECTION: 'example' }, writeTerminal })).rejects.toThrow('100 KB');
    expect(writeTerminal).not.toHaveBeenCalled();
  });
  it('encodes escape characters in copied content rather than injecting terminal controls', () => {
    expect(clipboardSequence('hello\u001B[2J')).toBe('\u001B]52;c;aGVsbG8bWzJK\u0007');
  });
  it('reports terminal write failures rather than pretending to copy', async () => {
    await expect(writeClipboardText('hello', { env: { SSH_TTY: 'example' }, writeTerminal: () => { throw new Error('closed'); } })).rejects.toThrow('终端连接');
  });
});

describe('image paths', () => {
  it.each(['plain', 'quoted', 'escaped', 'url'])('resolves a %s image path without shell execution', async format => {
    const { root, path } = await fixture();
    const value = format === 'plain' ? './example.png' : format === 'quoted' ? `"${path}"` : format === 'escaped' ? path.replaceAll(' ', '\\ ') : pathToFileURL(path).href;
    expect(pastedImagePath(value, root)).toBe(format === 'plain' ? join(root, 'example.png') : path);
  });
  it.each(['https://example.test/image.png', 'file://other-host/image.png', 'please read /tmp/image.png', 'one.png\ntwo.png', '/tmp/image.svg', 'C:\\Users\\example\\image.png'])('keeps unsupported input %s as text', input => {
    if (process.platform === 'win32' && input.startsWith('C:')) return;
    expect(pastedImagePath(input, '/tmp')).toBeUndefined();
  });
  it('reads image bytes from a regular file under the size budget', async () => {
    const { path } = await fixture();
    expect(await readImagePath(path, 1024)).toEqual({ bytes: png, mimeType: 'image/png' });
  });
  it('rejects files exceeding the attachment budget', async () => {
    const { path } = await fixture();
    await expect(readImagePath(path, 1)).rejects.toThrow('限制');
  });
  it('rejects directories with image extensions', async () => {
    const { root } = await fixture(); const path = join(root, 'directory.png'); await mkdir(path);
    await expect(readImagePath(path, 1024)).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('resolves an explicitly pasted symlink to an ordinary image file', async () => {
    const { root, path } = await fixture(); const link = join(root, 'link.png'); await symlink(path, link);
    expect((await readImagePath(link, 1024)).bytes).toEqual(png);
  });
  it('stores a valid path as a verified attachment without modifying the source', async () => {
    const { root, path } = await fixture();
    const service = new AttachmentService('example', createTheme(detectTerminalCapabilities(), 'Terminal'), { home: root });
    const onAttachment = vi.fn();
    try {
      await service.start({ onAttachment, onNotice: vi.fn() });
      const attachment = await service.importPath(path);
      expect(attachment).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 });
      expect(onAttachment).toHaveBeenCalledOnce();
      expect(await readFile(path)).toEqual(png);
    } finally { await service.dispose(); }
  });
  it('rejects disguised text files before adding an attachment', async () => {
    const { root, path } = await fixture(); await writeFile(path, 'not an image');
    const service = new AttachmentService('example', createTheme(detectTerminalCapabilities(), 'Terminal'), { home: root });
    const onAttachment = vi.fn();
    try {
      await service.start({ onAttachment, onNotice: vi.fn() });
      await expect(service.importPath(path)).rejects.toThrow('MIME');
      expect(service.store.list()).toEqual([]);
      expect(onAttachment).not.toHaveBeenCalled();
    } finally { await service.dispose(); }
  });
  it('does not deliver a pending import to a replacement session', async () => {
    const { root, path } = await fixture();
    const service = new AttachmentService('first', createTheme(detectTerminalCapabilities(), 'Terminal'), { home: root });
    const onAttachment = vi.fn();
    try {
      await service.start({ onAttachment, onNotice: vi.fn() });
      const pending = service.importPath(path);
      await service.switchSession('second');
      expect(await pending).toBeUndefined();
      expect(onAttachment).not.toHaveBeenCalled();
      expect(service.store.list()).toEqual([]);
    } finally { await service.dispose(); }
  });
});

describe('image paste input ordering', () => {
  it('allows Escape to cancel an import without replaying queued input', async () => {
    let signal: AbortSignal | undefined;
    const replay = vi.fn();
    const handler = new ImagePathPasteHandler({ cwd: '/tmp',
      attach: (_path, supplied) => { signal = supplied; return new Promise((_resolve, reject) => { supplied.addEventListener('abort', () => { reject(new Error('cancelled')); }, { once: true }); }); },
      replay, insert: vi.fn(), notice: vi.fn(),
    });
    handler.handle('\u001B[200~/tmp/example.png\u001B[201~'); handler.handle('\r'); handler.handle('\u001B');
    expect(signal?.aborted).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(handler.active).toBe(false); expect(replay).not.toHaveBeenCalled();
  });
  it('waits for an image before replaying Enter and preserves separate input events', async () => {
    let finish!: () => void;
    const attach = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const replay = vi.fn(); const insert = vi.fn();
    const handler = new ImagePathPasteHandler({ cwd: '/tmp', attach, replay, insert, notice: vi.fn() });
    handler.handle('\u001B[200~/tmp/example'); handler.handle('.png\u001B[201~');
    handler.handle('\r'); handler.handle('next');
    expect(replay).not.toHaveBeenCalled();
    finish(); await vi.waitFor(() => { expect(handler.active).toBe(false); });
    expect(replay.mock.calls).toEqual([['\r'], ['next']]);
    expect(insert).not.toHaveBeenCalled();
  });
  it('keeps a failed image path without automatically submitting it', async () => {
    const replay = vi.fn(); const insert = vi.fn(); const notice = vi.fn();
    const handler = new ImagePathPasteHandler({ cwd: '/tmp', attach: async () => { throw new Error('ENOENT'); }, replay, insert, notice });
    handler.handle('\u001B[200~/tmp/missing.png\u001B[201~\r');
    await vi.waitFor(() => { expect(handler.active).toBe(false); });
    expect(insert).toHaveBeenCalledWith('\u001B[200~/tmp/missing.png\u001B[201~');
    expect(replay).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledOnce();
  });
  it('discards stale queued input when the session changes during import', async () => {
    let fail!: (error: Error) => void;
    const failed = new Promise<void>((_resolve, reject) => { fail = reject; });
    const insert = vi.fn(); const replay = vi.fn();
    const handler = new ImagePathPasteHandler({ cwd: '/tmp', attach: () => failed, replay, insert, notice: vi.fn() });
    handler.handle('\u001B[200~/tmp/image.png\u001B[201~\r'); handler.reset(); fail(new Error('stale'));
    await failed.catch(() => {}); await Promise.resolve();
    expect(insert).not.toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled();
  });
  it('preserves long ordinary pastes when the closing marker arrives in two pieces', () => {
    const insert = vi.fn(); const replay = vi.fn(); const attach = vi.fn();
    const handler = new ImagePathPasteHandler({ cwd: '/tmp', attach, replay, insert, notice: vi.fn() });
    handler.handle('\u001B[200~' + 'x'.repeat(9000)); handler.handle('\u001B[20'); handler.handle('1~\r');
    expect(handler.active).toBe(false);
    expect(insert.mock.calls.map(([value]) => value).join('')).toBe('\u001B[200~' + 'x'.repeat(9000) + '\u001B[201~');
    expect(replay).toHaveBeenCalledWith('\r'); expect(attach).not.toHaveBeenCalled();
  });
});
