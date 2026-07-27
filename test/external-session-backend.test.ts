import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../src/backend/types.js";
import type { ExternalSessionPreview } from "../src/sessions/external-history.js";

describe("external Session backend import", () => {
  it("stores foreign history as an inert reference while preserving the active model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-import-backend-"));
    const sessionDir = join(cwd, "sessions");
    const managers: SessionManager[] = [];
    const resets: Array<{ id: string; reason: string }> = [];
    const transcript: Array<{ kind?: string; text?: string }> = [];
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
        return { session: fakeSession(manager) };
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
            source: "codex",
            sourceId: "source-id",
            fingerprint: "f".repeat(64),
            snapshotBytes: 4_096,
          }),
        }),
      ]),
    );
    const branch = imported?.getBranch() ?? [];
    expect(branch.filter((entry) => entry.type === "message")).toEqual([]);
    expect(branch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "model_change", provider: "fixture", modelId: "fixture" }),
        expect.objectContaining({
          type: "custom_message",
          customType: "vspi.external-session-reference",
          display: false,
          content: expect.stringMatching(/只读历史快照[\s\S]*不可执行[\s\S]*codex_only_tool/u),
        }),
      ]),
    );
    expect(imported?.buildSessionContext().model).toEqual({ provider: "fixture", modelId: "fixture" });
    expect(imported?.buildSessionContext().messages).toEqual([
      expect.objectContaining({ role: "custom", customType: "vspi.external-session-reference" }),
    ]);
    expect(JSON.stringify(branch)).not.toMatch(/codex-import|external-history/u);
    expect(resets.at(-1)?.reason).toBe("import");
    expect(transcript.at(-1)).toMatchObject({
      kind: "session",
      text: "只读参考 · Codex · Imported thread · 2 条对话 · 1 条工具记录",
    });
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
      { role: "assistant", kind: "tool", text: 'Tool · codex_only_tool\n{"path":"/tmp"}', timestamp: 2 },
      { role: "assistant", kind: "message", text: "Answer", timestamp: 3 },
    ],
    messageCount: 2,
    toolCount: 1,
    estimatedTokens: 20,
    fingerprint: "f".repeat(64),
    snapshotBytes: 4_096,
    snapshotModifiedAt: "2026-07-26T12:00:00.000Z",
  };
}

function fakeSession(manager: SessionManager): AgentSession {
  const session = {
    model: {
      id: "fixture",
      name: "Fixture",
      provider: "fixture",
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
    prompt: async () => {},
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
