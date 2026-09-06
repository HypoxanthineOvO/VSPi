import { describe, expect, it, vi } from "vitest";

import { dispatchCliCommand } from "../src/cli-command.js";
import { customProviderId, modelsFromManualInput } from "../src/v1/providers/custom-provider.js";


describe("VSPi CLI command dispatch", () => {
	it("dispatches update before runtime startup and requests a restart", async () => {
		const update = vi.fn(async (currentVersion: string) => ({
			status: "updated" as const,
			currentVersion,
			latestVersion: "next-version",
		}));
		const messages: string[] = [];
		await expect(
			dispatchCliCommand(["update"], {
				update,
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(update).toHaveBeenCalledOnce();
		expect(messages.join("")).toContain("next-version");
		expect(messages.join("")).toContain("重启");
	});

	it("reports an up-to-date install and leaves runtime commands undispatched", async () => {
		const messages: string[] = [];
		await expect(
			dispatchCliCommand(["update"], {
				update: async (currentVersion) => ({ status: "up-to-date", currentVersion, latestVersion: currentVersion }),
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(messages.join("")).toContain("已是最新版本");
		await expect(dispatchCliCommand(["daemon"])).resolves.toBe(false);
	});

	it("rejects unknown commands and options before runtime startup", async () => {
		const connect = vi.fn(async () => fakeConnection());
		await expect(dispatchCliCommand(["--unknown"], { connect })).rejects.toThrow(
			"Unknown option: --unknown",
		);
		await expect(dispatchCliCommand(["unknown"], { connect })).rejects.toThrow(
			"Unknown command: unknown",
		);
		await expect(
			dispatchCliCommand(["config", "--unknown"], { connect }),
		).rejects.toThrow("Unknown option for vspi config: --unknown");
		expect(connect).not.toHaveBeenCalled();
	});

	it("rejects unsupported update arguments", async () => {
		await expect(dispatchCliCommand(["update", "extra"])).rejects.toThrow("Usage: vspi update");
	});

	it("prints usage for --help without connecting to the runtime", async () => {
		const messages: string[] = [];
		const connect = vi.fn(async () => fakeConnection());
		for (const args of [["--help"], ["-h"], ["help"]]) {
			await expect(
				dispatchCliCommand(args, {
					connect,
					write: (message) => messages.push(message),
				}),
			).resolves.toBe(true);
		}
		expect(connect).not.toHaveBeenCalled();
		expect(messages.join("")).toContain("Usage: vspi [command]");
		expect(messages.join("")).toContain("config.toml");
		expect(messages.join("")).toContain("[models.");
	});

	it("prints config help and path without a TTY or runtime connection", async () => {
		const messages: string[] = [];
		const connect = vi.fn(async () => fakeConnection());
		await expect(
			dispatchCliCommand(["config", "--help"], {
				connect,
				stdinIsTTY: () => false,
				stdoutIsTTY: () => false,
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		await expect(
			dispatchCliCommand(["config", "path"], {
				connect,
				stdinIsTTY: () => false,
				stdoutIsTTY: () => false,
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(connect).not.toHaveBeenCalled();
		expect(messages.join("")).toContain("vspi config get <section>");
		expect(messages.at(-1)).toMatch(/config\.toml\n$/u);
	});

	it("reads, validates, writes, and reloads config without a TTY", async () => {
		const config = {
			get: vi.fn(async () => "example/model"),
			replace: vi.fn(async () => {}),
			reload: vi.fn(async () => {}),
			diagnostics: vi.fn(async () => [{ severity: "warning", message: "example" }]),
		};
		const connection = fakeConnection({ global: { config } });
		const messages: string[] = [];
		const common = {
			connect: async () => connection,
			stdinIsTTY: () => false,
			stdoutIsTTY: () => false,
			write: (message: string) => messages.push(message),
		};

		await expect(dispatchCliCommand(["config", "get", "defaultModel"], common)).resolves.toBe(true);
		await expect(
			dispatchCliCommand(
				["config", "set", "secondaryModel", '{"defaultModel":"example/model"}'],
				common,
			),
		).resolves.toBe(true);
		await expect(dispatchCliCommand(["config", "reload"], common)).resolves.toBe(true);

		expect(config.get).toHaveBeenCalledWith("defaultModel");
		expect(config.replace).toHaveBeenCalledWith({
			domain: "secondaryModel",
			value: { defaultModel: "example/model" },
		});
		expect(config.reload).toHaveBeenCalledOnce();
		expect(config.diagnostics).toHaveBeenCalledOnce();
		expect(messages.join("")).toContain('"example/model"');
		expect(connection.close).toHaveBeenCalledTimes(3);
	});

	it("rejects malformed config JSON before connecting", async () => {
		const connect = vi.fn(async () => fakeConnection());
		await expect(
			dispatchCliCommand(["config", "set", "defaultModel", "{"], { connect }),
		).rejects.toThrow("Invalid JSON");
		expect(connect).not.toHaveBeenCalled();
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

function fakeConnection(klient: unknown = {}) {
	return {
		state: {} as never,
		env: {} as never,
		klient: klient as never,
		close: vi.fn(async () => {}),
	};
}
