import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/ui/ansi.js";
import { AuthDialog } from "../src/ui/auth-dialog.js";
import { plainTheme } from "./helpers.js";

describe("provider authentication dialog", () => {
  it("never renders secret input and resolves it only to the provider flow", async () => {
    const dialog = new AuthDialog("Kimi For Coding", vi.fn(), vi.fn());
    const result = dialog.prompt({ type: "secret", message: "Kimi API key" });
    dialog.handleInput("sk-private-value");

    const rendered = dialog.render(60, plainTheme()).map(stripAnsi).join("\n");
    expect(rendered).not.toContain("sk-private-value");
    expect(rendered).toContain("•".repeat("sk-private-value".length));

    dialog.handleInput("\r");
    await expect(result).resolves.toBe("sk-private-value");
    expect(dialog.render(60, plainTheme()).map(stripAnsi).join("\n")).not.toContain("sk-private-value");
  });

  it("accepts chunked bracketed paste in secret prompts without treating pasted newlines as submit", async () => {
    const dialog = new AuthDialog("自定义中转站", vi.fn(), vi.fn());
    const result = dialog.prompt({ type: "secret", message: "API Key" });

    dialog.handleInput("\u001b[200~sk-pasted");
    dialog.handleInput("-secret\r\n");
    dialog.handleInput("\u001b[201~");

    const rendered = dialog.render(60, plainTheme()).map(stripAnsi).join("\n");
    expect(rendered).not.toContain("sk-pasted-secret");
    expect(rendered).toContain("•".repeat("sk-pasted-secret".length));

    dialog.handleInput("\r");
    await expect(result).resolves.toBe("sk-pasted-secret");
  });

  it("handles a complete bracketed paste followed by Enter in the same terminal chunk", async () => {
    const dialog = new AuthDialog("自定义中转站", vi.fn(), vi.fn());
    const result = dialog.prompt({ type: "text", message: "Base URL" });
    dialog.handleInput("\u001b[200~https://api.example.com/v1\u001b[201~\r");
    await expect(result).resolves.toBe("https://api.example.com/v1");
  });

  it("aborts the whole login flow on Escape", async () => {
    const cancelled = vi.fn();
    const dialog = new AuthDialog("Kimi For Coding", vi.fn(), cancelled);
    const result = dialog.prompt({ type: "text", message: "Code" });
    dialog.handleInput("\u001b");
    await expect(result).rejects.toThrow("Login cancelled");
    expect(dialog.signal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("presents device authorization without exposing token material", () => {
    const dialog = new AuthDialog("Kimi For Coding", vi.fn(), vi.fn());
    dialog.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.kimi.com/device",
    });
    const raw = dialog.render(72, plainTheme()).join("\n");
    const rendered = stripAnsi(raw);
    expect(raw).toContain("\u001b]8;;https://auth.kimi.com/device\u0007");
    expect(rendered).toContain("https://auth.kimi.com/device");
    expect(rendered).toContain("ABCD-EFGH");
    expect(rendered).toContain("设备码会自动轮询");
    expect(rendered).toContain("正在等待授权结果");
  });
});
