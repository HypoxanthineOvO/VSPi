import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { plainTheme } from "./helpers.js";

function fakeTui(): TUI {
  return {
    mode: "regular",
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

describe("session model fallback lifecycle", () => {
  it("does not overwrite an automatically resolved fallback with the runtime default", async () => {
    const selectModel = vi.fn(async () => ({
      modelId: "global-default",
      vision: false,
      contextWindow: 128_000,
      profileModelId: "global-default",
      effort: "medium" as const,
    }));
    const setEffort = vi.fn(async () => {});
    let consumed = false;
    const backend = {
      kind: "pi",
      modelLabel: "DeepSeek / Current",
      modelId: "deepseek-current",
      modelProvider: "deepseek",
      supportsVision: false,
      start: vi.fn(async (events: ChatBackendEvents) => {
        events.onSessionReset?.({ id: "restored", reason: "resume" });
      }),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      consumeResolvedModelFallback: vi.fn(() => {
        if (consumed) return false;
        consumed = true;
        return true;
      }),
      getModelOptions: vi.fn(async () => []),
      getProviderOptions: vi.fn(async () => []),
      selectModel,
      getEffortOptions: vi.fn(async () => ["high"]),
      setEffort,
      dispose: vi.fn(async () => {}),
    } as unknown as ChatBackend;
    const load = vi.fn(async () => ({
      value: { model: { provider: "anthropic", id: "global-default" }, effort: "high" as const },
      diagnostics: [],
    }));
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/model-fallback",
      settings: { ...DEFAULT_SETTINGS },
      attachments: fakeAttachments(),
      renderOnce: true,
      runtimeDefaultsFactory: () => ({ load, save: vi.fn(async () => "/tmp/defaults.json") }),
      onExit: vi.fn(),
    });

    await app.start();

    expect(backend.consumeResolvedModelFallback).toHaveBeenCalledOnce();
    expect(selectModel).not.toHaveBeenCalled();
    expect(setEffort).toHaveBeenCalledWith("high");
    await app.dispose();
  });

  it("applies the VSPi runtime default after a cross-provider fallback", async () => {
    const selectModel = vi.fn(async () => ({
      modelId: "global-default",
      vision: false,
      contextWindow: 128_000,
      profileModelId: "global-default",
      effort: "high" as const,
    }));
    const backend = {
      kind: "pi",
      modelLabel: "Temporary fallback",
      modelId: "temporary",
      modelProvider: "other-provider",
      supportsVision: false,
      start: vi.fn(async (events: ChatBackendEvents) => {
        events.onSessionReset?.({ id: "restored", reason: "resume" });
      }),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      consumeResolvedModelFallback: vi.fn(() => false),
      getModelOptions: vi.fn(async () => []),
      getProviderOptions: vi.fn(async () => []),
      selectModel,
      getEffortOptions: vi.fn(async () => ["high"]),
      setEffort: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as ChatBackend;
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/model-fallback",
      settings: { ...DEFAULT_SETTINGS },
      attachments: fakeAttachments(),
      renderOnce: true,
      runtimeDefaultsFactory: () => ({
        load: vi.fn(async () => ({
          value: { model: { provider: "anthropic", id: "global-default" }, effort: "high" as const },
          diagnostics: [],
        })),
        save: vi.fn(async () => "/tmp/defaults.json"),
      }),
      onExit: vi.fn(),
    });

    await app.start();

    expect(selectModel).toHaveBeenCalledWith("anthropic", "global-default");
    await app.dispose();
  });
});
