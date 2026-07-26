import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExternalSessionCatalog, sanitizeVisibleText } from "../src/sessions/external-history.js";

describe("external Session history catalog", () => {
  it("indexes Codex and Claude Code histories and parses only user-visible records", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-external-sessions-"));
    const codexId = "019f9cb1-a2fe-7070-88c7-a823d94e5f77";
    const claudeId = "70e587bd-c285-47fd-af1e-f48dd26c7de8";
    const codexDir = join(home, ".codex", "sessions", "2026", "07", "26");
    const claudeDir = join(home, ".claude", "projects", "-workspace");
    await mkdir(codexDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(home, ".codex", "session_index.jsonl"),
      `${JSON.stringify({ id: codexId, thread_name: "Codex import", updated_at: "2026-07-26T12:00:00Z" })}\n`,
    );
    await writeFile(
      join(codexDir, `rollout-2026-07-26T12-00-00-${codexId}.jsonl`),
      `${[
        { type: "session_meta", timestamp: "2026-07-26T12:00:00Z", payload: { cwd: "/workspace" } },
        { type: "event_msg", timestamp: "2026-07-26T12:00:01Z", payload: { type: "user_message", message: "hello" } },
        {
          type: "response_item",
          timestamp: "2026-07-26T12:00:02Z",
          payload: { type: "reasoning", encrypted_content: "hidden" },
        },
        {
          type: "response_item",
          timestamp: "2026-07-26T12:00:03Z",
          payload: { type: "function_call", name: "bash", arguments: '{"command":"pwd"}' },
        },
        {
          type: "response_item",
          timestamp: "2026-07-26T12:00:04Z",
          payload: { type: "function_call_output", output: "api_key=top-secret" },
        },
        {
          type: "event_msg",
          timestamp: "2026-07-26T12:00:04Z",
          payload: {
            type: "mcp_tool_call_end",
            invocation: { server: "docs", tool: "search", arguments: { query: "history" } },
            result: { Ok: { content: "found" } },
          },
        },
        {
          type: "response_item",
          timestamp: "2026-07-26T12:00:04Z",
          payload: { type: "web_search_call", action: { query: "VSPi" } },
        },
        { type: "event_msg", timestamp: "2026-07-26T12:00:05Z", payload: { type: "agent_message", message: "done" } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    await writeFile(
      join(home, ".claude", "history.jsonl"),
      `${JSON.stringify({ display: "Claude import", project: "/workspace", sessionId: claudeId, timestamp: 1_785_076_800_000 })}\n`,
    );
    await writeFile(
      join(claudeDir, `${claudeId}.jsonl`),
      `${[
        {
          type: "user",
          uuid: "u1",
          cwd: "/workspace",
          timestamp: "2026-07-26T12:00:00Z",
          message: { content: "hello" },
        },
        {
          type: "assistant",
          uuid: "a1",
          cwd: "/workspace",
          timestamp: "2026-07-26T12:00:01Z",
          message: {
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "working" },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "side",
          isSidechain: true,
          message: { content: [{ type: "text", text: "sidechain" }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );

    const catalog = new ExternalSessionCatalog(home);
    const sessions = await catalog.list();
    expect(sessions.map((session) => session.title)).toEqual(["Claude import", "Codex import"]);

    const codex = await catalog.preview(`codex:${codexId}`);
    expect(codex.cwd).toBe("/workspace");
    expect(codex.snapshotBytes).toBeGreaterThan(0);
    expect(codex.snapshotModifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(codex.items).toEqual([
      expect.objectContaining({ role: "user", kind: "message", text: "hello" }),
      expect.objectContaining({
        role: "assistant",
        kind: "tool",
        text: expect.stringMatching(/Tool · bash[\s\S]*\[REDACTED\][\s\S]*MCP docs\/search[\s\S]*web search/u),
      }),
      expect.objectContaining({ role: "assistant", kind: "message", text: "done" }),
    ]);
    expect(codex.items.map((item) => item.text).join("\n")).not.toContain("hidden");

    const claude = await catalog.preview(`claude:${claudeId}`);
    expect(claude.items).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({ role: "assistant", text: "working" }),
    ]);
  });

  it("does not index symlinked source files", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-external-symlink-"));
    const id = "019f9cb1-a2fe-7070-88c7-a823d94e5f77";
    const sessionDir = join(home, ".codex", "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(home, ".codex", "session_index.jsonl"),
      `${JSON.stringify({ id, thread_name: "Unsafe", updated_at: "2026-07-26T12:00:00Z" })}\n`,
    );
    const outside = join(home, "outside.jsonl");
    await writeFile(
      outside,
      `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "x" } })}\n`,
    );
    await symlink(outside, join(sessionDir, `rollout-${id}.jsonl`));

    expect(await new ExternalSessionCatalog(home).list()).toEqual([]);
  });

  it("discovers unindexed Codex user threads while excluding subagent rollouts", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-unindexed-codex-"));
    const sessionDir = join(home, ".codex", "sessions", "2026", "07", "26");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "rollout-019f9486-7c29-7f83-9972-e5e6c8950ca7.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { cwd: "/workspace", thread_source: "user" },
        },
        { type: "event_msg", payload: { type: "user_message", message: "Unindexed user thread" } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    await writeFile(
      join(sessionDir, "rollout-019f9486-7c29-7f83-9972-e5e6c8950ca8.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { cwd: "/workspace", thread_source: "subagent" },
        },
        { type: "event_msg", payload: { type: "user_message", message: "Internal worker" } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );

    const sessions = await new ExternalSessionCatalog(home).list();
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "codex:019f9486-7c29-7f83-9972-e5e6c8950ca7",
        title: "Unindexed user thread",
        cwd: "/workspace",
      }),
    ]);
  });

  it("discovers unindexed Claude Code main sessions while excluding agent files", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-unindexed-claude-"));
    const sessionDir = join(home, ".claude", "projects", "-workspace");
    await mkdir(sessionDir, { recursive: true });
    const id = "05f6fd79-5ee9-4b77-ac44-fb0f57a08625";
    const visible = {
      type: "user",
      cwd: "/workspace",
      message: { content: [{ type: "text", text: "Unindexed Claude thread" }] },
    };
    await writeFile(join(sessionDir, `${id}.jsonl`), `${JSON.stringify(visible)}\n`);
    await writeFile(join(sessionDir, "agent-a00daa3ccb9406000.jsonl"), `${JSON.stringify(visible)}\n`);

    expect(await new ExternalSessionCatalog(home).list({ source: "claude" })).toEqual([
      expect.objectContaining({
        id: `claude:${id}`,
        title: "Unindexed Claude thread",
        cwd: "/workspace",
      }),
    ]);
  });

  it("redacts common credential forms from visible tool output", () => {
    expect(sanitizeVisibleText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: [REDACTED]");
    expect(sanitizeVisibleText('{"password":"value"}')).toBe('{"password":"[REDACTED]"}');
    expect(sanitizeVisibleText("sk-abcdefghijklmnopqrstuvwxyz123456")).toBe("[REDACTED]");
  });
});
