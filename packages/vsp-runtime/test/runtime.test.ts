/**
 * Scenario: one VSP daemon exposes a shared Kimi Core over IPC.
 * Responsibilities: public connection, workspace persistence, exclusive ownership, cleanup.
 * Wiring: real KAP/Core/Klient with isolated filesystem state and no model network calls.
 * Run: pnpm -C packages/vsp-runtime test
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	connectRuntime,
	inspectRuntime,
	resolveRuntimePaths,
	stopRuntime,
	RuntimeAlreadyRunningError,
	startRuntimeDaemon,
	type RuntimeDaemon,
} from "../src/index.js";

const identity = {
	productName: "vspi-test",
	version: "0.1.0-test",
	platform: "vspi_test",
	displayName: "VSPi Test",
};

describe("VSP runtime daemon (shared Core ownership)", () => {
	let homeDir: string | undefined;
	let daemon: RuntimeDaemon | undefined;

	afterEach(async () => {
		await daemon?.close();
		daemon = undefined;
		if (homeDir !== undefined)
			await rm(homeDir, { recursive: true, force: true });
		homeDir = undefined;
	});

	it("connects through IPC when the daemon is ready, exposes the daemon environment", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-connect-"));
		daemon = await startTestDaemon(homeDir);

		const connection = await connectRuntime(homeDir);
		try {
			expect(connection.env.homeDir).toBe(homeDir);
			expect(connection.env.clientVersion).toBe("0.1.0-test");
			expect(connection.state.port).toBeGreaterThan(0);
		} finally {
			await connection.close();
		}
	});

	it("persists a workspace when a client registers one, another client observes it", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-workspace-"));
		daemon = await startTestDaemon(homeDir);
		const projectRoot = join(homeDir, "project");
		await mkdir(projectRoot);
		const first = await connectRuntime(homeDir);
		await first.klient.global.workspaces.createOrTouch({
			root: projectRoot,
			name: "Project",
		});
		await first.close();

		const second = await connectRuntime(homeDir);
		try {
			expect(await second.klient.global.workspaces.list()).toEqual([
				expect.objectContaining({ root: projectRoot, name: "Project" }),
			]);
		} finally {
			await second.close();
		}
	});

	it("keeps a session available when its creating client disconnects, another client reads it", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-session-"));
		daemon = await startTestDaemon(homeDir);
		const projectRoot = join(homeDir, "project");
		await mkdir(join(projectRoot, ".git"), { recursive: true });
		const first = await connectRuntime(homeDir);
		const created = await first.klient.global.sessions.create({
			workDir: projectRoot,
			title: "Shared session",
		});
		await first.close();

		const second = await connectRuntime(homeDir);
		try {
			await expect(second.klient.session(created.id).get()).resolves.toEqual(
				expect.objectContaining({
					id: created.id,
					title: "Shared session",
					cwd: projectRoot,
				}),
			);
		} finally {
			await second.close();
		}
	});

	it("rejects a second daemon when the same runtime home is already owned", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-exclusive-"));
		daemon = await startTestDaemon(homeDir);

		await expect(
			startRuntimeDaemon({ homeDir, hostIdentity: identity }),
		).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);
	});

	it("enables audited VSP features by default when the user has no override", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-features-"));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			const flags = await connection.klient.global.flags.list();
			expect(flags).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "secondary-model", enabled: true }),
					expect.objectContaining({ id: "tower", enabled: true }),
					expect.objectContaining({ id: "remote-control", enabled: true }),
					expect.objectContaining({ id: "auto_session_title", enabled: true }),
				]),
			);
		} finally {
			await connection.close();
		}
	});

	it("preserves an explicit user opt-out over the VSP feature defaults", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-feature-opt-out-"));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await connection.klient.global.config.set({
				domain: "experimental",
				patch: { tower: false, auto_session_title: false },
			});
			const flags = await connection.klient.global.flags.list();
			expect(flags).toContainEqual(
				expect.objectContaining({ id: "tower", enabled: false }),
			);
			expect(flags).toContainEqual(
				expect.objectContaining({ id: "auto_session_title", enabled: false }),
			);
		} finally {
			await connection.close();
		}
	});

	it("uses the VSP permission and product-skill defaults", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-product-defaults-"));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await expect(
				connection.klient.global.config.get("defaultPermissionMode"),
			).resolves.toBe("auto");
			await expect(
				connection.klient.global.config.get("builtinProductSkills"),
			).resolves.toBe(false);
		} finally {
			await connection.close();
		}
	});

	it("removes discoverable runtime state when the owner closes", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-cleanup-"));
		daemon = await startTestDaemon(homeDir);

		await daemon.close();
		daemon = undefined;

		await expect(inspectRuntime(homeDir)).resolves.toBeUndefined();
	});

	it("does not signal a live process when ownership cannot be proven", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-stale-pid-"));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		await writeFile(paths.tokenPath, "token\n");
		await writeFile(paths.statePath, JSON.stringify({
			protocolVersion: 1,
			pid: process.pid,
			ownerNonce: "stale-nonce",
			host: "127.0.0.1",
			port: 1,
			ipcPath: join(homeDir, "missing.sock"),
			startedAt: new Date().toISOString(),
			version: identity.version,
		}));
		const kill = vi.spyOn(process, "kill");
		try {
			await expect(stopRuntime(homeDir, 25)).rejects.toThrow(/ipc closed|ownership cannot be proven/u);
			expect(kill).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
		} finally {
			kill.mockRestore();
		}
	});

	it("signals an owned daemon only after the authenticated handshake", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-owned-stop-"));
		daemon = await startTestDaemon(homeDir);
		const killedPid = daemon.state.pid;
		let signaled = false;
		const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === killedPid && signal === "SIGTERM") {
				signaled = true;
				void daemon?.close();
				return true;
			}
			if (pid === killedPid && signal === 0 && signaled) throw new Error("ESRCH");
			return true;
		});
		try {
			await expect(stopRuntime(homeDir, 250)).resolves.toBe(true);
			expect(kill).toHaveBeenCalledWith(daemon.state.pid, "SIGTERM");
		} finally {
			kill.mockRestore();
		}
	});

	it("repairs invalid TOML before Core starts and reaches a connectable state", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-invalid-config-"));
		await writeFile(join(homeDir, "config.toml"), "[broken\napi_key = 'secret'\n");

		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			expect(connection.env.homeDir).toBe(homeDir);
			expect(connection.migrationWarning).toEqual({ status: "repaired", reason: "bad-toml" });
			expect(JSON.stringify(connection.migrationWarning)).not.toContain(homeDir);
			await expect(connection.klient.global.config.get("providers")).resolves.toEqual({});
		} finally {
			await connection.close();
		}
	});

	it("imports legacy Pi providers and VSPi defaults without overwriting new config", async () => {
		const root = await mkdtemp(join(tmpdir(), "vsp-runtime-legacy-provider-"));
		homeDir = root;
		const runtimeHome = join(root, ".vspi");
		const agentDir = join(root, ".pi", "agent");
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(root, ".config", "vspi"), { recursive: true });
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"custom-gemini-via-legacybridge-32efcb06": {
						name: "Legacy Gemini Bridge",
						baseUrl: "https://legacy.example/v1",
						api: "openai",
						models: [{ id: "gemini-test", name: "Gemini Test" }],
					},
					relay: {
						name: "Relay",
						baseUrl: "https://relay.example/v1",
						api: "openai-responses",
						models: [
							{
								id: "reasoner",
								name: "Reasoner",
								contextWindow: 200_000,
								maxTokens: 32_000,
								input: ["text", "image"],
							},
							{
								id: "gpt-5.6-sol",
								name: "GPT-5.6 Sol",
								contextWindow: 128_000,
								maxTokens: 32_000,
								input: ["text"],
							},
						],
					},
				},
			}),
		);
		await writeFile(
			join(agentDir, "models-store.json"),
			JSON.stringify({
				upstream: {
					models: [
						{
							id: "reasoner",
							name: "Upstream Reasoner",
							api: "anthropic-messages",
							baseUrl: "https://upstream.example/v1",
							contextWindow: 128_000,
							maxTokens: 8_000,
							input: ["text"],
							reasoning: true,
							thinkingLevelMap: { low: "low", high: "high" },
						},
					],
				},
			}),
		);
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({
				relay: { type: "api_key", key: "legacy-key" },
			}),
		);
		await writeFile(
			join(root, ".config", "vspi", "runtime-defaults.json"),
			JSON.stringify({
				model: { provider: "relay", id: "reasoner" },
				effort: "high",
			}),
		);

		daemon = await startRuntimeDaemon({
			homeDir: runtimeHome,
			hostIdentity: identity,
			env: { ...process.env, HOME: root },
		});
		let connection = await connectRuntime(runtimeHome);
		expect(
			await connection.klient.global.kosong.getProvider("relay"),
		).toMatchObject({
			id: "relay",
			type: "openai_responses",
			base_url: "https://relay.example/v1",
			has_api_key: true,
			models: expect.arrayContaining(["relay/reasoner", "relay/gpt-5.6-sol"]),
		});
		expect(await connection.klient.global.config.get("defaultModel")).toBe(
			"relay/reasoner",
		);
		expect(await connection.klient.global.config.get("thinking")).toEqual({ effort: "off" });
		expect(
			await connection.klient.global.kosong.listProviders(),
		).not.toContainEqual(
			expect.objectContaining({
				id: "custom-gemini-via-legacybridge-32efcb06",
			}),
		);
		expect(await connection.klient.global.kosong.listModels()).toContainEqual(
			expect.objectContaining({
				provider: "relay",
				model: "relay/reasoner",
				max_context_size: 200_000,
				capabilities: expect.arrayContaining(["image_in", "thinking"]),
				support_efforts: expect.arrayContaining(["low", "high"]),
			}),
		);
		const migratedModels =
			await connection.klient.global.config.inspect<
				Record<string, Record<string, unknown>>
			>("models");
		expect(migratedModels.userValue?.["relay/reasoner"]).toMatchObject({
			protocol: "openai_responses",
			displayName: "Reasoner",
			maxContextSize: 200_000,
		});
		expect(
			migratedModels.userValue?.["relay/reasoner"]?.["baseUrl"],
		).toBeUndefined();
		const unverifiedModel = migratedModels.userValue?.["relay/gpt-5.6-sol"];
		expect(unverifiedModel?.["capabilities"]).toBeUndefined();
		expect(unverifiedModel?.["supportEfforts"]).toBeUndefined();
		expect(unverifiedModel?.["defaultEffort"]).toBeUndefined();

		const providers =
			await connection.klient.global.config.inspect<
				Record<string, Record<string, unknown>>
			>("providers");
		await connection.klient.global.config.replace({
			domain: "providers",
			value: {
				...providers.userValue,
				relay: { ...providers.userValue?.["relay"], apiKey: "new-key" },
			},
		});
		await connection.klient.global.config.replace({
			domain: "thinking",
			value: { effort: "off" },
		});
		await connection.klient.global.config.replace({
			domain: "defaultModel",
			value: "relay/gpt-5.6-sol",
		});
		await connection.close();
		await daemon.close();
		daemon = await startRuntimeDaemon({
			homeDir: runtimeHome,
			hostIdentity: identity,
			env: { ...process.env, HOME: root },
		});
		connection = await connectRuntime(runtimeHome);
		try {
			const current =
				await connection.klient.global.config.inspect<
					Record<string, Record<string, unknown>>
				>("providers");
			expect(current.userValue?.["relay"]?.["apiKey"]).toBe("new-key");
			const currentModels =
				await connection.klient.global.config.inspect<
					Record<string, Record<string, unknown>>
				>("models");
			const currentUnverifiedModel = currentModels.userValue?.["relay/gpt-5.6-sol"];
			expect(currentUnverifiedModel?.["capabilities"]).toBeUndefined();
			expect(currentUnverifiedModel?.["supportEfforts"]).toBeUndefined();
			expect(currentUnverifiedModel?.["defaultEffort"]).toBeUndefined();
			expect(await connection.klient.global.config.get("thinking")).toEqual({ effort: "off" });
			expect(await connection.klient.global.config.get("defaultModel")).toBe("relay/gpt-5.6-sol");
		} finally {
			await connection.close();
		}
	});
});

function startTestDaemon(homeDir: string): Promise<RuntimeDaemon> {
	return startRuntimeDaemon({
		homeDir,
		hostIdentity: identity,
		env: { ...process.env, HOME: homeDir },
	});
}
