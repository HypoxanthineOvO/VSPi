import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { COMMANDS, getActionDefinition, resolveCommand } from "../src/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE, PROVIDERS } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

interface EditorHistoryAccess {
  history: string[];
}

function fakeTui(): TUI {
  return {
    terminal: { columns: 80, rows: 24, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function fakeBackend(): ChatBackend & {
  send: ReturnType<typeof vi.fn>;
  compact: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  switchSession: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => {});
  const compact = vi.fn(async () => {});
  const newSession = vi.fn(async () => {});
  const listSessions = vi.fn(async () => []);
  const switchSession = vi.fn(async () => {});
  return {
    kind: "fixture",
    modelLabel: "M1 Action Fixture",
    modelId: "m1-action-fixture",
    supportsVision: false,
    start: vi.fn(async (_events: ChatBackendEvents) => {}),
    send,
    cancel: vi.fn(async () => {}),
    compact,
    newSession,
    listSessions,
    switchSession,
    dispose: vi.fn(async () => {}),
  };
}

async function createApp(
  selfUpdate?: (currentVersion: string) => Promise<{
    status: "up-to-date" | "updated";
    currentVersion: string;
    latestVersion: string;
  }>,
) {
  const backend = fakeBackend();
  const onExit = vi.fn();
  const app = new VspiApp(fakeTui(), plainTheme(), backend, {
    cwd: "/workspace/m1-actions",
    settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
    attachments: fakeAttachments(),
    renderOnce: true,
    ...(selfUpdate ? { selfUpdate } : {}),
    onExit,
  });
  await app.start();
  return { app, backend, onExit };
}

function history(app: VspiApp): string[] {
  return [...(app.composer.editor as unknown as EditorHistoryAccess).history];
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("M1 production action contract", () => {
  it("publishes every canonical command and removes deferred Demo entries", () => {
    const productionLabels = COMMANDS.filter((command) => command.group === "VSPi").map((command) => command.label);

    expect(productionLabels).toEqual(
      expect.arrayContaining([
        "/new",
        "/sessions",
        "/compact",
        "/update",
        "/model",
        "/providers",
        "/plan",
        "/prompt",
        "/thinking",
        "/effort",
        "/policy",
        "/usage",
        "/settings",
        "/theme",
        "/quit",
      ]),
    );
    expect(COMMANDS.map((command) => command.label)).not.toEqual(
      expect.arrayContaining(["/demo-question", "/demo-tool"]),
    );
    expect(resolveCommand("/thinking")?.id).toBe("thinking");
    expect(resolveCommand("/effort")?.id).toBe("effort");
  });

  it("executes /update through the injected production update boundary", async () => {
    const selfUpdate = vi.fn(async (currentVersion: string) => ({
      status: "updated" as const,
      currentVersion,
      latestVersion: "9.9.9",
    }));
    const { app, backend } = await createApp(selfUpdate);
    try {
      await app.runStartupCommand("/update");
      const rendered = app.render(80).map(stripAnsi).join("\n");

      expect(selfUpdate).toHaveBeenCalledOnce();
      expect(rendered).toContain("已更新到 VSPi 9.9.9，重启后生效");
      expect(backend.send).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });

  it("resolves the approved aliases to their canonical actions", () => {
    expect(resolveCommand("/clear")?.id).toBe("new");
    expect(resolveCommand("/session")?.id).toBe("sessions");
    expect(resolveCommand("/resume")?.id).toBe("sessions");
    expect(resolveCommand("/provider")?.id).toBe("providers");
    expect(resolveCommand("/permission")?.id).toBe("policy");
    expect(resolveCommand("/exit")?.id).toBe("quit");
    expect(resolveCommand("/q")?.id).toBe("quit");
  });

  it.each([
    ["/ses", "/sessions"],
    ["/provi", "/providers"],
    ["/ex", "/exit"],
    ["/cl", "/clear"],
  ] as const)("Tab-completes %s without executing it or writing history", async (input, expected) => {
    const { app, backend, onExit } = await createApp();
    try {
      app.composer.editor.addToHistory("existing history");
      const before = history(app);
      app.composer.setText(input);

      app.handleInput("\t");

      expect(app.composer.getText()).toBe(expected);
      expect(history(app)).toEqual(before);
      expect(onExit).not.toHaveBeenCalled();
      expect(backend.send).not.toHaveBeenCalled();
      expect(backend.compact).not.toHaveBeenCalled();
      expect(backend.newSession).not.toHaveBeenCalled();
      expect(backend.switchSession).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });

  it("executes the enabled /plan handler by opening the real Plan workspace", async () => {
    const action = getActionDefinition("plan");
    expect(action).toMatchObject({ availability: "enabled", handler: "plan" });
    expect(action?.disabledReason).toBeUndefined();

    const { app, backend } = await createApp();
    try {
      app.composer.setText("/plan");
      app.handleInput("\r");
      await flush();
      const rendered = app.render(80).map(stripAnsi).join("\n");

      expect(rendered).not.toContain("未知命令：/plan");
      expect(rendered).toContain("Plan");
      expect(rendered).not.toMatch(/Workflow|当前计划为空/);
      expect(rendered).not.toMatch(/暂未|尚未|未接入|不可用|后续里程碑|disabled/i);
      expect(backend.send).not.toHaveBeenCalled();
      expect(backend.compact).not.toHaveBeenCalled();
      expect(backend.newSession).not.toHaveBeenCalled();
      expect(backend.listSessions).not.toHaveBeenCalled();
      expect(backend.switchSession).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });

  it("executes the enabled /prompt handler by opening the real Prompt Profile panel", async () => {
    const action = getActionDefinition("prompt");
    expect(action).toMatchObject({ availability: "enabled", handler: "prompt" });
    expect(action?.disabledReason).toBeUndefined();

    const { app, backend } = await createApp();
    try {
      app.composer.setText("/prompt");
      app.handleInput("\r");
      await flush();
      const rendered = app.render(80).map(stripAnsi).join("\n");

      expect(rendered).toContain("Prompt Profile");
      expect(rendered).toContain("Off");
      expect(rendered).not.toMatch(/暂未接入|不可用|后续里程碑|disabled/i);
      expect(backend.send).not.toHaveBeenCalled();
      expect(backend.compact).not.toHaveBeenCalled();
      expect(backend.newSession).not.toHaveBeenCalled();
      expect(backend.listSessions).not.toHaveBeenCalled();
      expect(backend.switchSession).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });

  it("executes /permission through the same enabled Policy handler", async () => {
    const action = getActionDefinition("policy");
    expect(action).toMatchObject({ availability: "enabled", handler: "policy" });
    expect(action?.disabledReason).toBeUndefined();

    const { app, backend } = await createApp();
    try {
      app.composer.setText("/permission");
      app.handleInput("\r");
      await flush();
      const rendered = app.render(80).map(stripAnsi).join("\n");

      expect(rendered).toContain("Policy");
      expect(rendered).toMatch(/Safe[\s\S]*Standard[\s\S]*Auto[\s\S]*YOLO/);
      expect(rendered).not.toMatch(/暂未接入|不可用|后续里程碑|disabled/i);
      expect(backend.send).not.toHaveBeenCalled();
      expect(backend.compact).not.toHaveBeenCalled();
      expect(backend.newSession).not.toHaveBeenCalled();
      expect(backend.switchSession).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });

  it("keeps a representative contextual hint aligned with its executable action", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    const provider = PROVIDERS[0];
    if (!provider) throw new Error("provider fixture is required");
    panel.setProviders([provider]);
    panel.open("providers");

    const hint = stripAnsi(panel.renderHint(80, plainTheme()));
    const event = panel.handleInput("\r");

    expect(hint).toContain("Enter");
    expect(event).toMatchObject({ type: "providerActions" });
    expect(panel.render(80, 12, plainTheme(), DEFAULT_USAGE).every((line) => stripAnsi(line).length > 0)).toBe(true);
  });
});
