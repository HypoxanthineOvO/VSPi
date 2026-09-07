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

	it("routes config and init without starting a session", async () => {
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
		expect(messages.join("")).not.toContain("已更名");
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

	it("uses the read-only connection for inspect and config diagnostics without reloading", async () => {
		const diagnostics = vi.fn(async () => []);
		const inspect = vi.fn(async () => ({ value: { effort: "high" }, userValue: { effort: "high" } }));
		const reload = vi.fn();
		const connection = fakeConnection({ global: { config: { diagnostics, inspect, reload } } });
		const connect = vi.fn();
		const connectReadOnly = vi.fn(async () => connection);
		const write = vi.fn();
		await dispatchCliCommand(["config", "diagnostics"], { connect, connectReadOnly, write });
		await dispatchCliCommand(["config", "inspect", "thinking"], { connect, connectReadOnly, write });
		expect(connect).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(inspect).toHaveBeenCalledWith("thinking");
		expect(connection.close).toHaveBeenCalledTimes(2);
	});

	it("patches config through the Core merge API and closes on schema rejection", async () => {
		const set = vi.fn(async () => {});
		const replace = vi.fn();
		const connection = fakeConnection({ global: { config: { set, replace } } });
		const common = { connect: async () => connection, write: vi.fn() };
		await dispatchCliCommand(["config", "patch", "subagent", '{"timeoutMs":14400000}'], common);
		expect(set).toHaveBeenCalledWith({ domain: "subagent", patch: { timeoutMs: 14400000 } });
		expect(replace).not.toHaveBeenCalled();
		set.mockRejectedValueOnce(new Error("Invalid timeout"));
		await expect(dispatchCliCommand(["config", "patch", "subagent", '{"timeoutMs":-1}'], common)).rejects.toThrow("Invalid timeout");
		expect(connection.close).toHaveBeenCalledTimes(2);
	});

	it("redacts credentials from config reads and rejects writing a redacted section back", async () => {
		const value = {
			example: {
				apiKey: "example-secret",
				headers: { "X-Custom-Auth": "private-header" },
				env: { CUSTOM_CREDENTIAL: "private-env" },
				oauth: { refresh_token: "private-refresh" },
				baseUrl: "https://user:pass@example.test/v1?api_key=private-query",
				maxTokens: 2048,
			},
		};
		const connection = fakeConnection({ global: { config: { get: async () => value } } });
		const write = vi.fn();
		await dispatchCliCommand(["config", "get", "providers"], { connect: async () => connection, write });
		const output = write.mock.calls[0]![0];
		for (const secret of ["example-secret", "private-header", "private-env", "private-refresh", "user:pass", "private-query"])
			expect(output).not.toContain(secret);
		expect(JSON.parse(output).example.maxTokens).toBe(2048);
		expect(value.example.apiKey).toBe("example-secret");
		const connect = vi.fn();
		await expect(dispatchCliCommand(["config", "set", "providers", output], { connect })).rejects.toThrow("Redacted config");
		expect(connect).not.toHaveBeenCalled();
	});

	it("inspects the daemon's resolved paths and catalog without exposing runtime ownership data", async () => {
		const models = [{ model: "example/model", capabilities: ["image_in"], support_efforts: ["high"] }];
		const listModels = vi.fn(async () => models);
		const connection = {
			...fakeConnection({ global: { kosong: { listModels } } }),
			env: { homeDir: "/custom/runtime", configPath: "/custom/runtime/config.toml", sessionsDir: "/custom/session-store", logsDir: "/custom/logs" } as never,
			state: { pid: 42, version: "test", ownerNonce: "private-owner" } as never,
		};
		const write = vi.fn();
		const connect = vi.fn();
		const common = { connect, connectReadOnly: async () => connection, write };
		await dispatchCliCommand(["inspect"], common);
		expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({ homeDir: "/custom/runtime", sessionsDir: "/custom/session-store", runtimeLogPath: "/custom/runtime/server/runtime.log", pid: 42 });
		expect(write.mock.calls[0]![0]).not.toContain("private-owner");
		await dispatchCliCommand(["inspect", "models"], common);
		expect(JSON.parse(write.mock.calls[1]![0])).toEqual(models);
		expect(connect).not.toHaveBeenCalled();
		expect(connection.close).toHaveBeenCalledTimes(2);
	});

	it("inspects only an explicit session index entry without loading prompts or restoring a session", async () => {
		const get = vi.fn(async () => ({ id: "session-a", workspaceId: "workspace-a", archived: true, lastPrompt: "private prompt", custom: { secret: "private metadata" } }));
		const list = vi.fn();
		const session = vi.fn();
		const connection = {
			...fakeConnection({ global: { sessions: { get, list } }, session }),
			env: { homeDir: "/custom/runtime", sessionsDir: "/custom/session-store" } as never,
		};
		const write = vi.fn();
		await dispatchCliCommand(["inspect", "session", "session-a"], { connectReadOnly: async () => connection, write });
		expect(get).toHaveBeenCalledExactlyOnceWith("session-a");
		expect(list).not.toHaveBeenCalled();
		expect(session).not.toHaveBeenCalled();
		expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({ archived: true, transcriptPath: "/custom/session-store/workspace-a/session-a/agents/main/wire.jsonl" });
		expect(write.mock.calls[0]![0]).not.toContain("private");
	});

	it("rejects incomplete or unsafe inspect requests before connecting and propagates closed IPC", async () => {
		const connectReadOnly = vi.fn(async () => { throw new Error("ipc closed"); });
		for (const args of [["inspect", "session"], ["inspect", "session", "../other"], ["inspect", "models", "extra"], ["config", "diagnostics", "extra"]])
			await expect(dispatchCliCommand(args, { connectReadOnly })).rejects.toThrow("Usage:");
		expect(connectReadOnly).not.toHaveBeenCalled();
		await expect(dispatchCliCommand(["inspect"], { connectReadOnly })).rejects.toThrow("ipc closed");
		expect(connectReadOnly).toHaveBeenCalledOnce();
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
