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
  kind: "message" | "tool";
  text: string;
  timestamp?: number;
}

export interface ExternalSessionPreview extends ExternalSessionSummary {
  items: ExternalTranscriptItem[];
  messageCount: number;
  toolCount: number;
  estimatedTokens: number;
  fingerprint: string;
  snapshotBytes: number;
  snapshotModifiedAt: string;
}

interface IndexedSession extends ExternalSessionSummary {
  path: string;
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

const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/giu;
const AUTHORIZATION_BEARER = /(authorization["']?\s*[:=]\s*["']?)Bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const COMMON_API_KEY = /\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{12,}\b/gu;

export class ExternalSessionCatalog {
  private sessions: IndexedSession[] | undefined;

  constructor(private readonly home = homedir()) {}

  async list(
    options: { source?: ExternalSessionSource; query?: string; limit?: number } = {},
  ): Promise<ExternalSessionSummary[]> {
    const sessions = await this.loadIndex();
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
    const items = coalesceItems(parsed.items);
    const normalized = items.map((item) => `${item.role}\0${item.kind}\0${item.text}`).join("\n");
    const summary = parsed.cwd ? { ...session, cwd: parsed.cwd } : session;
    return {
      ...withoutPath(summary),
      items,
      messageCount: items.filter((item) => item.kind === "message").length,
      toolCount: items.filter((item) => item.kind === "tool").length,
      estimatedTokens: Math.ceil(items.reduce((total, item) => total + item.text.length, 0) / 3),
      fingerprint: createHash("sha256").update(normalized).digest("hex"),
      snapshotBytes: snapshot.size,
      snapshotModifiedAt: new Date(snapshot.mtimeMs).toISOString(),
    };
  }

  invalidate(): void {
    this.sessions = undefined;
  }

  private async loadIndex(): Promise<IndexedSession[]> {
    if (this.sessions) return this.sessions;
    const [codex, claude] = await Promise.all([this.loadCodexIndex(), this.loadClaudeIndex()]);
    this.sessions = [...codex, ...claude].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id),
    );
    return this.sessions;
  }

  private async loadCodexIndex(): Promise<IndexedSession[]> {
    const roots = [
      { path: join(this.home, ".codex", "sessions"), archived: false },
      { path: join(this.home, ".codex", "archived_sessions"), archived: true },
    ];
    const files = new Map<string, { path: string; archived: boolean; modifiedAt: number }>();
    for (const root of roots) {
      for (const path of await walkJsonl(root.path)) {
        const id = codexIdFromFilename(path);
        if (id) files.set(id, { path, archived: root.archived, modifiedAt: (await stat(path)).mtimeMs });
      }
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
        const metadata = await discoverCodexSession(file.path);
        if (!metadata || metadata.threadSource !== "user") return undefined;
        return {
          id: `codex:${sourceId}`,
          source: "codex",
          sourceId,
          title: cleanTitle(metadata.title, `Codex ${sourceId.slice(0, 8)}`),
          ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
          updatedAt: new Date(file.modifiedAt).toISOString(),
          ...(file.archived ? { archived: true } : {}),
          path: file.path,
        };
      },
    );
    sessions.push(...discovered.filter((session): session is IndexedSession => session !== undefined));
    return sessions;
  }

  private async loadClaudeIndex(): Promise<IndexedSession[]> {
    const projectsRoot = join(this.home, ".claude", "projects");
    const files = new Map<string, { path: string; modifiedAt: number }>();
    for (const path of await walkJsonl(projectsRoot)) {
      const id = basename(path, ".jsonl");
      if (/^[0-9a-f-]{20,}$/iu.test(id)) files.set(id, { path, modifiedAt: (await stat(path)).mtimeMs });
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
        const metadata = await discoverClaudeSession(file.path);
        if (!metadata?.title) return undefined;
        return {
          id: `claude:${sourceId}`,
          source: "claude",
          sourceId,
          title: cleanTitle(metadata.title, `Claude Code ${sourceId.slice(0, 8)}`),
          ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
          updatedAt: new Date(file.modifiedAt).toISOString(),
          path: file.path,
        };
      },
    );
    sessions.push(...discovered.filter((session): session is IndexedSession => session !== undefined));
    return sessions;
  }

  private allowedRoot(source: ExternalSessionSource): string {
    return source === "codex" ? join(this.home, ".codex") : join(this.home, ".claude", "projects");
  }
}

async function parseCodex(
  path: string,
  snapshotBytes: number,
): Promise<{ cwd?: string; items: ExternalTranscriptItem[] }> {
  const items: ExternalTranscriptItem[] = [];
  let cwd: string | undefined;
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
      pushItem(items, "assistant", "message", stringField(payload, "message"), timestamp);
      return;
    }
    if (outerType === "response_item" && (type === "function_call" || type === "custom_tool_call")) {
      const name = stringField(payload, "name") || "tool";
      pushItem(items, "assistant", "tool", renderToolCall(name, payload.arguments ?? payload.input), timestamp);
      return;
    }
    if (outerType === "response_item" && (type === "function_call_output" || type === "custom_tool_call_output")) {
      pushItem(items, "assistant", "tool", renderToolOutput(payload.output), timestamp);
      return;
    }
    if (outerType === "response_item" && type.endsWith("_call_output")) {
      pushItem(items, "assistant", "tool", renderToolOutput(payload.output ?? payload), timestamp);
      return;
    }
    if (outerType === "response_item" && type.endsWith("_call")) {
      const name = stringField(payload, "name") || type.slice(0, -"_call".length).replaceAll("_", " ");
      pushItem(
        items,
        "assistant",
        "tool",
        renderToolCall(name, payload.arguments ?? payload.input ?? payload.action ?? payload),
        timestamp,
      );
      return;
    }
    if (outerType === "event_msg" && type === "mcp_tool_call_end") {
      const invocation = objectField(payload, "invocation");
      const server = stringField(invocation, "server");
      const tool = stringField(invocation, "tool") || "tool";
      const name = server ? `MCP ${server}/${tool}` : `MCP ${tool}`;
      const call = renderToolCall(name, invocation.arguments);
      const result = renderToolOutput(payload.result);
      pushItem(items, "assistant", "tool", `${call}\n\n${result}`, timestamp);
    }
  });
  return { ...(cwd ? { cwd } : {}), items };
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

async function parseClaude(
  path: string,
  snapshotBytes: number,
): Promise<{ cwd?: string; items: ExternalTranscriptItem[] }> {
  const items: ExternalTranscriptItem[] = [];
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
      } else if (blockType === "tool_use") {
        pushItem(
          items,
          "assistant",
          "tool",
          renderToolCall(stringField(block, "name") || "tool", block.input),
          timestamp,
        );
      } else if (blockType === "tool_result") {
        pushItem(items, "assistant", "tool", renderToolOutput(block.content), timestamp);
      }
    }
  });
  return { ...(cwd ? { cwd } : {}), items };
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
  kind: "message" | "tool",
  rawText: unknown,
  timestamp?: number,
): void {
  if (typeof rawText !== "string") return;
  const text = sanitizeVisibleText(rawText).trim();
  if (!text) return;
  items.push({ role, kind, text, ...(timestamp === undefined ? {} : { timestamp }) });
}

function renderToolCall(name: string, input: unknown): string {
  const detail = stringifyVisible(input);
  return detail ? `Tool · ${name}\n${detail}` : `Tool · ${name}`;
}

function renderToolOutput(output: unknown): string {
  const detail = stringifyVisible(output);
  return detail ? `Tool Result\n${detail}` : "Tool Result";
}

function stringifyVisible(value: unknown): string {
  if (typeof value === "string") return sanitizeVisibleText(value);
  if (value === undefined || value === null) return "";
  try {
    return sanitizeVisibleText(JSON.stringify(value, null, 2));
  } catch {
    return "[无法序列化的可见输出]";
  }
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
