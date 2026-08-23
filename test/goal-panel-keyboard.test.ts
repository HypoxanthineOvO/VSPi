import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp, type VspiAppOptions } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import type { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

/**
 * 键盘路径回归：此前 /goal（无参数）回车后打开的 Goal 面板没有任何交互注册，
 * handleInput 又把非 plan/commands 面板当模态处理，导致打字、Enter、Esc 全部被吞。
 * 这些用例必须从真实 handleInput 按键流驱动，不能直接调 submit()。
 */

const ESCAPE = "\x1b";
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
    cwd: "/tmp/goal-keyboard",
    settings: { ...DEFAULT_SETTINGS },
    attachments: fakeAttachments(),
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  return app;
}

async function type(app: VspiApp, text: string): Promise<void> {
  for (const character of text) app.handleInput(character);
  await new Promise((resolve) => setImmediate(resolve));
}

async function press(app: VspiApp, key: string): Promise<void> {
  app.handleInput(key);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function renderedText(app: VspiApp): string {
  return app.render(100).map(stripAnsi).join("\n");
}

describe("Goal 面板键盘路径", () => {
  it("裸 /goal 回车打开状态面板，Esc 可关闭并返回 composer", async () => {
    const app = await createApp();
    try {
      await type(app, "/goal");
      await press(app, ENTER);

      expect(asTestable(app).panels.kind).toBe("goal");
      const panelText = renderedText(app);
      expect(panelText).toContain("当前 Session 没有绑定 Goal");
      // 面板打开时必须宣告退出方式，不能是无提示的黑洞。
      expect(stripAnsi(asTestable(app).panels.renderHint(100, plainTheme()))).toContain("Esc 关闭");

      await press(app, ESCAPE);
      expect(asTestable(app).panels.kind).not.toBe("goal");

      await type(app, "继续输入");
      expect(app.composer.getText()).toBe("继续输入");
    } finally {
      await app.dispose();
    }
  });

  it("Goal 面板打开期间字符不会泄漏进 composer，关闭后恢复输入", async () => {
    const app = await createApp();
    try {
      await type(app, "/goal");
      await press(app, ENTER);
      expect(asTestable(app).panels.kind).toBe("goal");

      await type(app, "abc");
      expect(app.composer.getText()).toBe("");

      await press(app, ESCAPE);
      await type(app, "abc");
      expect(app.composer.getText()).toBe("abc");
    } finally {
      await app.dispose();
    }
  });

  it("Prompt 面板同样支持 Esc 关闭，import 编辑态 Esc 只取消编辑", async () => {
    const app = await createApp();
    try {
      asTestable(app).panels.open("prompt");
      await press(app, "i"); // 进入 import 路径编辑
      expect(asTestable(app).panels.kind).toBe("prompt");
      await press(app, ESCAPE); // 退出编辑态，面板保留
      expect(asTestable(app).panels.kind).toBe("prompt");
      await press(app, ESCAPE); // 关闭面板
      expect(asTestable(app).panels.kind).not.toBe("prompt");

      await type(app, "abc");
      expect(app.composer.getText()).toBe("abc");
    } finally {
      await app.dispose();
    }
  });
});
