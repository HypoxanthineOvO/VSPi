import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend } from "../src/backend/types.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { ProviderOption } from "../src/domain/types.js";
import type { PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

type TestableApp = {
  applyPanelEvent(event: PanelEvent): Promise<void>;
  submit(raw: string): Promise<void>;
  notice?: { text: string; tone: string };
};

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, columns: 80, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } as unknown as AttachmentService;
}

describe("M3 App Provider action boundary", () => {
  it("keeps menu open local, probes only explicit actions, and reports atomic save conflicts", async () => {
    const provider: ProviderOption = {
      id: "local-provider",
      label: "Local Provider",
      protocol: "Responses",
      status: "已配置",
      detail: "stored",
      baseUrl: "http://127.0.0.1:9999",
    };
    const runProviderProbe = vi.fn(async (_id, mode, confirmCost?: () => Promise<boolean>) => {
      const confirmed = confirmCost ? await confirmCost() : true;
      return { ok: confirmed, diagnostic: `${mode}:${confirmed ? "ok" : "cancelled"}` };
    });
    const backend: ChatBackend = {
      kind: "pi",
      modelLabel: "OpenAI / Current",
      modelId: "current",
      supportsVision: false,
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      getModelOptions: vi.fn(async () => []),
      getProviderOptions: vi.fn(async () => [provider]),
      setEffort: vi.fn(async () => {}),
      isProjectTrusted: () => true,
      runProviderProbe,
      dispose: vi.fn(async () => {}),
    };
    const saveProjectProvider = vi.fn(async () => {
      throw new Error("Provider config conflict sentinel");
    });
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/m3-provider-app",
      settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
      attachments: fakeAttachments(),
      renderOnce: true,
      providerConfigFactory: () => ({
        loadCatalog: async () => ({
          hash: "a".repeat(64),
          diagnostics: [],
          providers: [{ id: provider.id, source: "project" }],
        }),
        saveProjectProvider,
      }),
      runtimeDefaultsFactory: () => ({
        load: async () => ({ value: { effort: "中" }, diagnostics: [] }),
        save: async () => "/tmp/runtime-defaults.json",
      }),
      onExit: vi.fn(),
    });
    await app.start();
    const testable = app as unknown as TestableApp;

    await testable.applyPanelEvent({ type: "providerActions", provider, actions: ["edit", "check-config"] });
    expect(runProviderProbe).not.toHaveBeenCalled();
    await testable.applyPanelEvent({ type: "providerAction", provider, action: "check-config" });
    await testable.applyPanelEvent({ type: "providerAction", provider, action: "test-connection" });
    await testable.applyPanelEvent({
      type: "providerAction",
      provider,
      action: "minimal-generation",
      costConfirmed: false,
    });
    expect(runProviderProbe.mock.calls.map((call) => call[1])).toEqual([
      "check-config",
      "test-connection",
      "minimal-generation",
    ]);
    expect(await runProviderProbe.mock.calls[2]?.[2]?.()).toBe(false);

    await testable.applyPanelEvent({
      type: "providerSave",
      provider,
      value: { name: provider.label, baseUrl: provider.baseUrl ?? "", protocol: provider.protocol },
    });
    expect(saveProjectProvider).toHaveBeenCalledWith(provider.id, expect.any(Object), { expectedHash: "a".repeat(64) });
    expect(testable.notice).toMatchObject({ tone: "error" });
    expect(testable.notice?.text).toMatch(/未保存.*conflict/i);
    await app.dispose();
  });

  it("applies startup and /new --default values and persists only successful scoped mutations", async () => {
    let model = { provider: "openai", id: "startup-model", label: "OpenAI / Startup", vision: false };
    const selectModel = vi.fn(async (provider: string, id: string) => {
      if (id === "broken-model") throw new Error("atomic model rollback sentinel");
      model = { provider, id, label: `${provider} / ${id}`, vision: id === "default-model" };
      return {
        modelId: id,
        modelLabel: model.label,
        vision: model.vision,
        contextWindow: 128_000,
        profileModelId: id,
        effort: "高" as const,
      };
    });
    const setEffort = vi.fn(async () => {});
    const backend = {
      kind: "pi",
      get modelLabel() {
        return model.label;
      },
      get modelId() {
        return model.id;
      },
      get supportsVision() {
        return model.vision;
      },
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      getModelOptions: vi.fn(async () => [
        {
          id: "startup-model",
          provider: "openai",
          brand: "OpenAI",
          label: "Startup",
          vision: false,
          efforts: ["中"],
          price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
        {
          id: "default-model",
          provider: "anthropic",
          brand: "Anthropic",
          label: "Default",
          vision: true,
          efforts: ["高"],
          price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
        {
          id: "broken-model",
          provider: "google",
          brand: "Google",
          label: "Broken",
          vision: false,
          efforts: ["中"],
          price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
      ]),
      getProviderOptions: vi.fn(async () => []),
      selectModel,
      setEffort,
      isProjectTrusted: () => true,
      dispose: vi.fn(async () => {}),
    } as unknown as ChatBackend;
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        value: { model: { provider: "openai", id: "startup-model" }, effort: "低" },
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        value: { model: { provider: "anthropic", id: "default-model" }, effort: "高" },
        diagnostics: [],
      });
    const save = vi.fn(async () => "/tmp/project-runtime-defaults.json");
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/m3-default-app",
      settings: { ...DEFAULT_SETTINGS, scope: "project", bridgeEnabled: false },
      attachments: fakeAttachments(),
      renderOnce: true,
      runtimeDefaultsFactory: () => ({ load, save }),
      onExit: vi.fn(),
    });
    await app.start();
    const testable = app as unknown as TestableApp;
    expect(selectModel).toHaveBeenCalledWith("openai", "startup-model");
    expect(setEffort).toHaveBeenCalledWith("低");

    selectModel.mockClear();
    setEffort.mockClear();
    await testable.submit("/new --default");
    expect(selectModel).toHaveBeenCalledWith("anthropic", "default-model");
    expect(setEffort).toHaveBeenCalledWith("高");
    expect(app.render(80).join("\n")).toContain("anthropic / defa");

    save.mockClear();
    await testable.submit("/effort");
    expect(setEffort).toHaveBeenLastCalledWith("低");
    expect(save).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({ model: { provider: "anthropic", id: "default-model" }, effort: "低" }),
    );

    save.mockClear();
    await testable.applyPanelEvent({
      type: "model",
      model: {
        id: "broken-model",
        provider: "google",
        brand: "Google",
        label: "Broken",
        vision: false,
        efforts: ["中"],
        price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      },
    });
    expect(save).not.toHaveBeenCalled();
    expect(backend.modelId).toBe("default-model");
    expect(backend.supportsVision).toBe(true);
    expect(testable.notice).toMatchObject({ tone: "error" });
    await app.dispose();
  });

  it("persists a provider-qualified narrow identity when model ids collide", async () => {
    const sharedModels = [
      {
        id: "shared",
        provider: "wrong",
        brand: "Wrong",
        label: "Shared",
        vision: false,
        efforts: ["中"],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      },
      {
        id: "shared",
        provider: "right",
        brand: "Right",
        label: "Shared",
        vision: true,
        efforts: ["中", "高"],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      },
    ];
    const setEffort = vi.fn(async () => {});
    const backend = {
      kind: "pi",
      modelLabel: "Right / Shared",
      modelId: "shared",
      modelProvider: "right",
      supportsVision: true,
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      switchSession: vi.fn(async () => {}),
      getModelOptions: vi.fn(async () => sharedModels),
      getProviderOptions: vi.fn(async () => []),
      setEffort,
      isProjectTrusted: () => true,
      dispose: vi.fn(async () => {}),
    } as unknown as ChatBackend;
    let savedValue: unknown;
    const save = vi.fn(async (_scope: string, value: unknown) => {
      savedValue = value;
      return "/tmp/narrow-runtime-defaults.json";
    });
    const app = new VspiApp(fakeTui(), plainTheme(), backend, {
      cwd: "/workspace/m3-duplicate-model-id",
      settings: { ...DEFAULT_SETTINGS, scope: "project", bridgeEnabled: false },
      attachments: fakeAttachments(),
      renderOnce: true,
      runtimeDefaultsFactory: () => ({
        load: async () => ({ value: { effort: "中" }, diagnostics: [] }),
        save,
      }),
      onExit: vi.fn(),
    });
    await app.start();
    save.mockClear();
    await (app as unknown as TestableApp).submit("/effort");

    expect.soft(save).toHaveBeenCalledWith("project", {
      model: { provider: "right", id: "shared" },
      effort: "高",
    });
    expect(Object.keys((savedValue as { model?: object } | undefined)?.model ?? {}).sort()).toEqual(["id", "provider"]);
    await app.dispose();
  });
});
