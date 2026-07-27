import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../src/backend/types.js";
import type { ExternalSessionPreview } from "../src/sessions/external-history.js";

describe("external Session backend import", () => {
  it("imports full visible history, excludes tools, and resumes from the source checkpoint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-import-backend-"));
    const sessionDir = join(cwd, "sessions");
    const managers: SessionManager[] = [];
    const resets: Array<{ id: string; reason: string }> = [];
    const transcript: Array<{ kind?: string; text?: string }> = [];
    const prompt = vi.fn(async () => {});
    const preview = externalPreview();
    const backend = new PiBackend({
      cwd,
      sessionDir,
      sessionLeases: false,
      externalSessions: {
        list: vi.fn(async () => [preview]),
        preview: vi.fn(async () => preview),
      },
      sessionFactory: async (manager) => {
        managers.push(manager);
        return { session: fakeSession(manager, prompt) };
      },
    });
    await backend.start(
      events({
        onSessionReset: (session) => resets.push(session),
        onMessage: (message) => transcript.push(message),
      }),
    );

    await backend.importExternalSession("codex:source-id", preview.fingerprint);

    expect(managers).toHaveLength(2);
    const imported = managers[1];
    expect(imported?.getSessionName()).toBe("Imported thread");
    expect(imported?.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          customType: "vspi.external-session-import",
          data: expect.objectContaining({
            version: 3,
            source: "codex",
            sourceId: "source-id",
            fingerprint: "f".repeat(64),
            snapshotBytes: 4_096,
            policy: "native-visible-checkpoint-context-v3",
            visibleItemCount: 5,
            contextItemCount: 2,
            contextStrategy: "codex-checkpoint",
            contextWindow: 100_000,
          }),
        }),
      ]),
    );
    const branch = imported?.getBranch() ?? [];
    expect(
      branch
        .filter((entry) => entry.type === "message")
        .map((entry) => (entry.type === "message" ? entry.message.role : "")),
    ).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(branch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "model_change", provider: "fixture", modelId: "fixture" }),
        expect.objectContaining({
          type: "compaction",
          summary: "Prior decision summary",
          firstKeptEntryId: expect.any(String),
          fromHook: true,
          details: expect.objectContaining({ omittedToolCount: 1, strategy: "codex-checkpoint" }),
        }),
      ]),
    );
    expect(imported?.buildSessionContext().model).toEqual({ provider: "fixture", modelId: "fixture" });
    expect(imported?.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(imported?.buildSessionContext().messages)).toContain("Prior decision summary");
    expect(JSON.stringify(imported?.buildSessionContext().messages)).not.toMatch(
      /codex_only_tool|Question|Inspect files/u,
    );
    expect(resets.at(-1)?.reason).toBe("import");
    expect(transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "session", text: expect.stringContaining("从 Codex 导入") }),
        expect.objectContaining({ kind: "text", text: "Question" }),
        expect.objectContaining({ kind: "thinking", text: "Inspect files" }),
        expect.objectContaining({ kind: "text", text: "Answer" }),
        expect.objectContaining({ kind: "text", text: "Latest question" }),
        expect.objectContaining({ kind: "thinking", text: "Continue work" }),
      ]),
    );
    expect(transcript.some((message) => message.kind === "tool")).toBe(false);

    await expect(
      backend.send("Continue", { attachments: [], effort: "medium", behavior: "prompt" }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(prompt).toHaveBeenCalledWith("Continue", expect.objectContaining({ source: "interactive" }));
    await backend.dispose();
  });

  it("keeps the current Session when preview parsing fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-import-failure-"));
    const managers: SessionManager[] = [];
    const backend = new PiBackend({
      cwd,
      sessionLeases: false,
      externalSessions: {
        list: vi.fn(async () => []),
        preview: vi.fn(async () => {
          throw new Error("damaged history");
        }),
      },
      sessionFactory: async (manager) => {
        managers.push(manager);
        return { session: fakeSession(manager) };
      },
    });
    await backend.start(events());
    const sessionId = managers[0]?.getSessionId();

    await expect(backend.importExternalSession("codex:bad", "f".repeat(64))).rejects.toThrow("damaged history");
    expect(managers).toHaveLength(1);
    expect(managers[0]?.getSessionId()).toBe(sessionId);
    await backend.dispose();
  });

  it("retries when the visible source changed after it was read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-import-changed-"));
    const managers: SessionManager[] = [];
    const backend = new PiBackend({
      cwd,
      sessionLeases: false,
      externalSessions: {
        list: vi.fn(async () => []),
        preview: vi.fn(async () => ({ ...externalPreview(), fingerprint: "a".repeat(64) })),
      },
      sessionFactory: async (manager) => {
        managers.push(manager);
        return { session: fakeSession(manager) };
      },
    });
    await backend.start(events());

    await expect(backend.importExternalSession("codex:source-id", "b".repeat(64))).rejects.toThrow(
      "源会话在读取后已经更新",
    );
    expect(managers).toHaveLength(1);
    await backend.dispose();
  });
});

function externalPreview(): ExternalSessionPreview {
  return {
    id: "codex:source-id",
    source: "codex",
    sourceId: "source-id",
    title: "Imported thread",
    cwd: "/source/project",
    updatedAt: "2026-07-26T12:00:00.000Z",
    items: [
      { role: "user", kind: "message", text: "Question", timestamp: 1 },
      { role: "assistant", kind: "thinking", text: "Inspect files", timestamp: 2 },
      { role: "assistant", kind: "message", text: "Answer", timestamp: 3 },
      { role: "user", kind: "message", text: "Latest question", timestamp: 4 },
      { role: "assistant", kind: "thinking", text: "Continue work", timestamp: 5 },
    ],
    messageCount: 3,
    toolCount: 1,
    estimatedTokens: 20,
    sourceContextWindow: 353_400,
    contextCheckpoint: {
      summary: "Prior decision summary",
      tailStartIndex: 3,
      sourceContextWindow: 353_400,
    },
    fingerprint: "f".repeat(64),
    snapshotBytes: 4_096,
    snapshotModifiedAt: "2026-07-26T12:00:00.000Z",
  };
}

function fakeSession(manager: SessionManager, prompt = vi.fn(async () => {})): AgentSession {
  const session = {
    model: {
      id: "fixture",
      name: "Fixture",
      provider: "fixture",
      api: "openai-completions",
      input: ["text"],
      contextWindow: 100_000,
    },
    messages: manager.buildSessionContext().messages,
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    thinkingLevel: "medium",
    isStreaming: false,
    subscribe: () => () => {},
    setThinkingLevel: () => {},
    getAvailableThinkingLevels: () => ["off", "medium", "high"],
    prompt,
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => {},
    abortCompaction: () => {},
    getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
    getSessionStats: () => ({
      sessionFile: manager.getSessionFile(),
      sessionId: manager.getSessionId(),
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
    dispose: () => {},
  };
  return session as unknown as AgentSession;
}

function events(overrides: Partial<ChatBackendEvents> = {}): ChatBackendEvents {
  return {
    onMessage: () => {},
    onMessageUpdate: () => {},
    onBusy: () => {},
    onUsage: () => {},
    onNotice: () => {},
    ...overrides,
  };
}
