import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_FEEDBACK_BYTES = 1024 * 1024;
export const FEEDBACK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface FeedbackEntry {
  role: string;
  kind: string;
  text: string;
}
export interface FeedbackBundle {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  description: string;
  diagnostics: Record<string, string | number | boolean | null>;
  conversation: FeedbackEntry[];
  truncated: boolean;
  consent: 'preview-required';
}

export function redactFeedbackText(text: string, secrets: readonly string[] = []): string {
  let value = text;
  for (const secret of [...new Set(secrets)]
    .filter((key) => key.length >= 6)
    .toSorted((a, b) => b.length - a.length))
    value = value.replaceAll(secret, '[REDACTED]');
  return value
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replaceAll(
      /^([ \t]*(?:Set-Cookie|Cookie|Authorization|Proxy-Authorization)[ \t]*:)[^\r\n]*/gim,
      '$1 [REDACTED]',
    )
    .replaceAll(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, '[REDACTED AUTH]')
    .replaceAll(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replaceAll(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]')
    .replaceAll(
      /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret(?:[-_]?access)?[-_]?key|token|password|secret|authorization|cookie)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|(?=\r?\n|$))|'[^'\r\n]*(?:'|(?=\r?\n|$))|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.href;
      } catch {
        return '[INVALID URL]';
      }
    })
    .replaceAll(/\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

export function feedbackSecrets(value: unknown): string[] {
  const keys: string[] = [];
  function visit(item: unknown, sensitive = false, depth = 0): void {
    if (depth > 12 || keys.length >= 1024) return;
    if (typeof item === 'string') {
      if (sensitive && item.length >= 6) keys.push(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, sensitive, depth + 1);
      return;
    }
    if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item))
        visit(
          child,
          sensitive ||
            /api.?key|token|secret|password|credential|authorization|cookie|headers|^env$/i.test(
              key,
            ),
          depth + 1,
        );
  }
  visit(value);
  return keys;
}

export function createFeedbackBundle(input: {
  description: string;
  diagnostics: FeedbackBundle['diagnostics'];
  conversation: readonly FeedbackEntry[];
  secrets?: readonly string[];
}): FeedbackBundle {
  if (!input.description.trim()) throw new Error('请填写反馈描述');
  if (input.description.length > 8192) throw new Error('反馈描述超过 8192 字符，请先缩短');
  const clean = (text: string) => redactFeedbackText(text, input.secrets);
  const bundle: FeedbackBundle = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    description: clean(input.description).slice(0, 8192),
    diagnostics: Object.fromEntries(
      Object.entries(input.diagnostics)
        .slice(0, 32)
        .map(([key, value]) => [
          clean(key).slice(0, 80),
          /api.?key|token|secret|password|credential|authorization|cookie/i.test(key)
            ? '[REDACTED]'
            : typeof value === 'string'
            ? clean(value).slice(0, 512)
            : value,
        ]),
    ),
    conversation: [],
    truncated: input.conversation.length > 200 || input.description.length > 8192,
    consent: 'preview-required',
  };
  let size = Buffer.byteLength(JSON.stringify(bundle));
  for (const entry of input.conversation.slice(-200).toReversed()) {
    const oversized = Buffer.byteLength(entry.text) > 64 * 1024;
    const text = oversized ? '[该条原文超过 64 KiB，未采集；可手动摘录相关片段后重新脱敏提交]' : clean(entry.text);
    if (oversized) bundle.truncated = true;
    const item = {
      role: clean(entry.role).slice(0, 32),
      kind: clean(entry.kind).slice(0, 32),
      text: text.slice(0, 16384),
    };
    if (text.length > item.text.length) bundle.truncated = true;
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (size + bytes > MAX_FEEDBACK_BYTES - 128) {
      bundle.truncated = true;
      break;
    }
    bundle.conversation.unshift(item);
    size += bytes;
  }
  return bundle;
}

export function parseFeedbackBundle(bytes: Buffer): FeedbackBundle {
  if (bytes.byteLength > MAX_FEEDBACK_BYTES) throw new Error('Feedback package exceeds size limit');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid feedback JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('Invalid feedback');
  const b = value as FeedbackBundle;
  if (
    b.schemaVersion !== 1 ||
    !FEEDBACK_ID.test(b.id) ||
    typeof b.description !== 'string' ||
    !b.description.trim() ||
    b.description.length > 8192 ||
    typeof b.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(b.createdAt)) ||
    typeof b.truncated !== 'boolean' ||
    b.consent !== 'preview-required'
  )
    throw new Error('Invalid feedback metadata');
  if (
    !Array.isArray(b.conversation) ||
    b.conversation.length > 200 ||
    b.conversation.some(
      (item) =>
        !item ||
        typeof item.role !== 'string' ||
        item.role.length > 32 ||
        typeof item.kind !== 'string' ||
        item.kind.length > 32 ||
        typeof item.text !== 'string' ||
        item.text.length > 16384,
    )
  )
    throw new Error('Invalid feedback conversation');
  if (
    !b.diagnostics ||
    typeof b.diagnostics !== 'object' ||
    Array.isArray(b.diagnostics) ||
    Object.keys(b.diagnostics).length > 32 ||
    Object.entries(b.diagnostics).some(
      ([key, v]) =>
        key.length > 80 ||
        !(
          v === null ||
          typeof v === 'boolean' ||
          (typeof v === 'number' && Number.isFinite(v)) ||
          (typeof v === 'string' && v.length <= 512)
        ),
    )
  )
    throw new Error('Invalid feedback diagnostics');
  const normalized = createFeedbackBundle({
    description: b.description,
    diagnostics: b.diagnostics,
    conversation: b.conversation,
  });
  return {
    ...normalized,
    id: b.id,
    createdAt: b.createdAt,
    truncated: b.truncated || normalized.truncated,
  };
}

export async function saveFeedbackBundle(
  directory: string,
  bundle: FeedbackBundle,
): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(bundle));
  parseFeedbackBundle(bytes);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error('Feedback outbox must be a private directory');
  let count = 0;
  let total = 0;
  let inspected = 0;
  for await (const entry of await opendir(directory)) {
    if (++inspected > 1000) throw new Error('Feedback outbox needs manual cleanup');
    if (
      entry.isFile() &&
      FEEDBACK_ID.test(entry.name.replace(/\.json$/, '')) &&
      entry.name.endsWith('.json')
    ) {
      count++;
      total += (await stat(join(directory, entry.name))).size;
    }
  }
  if (count >= 100 || total + bytes.length > 20 * 1024 * 1024)
    throw new Error('本地 Feedback 包达到存储上限；请先归档或删除旧包，不会自动丢弃已有反馈');
  const path = join(directory, `${bundle.id}.json`);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}
