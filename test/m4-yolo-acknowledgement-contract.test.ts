import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { plainTheme } from "./helpers.js";
import { loadStartupPolicyRuntimeModule } from "./m4-integration-contract.js";

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

function config() {
  return {
    load: async () => ({
      globalPolicy: "Standard" as const,
      effectivePolicy: "Standard" as const,
      networkAllowlist: [],
      hash: "f".repeat(64),
      diagnostics: [],
    }),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("M4 one-shot YOLO acknowledgement", () => {
  it("grants, consumes, and cancels exactly one pending acknowledgement", async () => {
    const module = await loadStartupPolicyRuntimeModule();
    expect(module?.createYoloAcknowledgementBroker).toBeTypeOf("function");
    if (!module?.createYoloAcknowledgementBroker) return;
    const broker = module.createYoloAcknowledgementBroker();
    expect(await broker.consume()).toBe(false);
    broker.grantOnce("tui");
    expect(await broker.consume()).toBe(true);
    expect(await broker.consume()).toBe(false);
    broker.grantOnce("tui");
    broker.cancel();
    expect(await broker.consume()).toBe(false);
  });

  it("allows only a real YOLO Panel confirmation to switch the App shared service", async () => {
    const module = await loadStartupPolicyRuntimeModule();
    expect(module?.createYoloAcknowledgementBroker).toBeTypeOf("function");
    if (!module?.createYoloAcknowledgementBroker) return;
    const broker = module.createYoloAcknowledgementBroker();
    const service = await module.createStartupPolicyRuntime({
      workspace: "/tmp/vspi-m4-yolo-app",
      security: { recovery: false, policy: "Standard", trustedProject: false },
      configService: config(),
      acknowledgeYolo: () => broker.consume(),
    });
    const app = new VspiApp(fakeTui(), plainTheme(), new FixtureBackend(), {
      cwd: "/tmp/vspi-m4-yolo-app",
      settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
      attachments: fakeAttachments(),
      executionPolicy: service,
      yoloAcknowledgementBroker: broker,
      renderOnce: true,
      onExit: vi.fn(),
    } as never);
    try {
      await app.start();
      await expect(service.switchPolicy("YOLO")).rejects.toThrow(/acknowledge|确认|YOLO/i);
      expect(service.snapshot().policy).toBe("Standard");

      app.composer.setText("/policy");
      app.handleInput("\r");
      await flush();
      for (let index = 0; index < 3; index += 1) app.handleInput("\u001b[B");
      app.handleInput("\u001b");
      await flush();
      await expect(service.switchPolicy("YOLO")).rejects.toThrow(/acknowledge|确认|YOLO/i);

      await (
        app as unknown as {
          applyPanelEvent(event: {
            type: "policyChange";
            policy: "YOLO";
            requiresAcknowledgement: true;
          }): Promise<void>;
        }
      ).applyPanelEvent({ type: "policyChange", policy: "YOLO", requiresAcknowledgement: true });
      expect(service.snapshot().policy).toBe("Standard");

      app.composer.setText("/policy");
      app.handleInput("\r");
      await flush();
      for (let index = 0; index < 3; index += 1) app.handleInput("\u001b[B");
      app.handleInput("\r");
      await flush();
      expect(service.snapshot()).toMatchObject({ policy: "YOLO", boundary: "Host" });

      await service.switchPolicy("Standard");
      await expect(service.switchPolicy("YOLO")).rejects.toThrow(/acknowledge|确认|YOLO/i);
    } finally {
      await app.dispose();
    }
  });

  it("uses CLI startup acknowledgement once without creating ambient YOLO authority", async () => {
    const module = await loadStartupPolicyRuntimeModule();
    expect(module?.createYoloAcknowledgementBroker).toBeTypeOf("function");
    if (!module?.createYoloAcknowledgementBroker) return;
    const broker = module.createYoloAcknowledgementBroker({ startupAuthorized: true });
    const service = await module.createStartupPolicyRuntime({
      workspace: "/tmp/vspi-m4-yolo-cli",
      security: { recovery: false, policy: "YOLO", trustedProject: false },
      configService: config(),
      acknowledgeYolo: () => broker.consume(),
    });
    expect(service.snapshot()).toMatchObject({ policy: "YOLO", boundary: "Host" });
    await service.switchPolicy("Standard");
    await expect(service.switchPolicy("YOLO")).rejects.toThrow(/acknowledge|确认|YOLO/i);
  });
});
