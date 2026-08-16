import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import type { ChatBackend } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

type TestableApp = {
  applyPanelEvent(event: PanelEvent): Promise<void>;
  notice?: { text: string; tone: string };
};

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, columns: 80, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function piBackend(overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    kind: "pi",
    modelLabel: "DeepSeek / Current",
    modelId: "deepseek-current",
    modelProvider: "deepseek",
    supportsVision: false,
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    getModelOptions: vi.fn(async () => []),
    getProviderOptions: vi.fn(async () => []),
    getEffortOptions: vi.fn(async () => ["medium", "high"] as Array<"medium" | "high">),
    selectModel: vi.fn(async (_provider, id) => ({
      modelId: id,
      vision: false,
      contextWindow: 128_000,
      profileModelId: id,
      effort: "high" as const,
    })),
    setEffort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("C2 Revision 5 runtime-default backend isolation", () => {
  it("does not let Fixture persist its offline model into shared defaults", async () => {
    const save = vi.fn(async () => "/tmp/runtime-defaults.json");
    const app = new VspiApp(fakeTui(), plainTheme(), new FixtureBackend(), {
      cwd: "/workspace/r5-fixture-defaults",
      settings: { ...DEFAULT_SETTINGS },
      attachments: fakeAttachments(),
      renderOnce: true,
      runtimeDefaultsFactory: () => ({
        load: async () => ({ value: { effort: "medium" }, diagnostics: [] }),
        save,
      }),
      onExit: vi.fn(),
    });

    await app.start();
    await (app as unknown as TestableApp).applyPanelEvent({ type: "effort", effort: "high" });

    expect(save).not.toHaveBeenCalled();
    await app.dispose();
  });

  it("keeps the active Pi model when a polluted Fixture default is unavailable", async () => {
    const selectModel = vi.fn(async () => {
      throw new Error("模型 fixture/offline-fixture 未配置认证或当前不可用");
    });
    const setEffort = vi.fn(async () => {});
    const backend = piBackend({ selectModel, setEffort });
    const attachments = {
      start: vi.fn(async (events: { onNotice(text: string, tone: "info"): void }) => {
        events.onNotice("附件服务已就绪", "info");
      }),
      dispose: vi.fn(async () => {}),
    } as unknown as AttachmentService;
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/r5-polluted-defaults",
      settings: { ...DEFAULT_SETTINGS },
      attachments,
      renderOnce: true,
      runtimeDefaultsFactory: () => ({
        load: async () => ({
          value: { model: { provider: "fixture", id: "offline-fixture" }, effort: "high" },
          diagnostics: [],
        }),
        save: vi.fn(async () => "/tmp/runtime-defaults.json"),
      }),
      onExit: vi.fn(),
    });

    await expect(app.start()).resolves.toBeUndefined();
    expect(selectModel).toHaveBeenCalledWith("fixture", "offline-fixture");
    expect(setEffort).toHaveBeenCalledWith("high");
    expect((app as unknown as TestableApp).notice).toMatchObject({ tone: "warning" });
    expect((app as unknown as TestableApp).notice?.text).toMatch(
      /默认模型 fixture\/offline-fixture.*已保留 DeepSeek \/ Current/,
    );
    await app.dispose();
  });

  it("does not apply an Effort level unsupported by the active model", async () => {
    const setEffort = vi.fn(async () => {});
    const backend = piBackend({ setEffort });
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/r5-unsupported-effort",
      settings: { ...DEFAULT_SETTINGS },
      attachments: fakeAttachments(),
      renderOnce: true,
      runtimeDefaultsFactory: () => ({
        load: async () => ({ value: { effort: "max" }, diagnostics: [] }),
        save: vi.fn(async () => "/tmp/runtime-defaults.json"),
      }),
      onExit: vi.fn(),
    });

    await expect(app.start()).resolves.toBeUndefined();
    expect(setEffort).not.toHaveBeenCalled();
    expect((app as unknown as TestableApp).notice?.text).toMatch(/Max.*不受当前模型支持/);
    await app.dispose();
  });
});
