import { describe, expect, it, vi } from "vitest";

import { dispatchCliCommand } from "../src/cli-command.js";
import { customProviderId, modelsFromManualInput } from "../src/v1/providers/custom-provider.js";


describe("VSPi CLI command dispatch", () => {
	it("dispatches update before runtime startup and requests a restart", async () => {
		const update = vi.fn(async () => ({
			status: "updated" as const,
			currentVersion: "2.0.0",
			latestVersion: "2.1.0",
		}));
		const messages: string[] = [];
		await expect(
			dispatchCliCommand(["update"], {
				update,
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(update).toHaveBeenCalledWith("2.0.0");
		expect(messages.join("")).toMatch(/2\.1\.0.*重启/u);
	});

	it("reports an up-to-date install and leaves runtime commands undispatched", async () => {
		const messages: string[] = [];
		await expect(
			dispatchCliCommand(["update"], {
				update: async () => ({ status: "up-to-date", currentVersion: "2.0.0", latestVersion: "2.0.0" }),
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(messages.join("")).toContain("最新版本 2.0.0");
		await expect(dispatchCliCommand(["daemon"])).resolves.toBe(false);
	});

	it("rejects unsupported update arguments", async () => {
		await expect(dispatchCliCommand(["update", "extra"])).rejects.toThrow("Usage: vspi update");
	});

	it("routes config and the init compatibility alias without starting a session", async () => {
		const connect = vi.fn(async () => fakeConnection());
		const authSetup = vi.fn(async () => {});
		const settings = { scope: "global" } as never;
		const messages: string[] = [];
		await expect(
			dispatchCliCommand(["config", "custom"], {
				connect,
				authSetup,
				loadSettings: async () => settings,
				stdinIsTTY: () => true,
				stdoutIsTTY: () => true,
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		await expect(
			dispatchCliCommand(["init", "custom"], {
				connect,
				authSetup,
				loadSettings: async () => settings,
				stdinIsTTY: () => true,
				stdoutIsTTY: () => true,
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(authSetup).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: "config", providerRef: "custom", settings }));
		expect(authSetup).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: "config", providerRef: "custom", settings }));
		expect(messages.join("")).toContain("init 已更名");
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it("routes login and logout with a provider and always closes the runtime", async () => {
		const connection = fakeConnection();
		const connect = vi.fn(async () => connection);
		const authSetup = vi.fn(async () => {});
		const common = {
			connect,
			authSetup,
			loadSettings: async () => ({ scope: "global" }) as never,
			stdinIsTTY: () => true,
			stdoutIsTTY: () => true,
		};
		await dispatchCliCommand(["login", "kimi"], common);
		await dispatchCliCommand(["logout", "kimi"], common);
		expect(authSetup).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: "login", providerRef: "kimi" }));
		expect(authSetup).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: "logout", providerRef: "kimi" }));
		expect(connection.close).toHaveBeenCalledTimes(2);
	});

	it("rejects auth commands before connecting when either stream is not a TTY", async () => {
		const connect = vi.fn(async () => fakeConnection());
		await expect(
			dispatchCliCommand(["config"], {
				connect,
				stdinIsTTY: () => false,
				stdoutIsTTY: () => true,
			}),
		).rejects.toThrow("需要交互式 TTY");
		expect(connect).not.toHaveBeenCalled();
	});

	it("rejects extra auth arguments", async () => {
		await expect(dispatchCliCommand(["login", "kimi", "extra"], {
			stdinIsTTY: () => true,
			stdoutIsTTY: () => true,
		})).rejects.toThrow("Usage: vspi login [provider]");
	});

	it("keeps custom provider identities stable and parses manual model ids", () => {
		expect(customProviderId("My Gateway", "https://gateway.example.com/v1")).toBe(
			customProviderId("My Gateway", "https://gateway.example.com/v1"),
		);
		expect(modelsFromManualInput("model-a，model-b model-a")).toEqual([
			{ id: "model-a", name: "model-a" },
			{ id: "model-b", name: "model-b" },
		]);
	});
});

function fakeConnection() {
	return {
		state: {} as never,
		env: {} as never,
		klient: {} as never,
		close: vi.fn(async () => {}),
	};
}
