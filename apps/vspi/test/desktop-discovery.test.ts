import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths, type RuntimeConnection } from "@vsp/vsp-runtime";

import { runDesktopDiscovery } from "../src/desktop-discovery.js";

describe("vspi daemon desktop discovery", () => {
	const homes: string[] = [];
	afterEach(async () => {
		for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
	});

	async function fixture(stateOverrides: { runtimeId?: string } = {}) {
		const homeDir = await mkdtemp(join(tmpdir(), "vspi-desktop-discovery-"));
		homes.push(homeDir);
		await writeFile(resolveRuntimePaths(homeDir).tokenPath, "TEST_ONLY_TOKEN");
		const connection = {
			state: {
				protocolVersion: 1,
				pid: 4242,
				ownerNonce: "owner-nonce",
				host: "127.0.0.1",
				port: 4321,
				ipcPath: join(homeDir, "server", "runtime.sock"),
				startedAt: new Date().toISOString(),
				version: "9.9.9-test",
				runtimeId: "runtimeId" in stateOverrides ? stateOverrides.runtimeId : "a".repeat(64),
			},
			env: { homeDir },
			klient: {},
			close: vi.fn(async () => {}),
		} as unknown as RuntimeConnection;
		return { homeDir, connection };
	}

	function capture(output: PassThrough): Buffer[] {
		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer) => chunks.push(chunk));
		return chunks;
	}

	it("emits exactly one discovery line and closes only the IPC client on EOF", async () => {
		const { homeDir, connection } = await fixture();
		const input = new PassThrough();
		const output = new PassThrough();
		const chunks = capture(output);
		const run = runDesktopDiscovery({ connect: async () => connection, input, output });
		await once(output, "data");
		input.end();
		await run;
		const text = Buffer.concat(chunks).toString("utf8");
		expect(text.endsWith("\n")).toBe(true);
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({
			desktopProtocol: 1,
			protocolVersion: 1,
			runtimeId: "a".repeat(64),
			version: "9.9.9-test",
			homeDir,
			ipcPath: connection.state.ipcPath,
			httpPort: 4321,
			token: "TEST_ONLY_TOKEN",
		});
		expect(connection.close).toHaveBeenCalledOnce();
	});

	it("closes the pending connection without emitting when stdin ends during connect", async () => {
		const { connection } = await fixture();
		const input = new PassThrough();
		const output = new PassThrough();
		const chunks = capture(output);
		let release!: () => void;
		const connect = vi.fn(
			() => new Promise<RuntimeConnection>((resolve) => {
				release = () => resolve(connection);
			}),
		);
		const run = runDesktopDiscovery({ connect, input, output });
		input.end();
		await new Promise((resolve) => setImmediate(resolve));
		release();
		await run;
		expect(Buffer.concat(chunks).toString("utf8")).toBe("");
		expect(connection.close).toHaveBeenCalledOnce();
	});

	it("refuses an interactive terminal before connecting", async () => {
		const input = new PassThrough();
		const output = Object.assign(new PassThrough(), { isTTY: true });
		const connect = vi.fn();
		await expect(runDesktopDiscovery({ connect, input, output })).rejects.toThrow("interactive terminal");
		expect(connect).not.toHaveBeenCalled();
	});

	it("rejects a runtime without a stable identity and still closes the client", async () => {
		const { connection } = await fixture({ runtimeId: undefined });
		const input = new PassThrough();
		const output = new PassThrough();
		const chunks = capture(output);
		await expect(runDesktopDiscovery({ connect: async () => connection, input, output })).rejects.toThrow("stable runtime identity");
		expect(chunks).toHaveLength(0);
		expect(connection.close).toHaveBeenCalledOnce();
		expect(input.listenerCount("end")).toBe(0);
		expect(input.listenerCount("error")).toBe(0);
		expect(input.listenerCount("close")).toBe(0);
	});
});
