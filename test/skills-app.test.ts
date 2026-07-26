import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { SkillCatalogSnapshot } from "../src/skills/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { plainTheme } from "./helpers.js";

describe("Skill application flow", () => {
  it("opens locally, confirms install-only, and submits Agent search as an ordinary message", async () => {
    const installSkill = vi.fn(async (source: string, scope: "user" | "project", enabled: boolean) => ({
      source,
      scope,
      enabled,
      skills: ["ci-review"],
    }));
    const send = vi.fn(async () => ({ status: "completed" as const }));
    const backend = createBackend({ installSkill, send });
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace",
      settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
      attachments: fakeAttachments(),
      renderOnce: true,
      onExit: vi.fn(),
    });
    await app.start();

    await app.runStartupCommand("/skills");
    expect(app.render(100).map(stripAnsi).join("\n")).toContain("ci-review");

    app.handleInput("+");
    app.handleInput("https://github.com/example/skills.git");
    app.handleInput("\r");
    await flush();
    expect(app.render(100).map(stripAnsi).join("\n")).toContain("仅安装");
    app.handleInput("\u001b[B");
    app.handleInput("\r");
    app.handleInput("\r");
    await flush();
    expect(installSkill).toHaveBeenCalledWith("https://github.com/example/skills.git", "user", false);

    await app.runStartupCommand("/skills");
    app.handleInput("+");
    app.handleInput("\t");
    app.handleInput("适合长期维护 TypeScript CLI 的 CI review");
    app.handleInput("\r");
    await flush();
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining("适合长期维护 TypeScript CLI 的 CI review"),
      expect.any(Object),
    );
    await app.dispose();
  });
});

function createBackend(input: { installSkill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }): ChatBackend {
  const snapshot: SkillCatalogSnapshot = {
    projectTrusted: true,
    issues: [],
    items: [
      {
        id: "ci-review",
        name: "ci-review",
        description: "Review CI failures",
        filePath: "/skills/ci-review/SKILL.md",
        source: "pi",
        sourceLabel: "Pi",
        scope: "user",
        enabled: true,
        installed: true,
        disableModelInvocation: false,
        actions: ["disable"],
      },
    ],
  };
  return {
    kind: "pi",
    modelLabel: "Fixture",
    modelId: "fixture",
    supportsVision: false,
    start: vi.fn(async (events: ChatBackendEvents) => {
      events.onSessionReset?.({ id: "initial", reason: "startup" });
      events.onUsage(DEFAULT_USAGE);
    }),
    send: input.send,
    cancel: vi.fn(async () => ({ queuedMessages: [] })),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    listSkills: vi.fn(async () => snapshot),
    installSkill: input.installSkill,
    isProjectTrusted: () => true,
    dispose: vi.fn(async () => {}),
  } as ChatBackend;
}

function fakeTui(): TUI {
  return {
    terminal: { rows: 28, columns: 100, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
