import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import type { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

/**
 * 命令输入路径回归：命令面板不得拦截带参数输入的 Enter（参数会被丢弃），
 * 以 “/” 开头但非命令的内容（路径等）必须能作为普通消息发送，未匹配命令不再报错。
 */

const ENTER = "\r";

function fakeTui(): TUI {
  return {
    terminal: { columns: 100, rows: 30, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  } as unknown as AttachmentService;
}

function backend(overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    kind: "fixture",
    modelLabel: "Test Model",
    modelId: "test-model",
    supportsVision: true,
    start: vi.fn(async (_events: ChatBackendEvents) => undefined),
    send: vi.fn(async () => ({ status: "completed" as const })),
    cancel: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

type TestableApp = { panels: PanelController };

function asTestable(app: VspiApp): TestableApp {
  return app as unknown as TestableApp;
}

async function createApp(overrides: Partial<ChatBackend> = {}): Promise<VspiApp> {
  const app = new VspiApp(fakeTui(), plainTheme(), backend(overrides), {
    cwd: "/tmp/command-paths",
    settings: { ...DEFAULT_SETTINGS },
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  return app;
}

async function typeAndEnter(app: VspiApp, text: string): Promise<void> {
  for (const character of text) app.handleInput(character);
  await new Promise((resolve) => setImmediate(resolve));
  app.handleInput(ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function renderedText(app: VspiApp): string {
  return app.render(100).map(stripAnsi).join("\n");
}

describe("命令输入路径", () => {
  it("带参数的 /goal 命令 Enter 走 composer 完整提交，参数保留", async () => {
    const createGoal = vi.fn(async () => {
      throw new Error("unexpected createGoal");
    });
    const getGoal = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ status: "completed" as const }));
    const app = await createApp({ createGoal, getGoal, send });
    try {
      await typeAndEnter(app, "/goal status");

      expect(asTestable(app).panels.kind).toBe("goal");
      expect(createGoal).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(app.composer.getText()).toBe("");
    } finally {
      await app.dispose();
    }
  });

  it("以 / 开头的路径作为普通消息发送，不再报未知命令", async () => {
    const send = vi.fn(async () => ({ status: "completed" as const }));
    const app = await createApp({ send });
    try {
      await typeAndEnter(app, "/home/user/project");

      expect(send).toHaveBeenCalledWith("/home/user/project", expect.anything());
      const rendered = renderedText(app);
      expect(rendered).not.toContain("未知命令");
    } finally {
      await app.dispose();
    }
  });

  it("// 转义发送字面 / 消息，且不弹命令面板", async () => {
    const send = vi.fn(async () => ({ status: "completed" as const }));
    const app = await createApp({ send });
    try {
      for (const character of "//goal hello") app.handleInput(character);
      await new Promise((resolve) => setImmediate(resolve));
      expect(asTestable(app).panels.kind).not.toBe("commands");

      app.handleInput(ENTER);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(send).toHaveBeenCalledWith("/goal hello", expect.anything());
      expect(app.composer.getText()).toBe("");
    } finally {
      await app.dispose();
    }
  });

  it("纯命令 token 的 Enter 仍由命令面板激活（补全语义保留）", async () => {
    const app = await createApp();
    try {
      await typeAndEnter(app, "/goa");

      expect(asTestable(app).panels.kind).toBe("goal");
      expect(app.composer.getText()).toBe("");
    } finally {
      await app.dispose();
    }
  });
});
