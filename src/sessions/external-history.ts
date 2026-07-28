import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";

export type ExternalSessionSource = "codex" | "claude";

export interface ExternalSessionSummary {
  id: string;
  source: ExternalSessionSource;
  sourceId: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  archived?: boolean;
}

export interface ExternalTranscriptItem {
  role: "user" | "assistant";
  kind: "message" | "thinking";
  text: string;
  timestamp?: number;
}

export interface ExternalContextCheckpoint {
  summary: string;
  tailStartIndex: number;
  sourceContextWindow?: number;
}

export interface ExternalSessionPreview extends ExternalSessionSummary {
  items: ExternalTranscriptItem[];
  messageCount: number;
  toolCount: number;
  estimatedTokens: number;
  sourceContextWindow?: number;
  contextCheckpoint?: ExternalContextCheckpoint;
  fingerprint: string;
  snapshotBytes: number;
  snapshotModifiedAt: string;
}

interface IndexedSession extends ExternalSessionSummary {
  path: string;
}

interface CachedDiscovery {
  modifiedAt: number;
  session: IndexedSession | undefined;
}

interface CodexIndexEntry {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
}

interface ClaudeHistoryEntry {
  display?: unknown;
  project?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
}

interface ParsedExternalSession {
  cwd?: string;
  items: ExternalTranscriptItem[];
  toolCount: number;
  sourceContextWindow?: number;
  contextCheckpoint?: {
    summary: string;
    rawTailStartIndex: number;
  };
}

const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/giu;
const AUTHORIZATION_BEARER = /(authorization["']?\s*[:=]\s*["']?)Bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const COMMON_API_KEY = /\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{12,}\b/gu;

export class ExternalSessionCatalog {
  private sessions: IndexedSession[] | undefined;
  private loading: Promise<IndexedSession[]> | undefined;
  private readonly discovered = new Map<string, CachedDiscovery>();

  constructor(private readonly home = homedir()) {}

  async list(
    options: { source?: ExternalSessionSource; query?: string; limit?: number } = {},
  ): Promise<ExternalSessionSummary[]> {
    const sessions = await this.loadIndex(true);
    const query = options.query?.trim().toLocaleLowerCase();
    return sessions
      .filter((session) => !options.source || session.source === options.source)
      .filter((session) => !query || `${session.title}\n${session.cwd ?? ""}`.toLocaleLowerCase().includes(query))
      .slice(0, options.limit ?? 200)
      .map(withoutPath);
  }

  async preview(id: string): Promise<ExternalSessionPreview> {
    const session = (await this.loadIndex()).find((entry) => entry.id === id);
    if (!session) throw new Error("外部会话不存在或索引已经变化");
    const snapshot = await assertRegularFileWithin(session.path, this.allowedRoot(session.source));
    const parsed =
      session.source === "codex"
        ? await parseCodex(session.path, snapshot.size)
        : await parseClaude(session.path, snapshot.size);
    const splitAt = parsed.contextCheckpoint?.rawTailStartIndex;
    const beforeCheckpoint = coalesceItems(splitAt === undefined ? parsed.items : parsed.items.slice(0, splitAt));
    const afterCheckpoint = splitAt === undefined ? [] : coalesceItems(parsed.items.slice(splitAt));
    const items = [...beforeCheckpoint, ...afterCheckpoint];
    const contextCheckpoint = parsed.contextCheckpoint
      ? {
          summary: parsed.contextCheckpoint.summary,
          tailStartIndex: beforeCheckpoint.length,
          ...(parsed.sourceContextWindow ? { sourceContextWindow: parsed.sourceContextWindow } : {}),
        }
      : undefined;
    const normalized = [
      ...items.map((item) => `${item.role}\0${item.kind}\0${item.text}`),
      contextCheckpoint ? `checkpoint\0${contextCheckpoint.summary}\0${contextCheckpoint.tailStartIndex}` : "",
      `tools\0${parsed.toolCount}`,
    ].join("\n");
    const summary = parsed.cwd ? { ...session, cwd: parsed.cwd } : session;
    return {
      ...withoutPath(summary),
      items,
      messageCount: items.filter((item) => item.kind === "message").length,
      toolCount: parsed.toolCount,
      estimatedTokens: Math.ceil(items.reduce((total, item) => total + item.text.length, 0) / 3),
      ...(parsed.sourceContextWindow ? { sourceContextWindow: parsed.sourceContextWindow } : {}),
      ...(contextCheckpoint ? { contextCheckpoint } : {}),
      fingerprint: createHash("sha256").update(normalized).digest("hex"),
      snapshotBytes: snapshot.size,
      snapshotModifiedAt: new Date(snapshot.mtimeMs).toISOString(),
    };
  }

  invalidate(): void {
    this.sessions = undefined;
  }

  private async loadIndex(refresh = false): Promise<IndexedSession[]> {
    if (!refresh && this.sessions) return this.sessions;
    if (this.loading) return this.loading;
    this.loading = Promise.all([this.loadCodexIndex(), this.loadClaudeIndex()]).then(([codex, claude]) => {
      this.sessions = [...codex, ...claude].sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id),
      );
      return this.sessions;
    });
    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async loadCodexIndex(): Promise<IndexedSession[]> {
    const roots = [
      { path: join(this.home, ".codex", "sessions"), archived: false },
      { path: join(this.home, ".codex", "archived_sessions"), archived: true },
    ];
    const files = new Map<string, { path: string; archived: boolean; modifiedAt: number }>();
    const candidates = (
      await Promise.all(
        roots.map(async (root) => (await walkJsonl(root.path)).map((path) => ({ path, archived: root.archived }))),
      )
    ).flat();
    const snapshots = await mapWithConcurrency(candidates, 32, async (candidate) => {
      try {
        return { ...candidate, modifiedAt: (await stat(candidate.path)).mtimeMs };
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    });
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const id = codexIdFromFilename(snapshot.path);
      if (id) files.set(id, snapshot);
    }
    const entries = await readJsonLines<CodexIndexEntry>(join(this.home, ".codex", "session_index.jsonl"));
    const latest = new Map<string, CodexIndexEntry>();
    for (const entry of entries) {
      if (typeof entry.id !== "string") continue;
      const previous = latest.get(entry.id);
      if (!previous || timestampValue(entry.updated_at) >= timestampValue(previous.updated_at))
        latest.set(entry.id, entry);
    }
    const sessions: IndexedSession[] = [];
    for (const [sourceId, entry] of latest) {
      const file = files.get(sourceId);
      if (!file) continue;
      sessions.push({
        id: `codex:${sourceId}`,
        source: "codex",
        sourceId,
        title: cleanTitle(entry.thread_name, `Codex ${sourceId.slice(0, 8)}`),
        updatedAt: new Date(Math.max(timestampValue(entry.updated_at), file.modifiedAt)).toISOString(),
        ...(file.archived ? { archived: true } : {}),
        path: file.path,
      });
    }
    const unindexed = [...files.entries()].filter(([sourceId]) => !latest.has(sourceId));
    const discovered = await mapWithConcurrency(
      unindexed,
      24,
      async ([sourceId, file]): Promise<IndexedSession | undefined> => {
        const cached = this.discovered.get(file.path);
        if (cached?.modifiedAt === file.modifiedAt) return cached.session;
        const metadata = await discoverCodexSession(file.path);
        const session =
          metadata?.threadSource === "user"
            ? {
                id: `codex:${sourceId}`,
                source: "codex" as const,
                sourceId,
                title: cleanTitle(metadata.title, `Codex ${sourceId.slice(0, 8)}`),
                ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
                updatedAt: new Date(file.modifiedAt).toISOString(),
                ...(file.archived ? { archived: true } : {}),
                path: file.path,
              }
            : undefined;
        this.discovered.set(file.path, { modifiedAt: file.modifiedAt, session });
        return session;
      },
    );
    sessions.push(...discovered.filter((session): session is IndexedSession => session !== undefined));
    return sessions;
  }

  private async loadClaudeIndex(): Promise<IndexedSession[]> {
    const projectsRoot = join(this.home, ".claude", "projects");
    const files = new Map<string, { path: string; modifiedAt: number }>();
    const paths = await walkJsonl(projectsRoot);
    const snapshots = await mapWithConcurrency(paths, 32, async (path) => {
      try {
        return { path, modifiedAt: (await stat(path)).mtimeMs };
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    });
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const id = basename(snapshot.path, ".jsonl");
      if (/^[0-9a-f-]{20,}$/iu.test(id)) files.set(id, snapshot);
    }
    const history = await readJsonLines<ClaudeHistoryEntry>(join(this.home, ".claude", "history.jsonl"));
    const latest = new Map<string, ClaudeHistoryEntry>();
    for (const entry of history) {
      if (typeof entry.sessionId !== "string") continue;
      const previous = latest.get(entry.sessionId);
      if (!previous || timestampValue(entry.timestamp) >= timestampValue(previous.timestamp)) {
        latest.set(entry.sessionId, entry);
      }
    }
    const sessions: IndexedSession[] = [];
    for (const [sourceId, entry] of latest) {
      const file = files.get(sourceId);
      if (!file) continue;
      sessions.push({
        id: `claude:${sourceId}`,
        source: "claude",
        sourceId,
        title: cleanTitle(entry.display, `Claude Code ${sourceId.slice(0, 8)}`),
        ...(typeof entry.project === "string" && entry.project ? { cwd: entry.project } : {}),
        updatedAt: new Date(Math.max(timestampValue(entry.timestamp), file.modifiedAt)).toISOString(),
        path: file.path,
      });
    }
    const unindexed = [...files.entries()].filter(([sourceId]) => !latest.has(sourceId));
    const discovered = await mapWithConcurrency(
      unindexed,
      24,
      async ([sourceId, file]): Promise<IndexedSession | undefined> => {
        const cached = this.discovered.get(file.path);
        if (cached?.modifiedAt === file.modifiedAt) return cached.session;
        const metadata = await discoverClaudeSession(file.path);
        const session = metadata?.title
          ? {
              id: `claude:${sourceId}`,
              source: "claude" as const,
              sourceId,
              title: cleanTitle(metadata.title, `Claude Code ${sourceId.slice(0, 8)}`),
              ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
              updatedAt: new Date(file.modifiedAt).toISOString(),
              path: file.path,
            }
          : undefined;
        this.discovered.set(file.path, { modifiedAt: file.modifiedAt, session });
        return session;
      },
    );
    sessions.push(...discovered.filter((session): session is IndexedSession => session !== undefined));
    return sessions;
  }

  private allowedRoot(source: ExternalSessionSource): string {
    return source === "codex" ? join(this.home, ".codex") : join(this.home, ".claude", "projects");
  }
}

async function parseCodex(path: string, snapshotBytes: number): Promise<ParsedExternalSession> {
  const items: ExternalTranscriptItem[] = [];
  const toolCallIds = new Set<string>();
  let anonymousToolCount = 0;
  let cwd: string | undefined;
  let sourceContextWindow: number | undefined;
  let contextCheckpoint: ParsedExternalSession["contextCheckpoint"];
  await forEachJsonLine(path, snapshotBytes, (row) => {
    const payload = objectField(row, "payload");
    const outerType = stringField(row, "type");
    const type = stringField(payload, "type");
    const timestamp = parseTimestamp(row.timestamp);
    if (outerType === "session_meta") {
      const value = stringField(payload, "cwd");
      if (value) cwd = value;
      return;
    }
    if (outerType === "event_msg" && type === "user_message") {
      pushItem(items, "user", "message", stringField(payload, "message"), timestamp);
      return;
    }
    if (outerType === "event_msg" && type === "agent_message") {
      const kind = stringField(payload, "phase") === "commentary" ? "thinking" : "message";
      pushItem(items, "assistant", kind, stringField(payload, "message"), timestamp);
      return;
    }
    if (outerType === "event_msg" && type === "token_count") {
      const window = positiveInteger(objectField(payload, "info").model_context_window);
      if (window) sourceContextWindow = window;
      return;
    }
    if (outerType === "compacted") {
      const summary = sanitizeVisibleText(stringField(payload, "message")).trim();
      if (summary) contextCheckpoint = { summary, rawTailStartIndex: items.length };
      return;
    }
    if (outerType === "response_item" && isCodexToolRecord(type)) {
      countToolRecord(
        toolCallIds,
        () => {
          anonymousToolCount += 1;
        },
        stringField(payload, "call_id") || stringField(payload, "id"),
      );
      return;
    }
    if (outerType === "event_msg" && type === "mcp_tool_call_end") {
      anonymousToolCount += 1;
    }
  });
  return {
    ...(cwd ? { cwd } : {}),
    items,
    toolCount: toolCallIds.size + anonymousToolCount,
    ...(sourceContextWindow ? { sourceContextWindow } : {}),
    ...(contextCheckpoint ? { contextCheckpoint } : {}),
  };
}

async function discoverCodexSession(
  path: string,
): Promise<{ threadSource?: string; cwd?: string; title?: string } | undefined> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let threadSource: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  try {
    for await (const line of lines) {
      if (!line) continue;
      let row: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!isObject(value)) continue;
        row = value;
      } catch {
        continue;
      }
      const payload = objectField(row, "payload");
      if (stringField(row, "type") === "session_meta") {
        threadSource = stringField(payload, "thread_source") || undefined;
        cwd = stringField(payload, "cwd") || undefined;
        if (threadSource && threadSource !== "user") break;
      } else if (stringField(row, "type") === "event_msg" && stringField(payload, "type") === "user_message") {
        title = stringField(payload, "message") || undefined;
        break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!threadSource && !cwd && !title) return undefined;
  return {
    ...(threadSource ? { threadSource } : {}),
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
  };
}

async function parseClaude(path: string, snapshotBytes: number): Promise<ParsedExternalSession> {
  const items: ExternalTranscriptItem[] = [];
  const toolCallIds = new Set<string>();
  let anonymousToolCount = 0;
  let cwd: string | undefined;
  await forEachJsonLine(path, snapshotBytes, (row) => {
    if (row.isSidechain === true || row.isMeta === true) return;
    const type = stringField(row, "type");
    if (type !== "user" && type !== "assistant") return;
    const rowCwd = stringField(row, "cwd");
    if (rowCwd) cwd = rowCwd;
    const message = objectField(row, "message");
    const timestamp = parseTimestamp(row.timestamp);
    const content = message.content;
    if (typeof content === "string") {
      pushItem(items, type, "message", content, timestamp);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isObject(block)) continue;
      const blockType = stringField(block, "type");
      if (blockType === "text") {
        pushItem(items, type, "message", stringField(block, "text"), timestamp);
      } else if (blockType === "thinking") {
        pushItem(items, "assistant", "thinking", stringField(block, "thinking"), timestamp);
      } else if (blockType === "tool_use") {
        countToolRecord(
          toolCallIds,
          () => {
            anonymousToolCount += 1;
          },
          stringField(block, "id"),
        );
      } else if (blockType === "tool_result") {
        countToolRecord(
          toolCallIds,
          () => {
            anonymousToolCount += 1;
          },
          stringField(block, "tool_use_id"),
        );
      }
    }
  });
  return { ...(cwd ? { cwd } : {}), items, toolCount: toolCallIds.size + anonymousToolCount };
}

async function discoverClaudeSession(path: string): Promise<{ cwd?: string; title?: string } | undefined> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let cwd: string | undefined;
  let title: string | undefined;
  try {
    for await (const line of lines) {
      if (!line) continue;
      let row: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!isObject(value)) continue;
        row = value;
      } catch {
        continue;
      }
      if (row.isSidechain === true || row.isMeta === true) continue;
      const rowCwd = stringField(row, "cwd");
      if (rowCwd) cwd = rowCwd;
      if (stringField(row, "type") !== "user") continue;
      const content = objectField(row, "message").content;
      if (typeof content === "string") title = content;
      else if (Array.isArray(content)) {
        const text = content.find((block) => isObject(block) && stringField(block, "type") === "text");
        if (isObject(text)) title = stringField(text, "text") || undefined;
      }
      if (title) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!title) return undefined;
  return { ...(cwd ? { cwd } : {}), title };
}

function pushItem(
  items: ExternalTranscriptItem[],
  role: "user" | "assistant",
  kind: "message" | "thinking",
  rawText: unknown,
  timestamp?: number,
): void {
  if (typeof rawText !== "string") return;
  const text = sanitizeVisibleText(rawText).trim();
  if (!text) return;
  items.push({ role, kind, text, ...(timestamp === undefined ? {} : { timestamp }) });
}

function isCodexToolRecord(type: string): boolean {
  return (
    type === "function_call" ||
    type === "function_call_output" ||
    type === "custom_tool_call" ||
    type === "custom_tool_call_output" ||
    type.endsWith("_call") ||
    type.endsWith("_call_output")
  );
}

function countToolRecord(ids: Set<string>, countAnonymous: () => void, id: string): void {
  if (id) ids.add(id);
  else countAnonymous();
}

export function sanitizeVisibleText(value: string): string {
  return value
    .replace(AUTHORIZATION_BEARER, "$1[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(COMMON_API_KEY, "[REDACTED]")
    .replace(/\0/gu, "");
}

function coalesceItems(items: ExternalTranscriptItem[]): ExternalTranscriptItem[] {
  const result: ExternalTranscriptItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    if (previous && previous.role === item.role && previous.kind === item.kind) {
      previous.text = `${previous.text}\n\n${item.text}`;
      continue;
    }
    result.push({ ...item });
  }
  return result;
}

async function walkJsonl(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
    }
  }
  await visit(root);
  return output;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function forEachJsonLine(
  path: string,
  snapshotBytes: number,
  callback: (value: Record<string, unknown>) => void,
): Promise<void> {
  if (snapshotBytes <= 0) return;
  const input = createReadStream(path, { encoding: "utf8", end: snapshotBytes - 1 });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isObject(value)) callback(value);
      } catch {
        // Keep the readable prefix/suffix of an append-only history when one row is damaged.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function assertRegularFileWithin(path: string, root: string): Promise<{ size: number; mtimeMs: number }> {
  const [metadata, resolvedRoot, resolvedPath] = await Promise.all([lstat(path), realpath(root), realpath(path)]);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("外部会话不是普通文件");
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(prefix)) throw new Error("外部会话路径越出允许目录");
  return { size: metadata.size, mtimeMs: metadata.mtimeMs };
}

function codexIdFromFilename(path: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/iu.exec(path)?.[1];
}

function cleanTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const title = value.replace(/\s+/gu, " ").trim();
  return title ? Array.from(title).slice(0, 160).join("") : fallback;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        const value = values[index];
        if (value !== undefined) output[index] = await mapper(value);
      }
    }),
  );
  return output;
}

function timestampValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1_000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseTimestamp(value: unknown): number | undefined {
  const timestamp = timestampValue(value);
  return timestamp > 0 ? timestamp : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function withoutPath(session: IndexedSession): ExternalSessionSummary {
  const { path: _path, ...summary } = session;
  return summary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return isObject(field) ? field : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function hasCode(error: unknown, code: string): boolean {
  return isObject(error) && String(error.code) === code;
}
