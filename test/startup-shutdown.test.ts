import { describe, expect, it, vi } from "vitest";
import { shutdownInteractiveSession } from "../src/app/startup.js";

describe("shutdownInteractiveSession", () => {
  it("stops the TUI before disposing so raw mode is restored even if dispose hangs", async () => {
    const order: string[] = [];
    let releaseDispose!: () => void;
    const disposeApp = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDispose = resolve;
        }),
    );
    const tui = {
      stop: vi.fn(() => {
        order.push("stop");
      }),
    };
    const drainInput = vi.fn(async () => {
      order.push("drain");
    });
    const shutdown = shutdownInteractiveSession({
      disposeApp,
      tui,
      drainInput,
      disposeTimeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(order[0]).toBe("stop"));
    expect(disposeApp).toHaveBeenCalledOnce();
    expect(drainInput).not.toHaveBeenCalled();
    releaseDispose();
    await shutdown;
    expect(order).toEqual(["stop", "drain"]);
  });

  it("proceeds to drain and exits when dispose exceeds the timeout", async () => {
    const disposeApp = vi.fn(() => new Promise<void>(() => {}));
    const tui = { stop: vi.fn() };
    const drainInput = vi.fn(async () => {});
    await shutdownInteractiveSession({
      disposeApp,
      tui,
      drainInput,
      disposeTimeoutMs: 20,
    });
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(drainInput).toHaveBeenCalledOnce();
  });

  it("records dispose errors while still restoring the terminal", async () => {
    const disposeApp = vi.fn(async () => {
      throw new Error("dispose failed");
    });
    const tui = { stop: vi.fn() };
    const drainInput = vi.fn(async () => {});
    await expect(shutdownInteractiveSession({ disposeApp, tui, drainInput, disposeTimeoutMs: 20 })).rejects.toThrow(
      "dispose failed",
    );
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(drainInput).toHaveBeenCalledOnce();
  });
});
