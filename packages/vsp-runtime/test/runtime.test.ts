/**
 * Scenario: one VSP daemon exposes a shared Kimi Core over IPC.
 * Responsibilities: public connection, workspace persistence, exclusive ownership, cleanup.
 * Wiring: real KAP/Core/Klient with isolated filesystem state and no model network calls.
 * Run: pnpm -C packages/vsp-runtime test
 */
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes, readdir, link, rename } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSkillText } from "@moonshot-ai/agent-core-v2/features/skill/catalog/parser";
import { InMemorySkillCatalog } from "@moonshot-ai/agent-core-v2/features/skill/catalog/registry";
import { IAgentLifecycleService, ISessionManager, AgentGoal } from '@moonshot-ai/agent-core-v2';
import { startServer } from '@moonshot-ai/kap-server';

import {
	connectRuntime,
	reconnectRuntime,
	RuntimeStoppedError,
	inspectRuntimeActivity,
	ensureRuntime,
	inspectRuntime,
	resolveRuntimePaths,
	stopRuntime,
	RuntimeAlreadyRunningError,
	startRuntimeDaemon,
	recoverRuntime,
	acquireRuntimeLease,
	type RuntimeDaemon,
} from "../src/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, link: vi.fn(original.link), rename: vi.fn(original.rename) };
});

const identity = {
	productName: "vspi-test",
	version: "0.1.0-test",
	platform: "vspi_test",
	displayName: "VSPi Test",
};

describe("VSP runtime daemon (shared Core ownership)", () => {
	let homeDir: string | undefined;
	let daemon: RuntimeDaemon | undefined;
	let closePeer: (() => Promise<void>) | undefined;

	it("persists per-model efforts with exact alias keys while preserving other thinking settings", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-model-efforts-"));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await connection.klient.global.config.set({ domain: "thinking", patch: { effort: "low", keep: "all" } });
			await connection.klient.global.config.set({ domain: "thinking", patch: { modelEfforts: { "Example/Code_Model": "max" } } });
			await connection.klient.global.config.set({ domain: "thinking", patch: { modelEfforts: { "Other/Code_Model": "high" } } });
			await connection.klient.global.config.reload();
			expect(await connection.klient.global.config.get("thinking")).toMatchObject({ effort: "low", keep: "all", modelEfforts: { "Example/Code_Model": "max", "Other/Code_Model": "high" } });
			const disk = await readFile(resolveRuntimePaths(homeDir).configPath, "utf8");
			expect(disk).toContain('"Example/Code_Model"');
		} finally { await connection.close(); }
	});

	it('uses bounded VSP retry defaults without shortening the subagent task deadline', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-retry-defaults-'));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			expect(await connection.klient.global.config.get('loopControl')).toMatchObject({ maxAttemptsPerStep: 3, retryBudgetMs: 120_000, requestIdleTimeoutMs: 300_000 });
			expect(await connection.klient.global.config.get('subagent')).toMatchObject({ timeoutMs: 7_200_000 });
		} finally { await connection.close(); }
	});

	it('defaults the VSPLab route to cn and preserves an explicit tech selection across restart', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-endpoint-choice-'));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			expect(await connection.klient.global.config.get('vsplab')).toEqual({ endpoint: 'cn' });
			await connection.klient.global.config.replaceSections({ sections: {
				providers: { vsplab: { type: 'openai', apiKey: 'YOUR_API_KEY', baseUrl: 'https://api.vsplab.tech/v1', source: { enabled: false } }, custom: { type: 'openai', baseUrl: 'https://relay.example.test/v1' } },
				models: { 'vsplab/code': { provider: 'vsplab', model: 'code', baseUrl: 'https://api.vsplab.tech/v1' }, 'vsplab/custom': { provider: 'vsplab', model: 'custom', baseUrl: 'https://relay.example.test/v1' } },
			} });
			expect(await connection.klient.global.config.get('providers')).toMatchObject({ vsplab: { baseUrl: 'https://api.vsplab.cn/v1' }, custom: { baseUrl: 'https://relay.example.test/v1' } });
			expect(await connection.klient.global.config.get('models')).toMatchObject({ 'vsplab/code': { baseUrl: 'https://api.vsplab.cn/v1' }, 'vsplab/custom': { baseUrl: 'https://relay.example.test/v1' } });
			await connection.klient.global.config.set({ domain: 'vsplab', patch: { endpoint: 'tech' } });
			await connection.klient.global.config.reload();
			expect(await connection.klient.global.config.get('providers')).toMatchObject({ vsplab: { baseUrl: 'https://api.vsplab.tech/v1' } });
		} finally { await connection.close(); }
		await daemon.close();
		daemon = await startTestDaemon(homeDir);
		const restarted = await connectRuntime(homeDir);
		try {
			expect(await restarted.klient.global.config.get('vsplab')).toEqual({ endpoint: 'tech' });
			expect(await restarted.klient.global.config.get('providers')).toMatchObject({ vsplab: { baseUrl: 'https://api.vsplab.tech/v1' }, custom: { baseUrl: 'https://relay.example.test/v1' } });
			expect(await restarted.klient.global.config.get('models')).toMatchObject({ 'vsplab/code': { baseUrl: 'https://api.vsplab.tech/v1' }, 'vsplab/custom': { baseUrl: 'https://relay.example.test/v1' } });
			await restarted.klient.global.config.set({ domain: 'vsplab', patch: { endpoint: 'cn' } });
			expect(await restarted.klient.global.config.get('providers')).toMatchObject({ vsplab: { baseUrl: 'https://api.vsplab.cn/v1' } });
		} finally { await restarted.close(); }
	});

	it('preserves explicit retry settings over the VSP defaults', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-retry-settings-'));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await connection.klient.global.config.set({ domain: 'loopControl', patch: { maxAttemptsPerStep: 2, retryBudgetMs: 1_000, requestIdleTimeoutMs: 2_000 } });
			expect(await connection.klient.global.config.get('loopControl')).toMatchObject({ maxAttemptsPerStep: 2, retryBudgetMs: 1_000, requestIdleTimeoutMs: 2_000 });
		} finally { await connection.close(); }
	});

	afterEach(async () => {
		vi.mocked(link).mockRestore();
		vi.mocked(rename).mockRestore();
		await closePeer?.();
		closePeer = undefined;
		await daemon?.close();
		daemon = undefined;
		if (homeDir !== undefined)
			await rm(homeDir, { recursive: true, force: true });
		homeDir = undefined;
	});

	it('publishes one complete lease owner when two starters race', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-race-'));
		const path = resolveRuntimePaths(homeDir).leasePath;
		const results = await Promise.allSettled([acquireRuntimeLease(path), acquireRuntimeLease(path)]);
		try {
			expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
			expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: process.pid, ownerNonce: expect.any(String) });
		} finally { for (const result of results) if (result.status === 'fulfilled') await result.value.release(); }
	});

	it('quarantines an old corrupt lease only through confirmed recovery', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-recovery-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		await writeFile(paths.leasePath, '');
		await utimes(paths.leasePath, new Date(0), new Date(0));
		await expect(acquireRuntimeLease(paths.leasePath)).rejects.toThrow('recover --confirm-stopped');
		await recoverRuntime(homeDir);
		expect((await readdir(paths.serverDir)).some(name => name.startsWith('runtime.lock.recovered.'))).toBe(true);
		const lease = await acquireRuntimeLease(paths.leasePath);
		await lease.release();
	});

	function exitedLeaseOwner(ownerNonce: string) {
		const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
		if (child.error) throw child.error;
		if (!child.pid || child.status !== 0) throw new Error('Could not create an exited owner fixture');
		return { pid: child.pid, ownerNonce };
	}

	function operationGate() {
		let resolve!: () => void;
		const promise = new Promise<void>((release) => { resolve = release; });
		return { promise, resolve };
	}

	it('blocks a concurrent starter while confirmed recovery is moving the old primary lock', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-recovery-interleave-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		const previous = exitedLeaseOwner('previous-owner');
		await writeFile(paths.leasePath, JSON.stringify(previous));
		const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		const paused = operationGate();
		const resume = operationGate();
		vi.mocked(rename).mockImplementation(async (from, to) => {
			if (String(from) === paths.leasePath) {
				paused.resolve();
				await resume.promise;
			}
			await original.rename(from, to);
		});
		const recovery = recoverRuntime(homeDir);
		let contender: Awaited<ReturnType<typeof acquireRuntimeLease>> | undefined;
		try {
			await Promise.race([paused.promise, recovery.then(() => { throw new Error('Recovery did not reach the rename boundary'); })]);
			const failure = await acquireRuntimeLease(paths.leasePath).then(value => { contender = value; return undefined; }, error => error);
			expect(failure).toBeInstanceOf(RuntimeAlreadyRunningError);
			expect(JSON.parse(await readFile(paths.leasePath, 'utf8'))).toEqual(previous);
			resume.resolve();
			await recovery;
			const next = await acquireRuntimeLease(paths.leasePath);
			try {
				expect(JSON.parse(await readFile(paths.leasePath, 'utf8'))).toEqual({ pid: process.pid, ownerNonce: next.ownerNonce });
			} finally { await next.release(); }
		} finally {
			resume.resolve();
			await recovery.catch(() => {});
			await contender?.release();
		}
	});

	it('blocks confirmed recovery while a starter is publishing its new primary owner', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-start-interleave-'));
		const paths = resolveRuntimePaths(homeDir);
		const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		const paused = operationGate();
		const resume = operationGate();
		vi.mocked(link).mockImplementation(async (from, to) => {
			if (String(to) === paths.leasePath) {
				paused.resolve();
				await resume.promise;
			}
			await original.link(from, to);
		});
		const started = acquireRuntimeLease(paths.leasePath);
		try {
			await Promise.race([paused.promise, started.then(() => { throw new Error('Starter did not reach the publication boundary'); })]);
			await expect(recoverRuntime(homeDir)).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);
			resume.resolve();
			const lease = await started;
			expect(JSON.parse(await readFile(paths.leasePath, 'utf8'))).toEqual({ pid: process.pid, ownerNonce: lease.ownerNonce });
		} finally {
			resume.resolve();
			await (await started).release();
		}
	});

	it('preserves the new primary generation when ownership changes during confirmed recovery', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-generation-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		const previous = exitedLeaseOwner('previous-owner');
		await writeFile(paths.leasePath, JSON.stringify(previous));
		const next = { pid: process.pid, ownerNonce: 'new-owner' };
		const originalKill = process.kill;
		let observed = false;
		const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
			if (pid === previous.pid && signal === 0 && !observed) {
				observed = true;
				writeFileSync(paths.leasePath, JSON.stringify(next));
				throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
			}
			return originalKill(pid, signal);
		});
		try {
			await expect(recoverRuntime(homeDir)).rejects.toThrow('ownership changed');
			expect(JSON.parse(await readFile(paths.leasePath, 'utf8'))).toEqual(next);
		} finally { kill.mockRestore(); }
	});

	it('recovers a complete dead recovery claim without dropping the winning starter owner', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-stale-claim-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		const previous = exitedLeaseOwner('previous-recovery-owner');
		await writeFile(`${paths.leasePath}.recovery`, JSON.stringify(previous));
		const results = await Promise.allSettled([acquireRuntimeLease(paths.leasePath), acquireRuntimeLease(paths.leasePath)]);
		try {
			expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
			const active = results.find(result => result.status === 'fulfilled');
			if (active?.status !== 'fulfilled') throw new Error('No starter acquired the lock');
			expect(JSON.parse(await readFile(paths.leasePath, 'utf8'))).toEqual({ pid: process.pid, ownerNonce: active.value.ownerNonce });
			const backups = (await readdir(paths.serverDir)).filter(name => name.startsWith('runtime.lock.recovery.recovered.'));
			expect(backups).toHaveLength(1);
			expect(JSON.parse(await readFile(join(paths.serverDir, backups[0]!), 'utf8'))).toEqual(previous);
		} finally { for (const result of results) if (result.status === 'fulfilled') await result.value.release(); }
	});

	it('preserves an ownerless recovery claim regardless of its age', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-corrupt-claim-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		const claim = `${paths.leasePath}.recovery`;
		await writeFile(claim, '');
		await utimes(claim, new Date(0), new Date(0));
		await expect(recoverRuntime(homeDir)).rejects.toThrow('unknown recovery-claim owner requires manual inspection');
		expect(await readFile(claim, 'utf8')).toBe('');
		expect(await readdir(paths.serverDir)).toEqual(['runtime.lock.recovery']);
	});

	it('refuses recursive reclamation when a reclamation claim already remains', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-reclaim-residue-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		const previous = exitedLeaseOwner('previous-recovery-owner');
		const body = JSON.stringify(previous);
		await writeFile(`${paths.leasePath}.recovery`, body);
		await writeFile(`${paths.leasePath}.recovery.reclaim`, body);
		await expect(recoverRuntime(homeDir)).rejects.toThrow('manual inspection');
		expect(await readFile(`${paths.leasePath}.recovery`, 'utf8')).toBe(body);
		expect(await readFile(`${paths.leasePath}.recovery.reclaim`, 'utf8')).toBe(body);
	});

	it('preserves a fresh corrupt primary lock during confirmed recovery', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-fresh-corrupt-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		await writeFile(paths.leasePath, '');
		await utimes(paths.leasePath, new Date(), new Date(Date.now() + 60_000));
		await expect(recoverRuntime(homeDir)).rejects.toThrow('may still be initializing');
		expect(await readFile(paths.leasePath, 'utf8')).toBe('');
	});

	it('refuses lock recovery while the authenticated runtime process remains alive', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-lease-live-'));
		daemon = await startTestDaemon(homeDir);
		await expect(recoverRuntime(homeDir)).rejects.toThrow('still alive');
		expect(JSON.parse(await readFile(resolveRuntimePaths(homeDir).leasePath, 'utf8'))).toHaveProperty('ownerNonce', daemon.state.ownerNonce);
	});

	async function connectionPeer(replyHello = true) {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-peer-"));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			let pending = "";
			socket.on("data", (chunk) => {
				pending += chunk.toString("utf8");
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const frame = JSON.parse(line);
					if (frame.type === "hello" && replyHello) {
						socket.write(`${JSON.stringify({ type: "hello_result", data: { pid: process.pid, ownerNonce: "test-owner", homeDir } })}\n`);
					}
					if (frame.type === "call" && frame.service === "bootstrapService") {
						const data = frame.method === "clientIdentity" ? { productName: "test", version: "test", platform: "test" } : homeDir;
						socket.write(`${JSON.stringify({ type: "result", id: frame.id, data })}\n`);
					}
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(paths.ipcPath, resolve));
		closePeer = async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
		};
		await writeFile(paths.statePath, JSON.stringify({ protocolVersion: 1, pid: process.pid, ownerNonce: "test-owner", host: "127.0.0.1", port: 1, ipcPath: paths.ipcPath, startedAt: new Date().toISOString(), version: "test" }));
		await writeFile(paths.tokenPath, "TEST_ONLY_TOKEN");
		return paths;
	}

	it("uses the configured RPC deadline when reusing an existing daemon", async () => {
		await connectionPeer();
		const connection = await ensureRuntime({ homeDir, callTimeoutMs: 25, spawn: () => { throw new Error("Must reuse the existing daemon"); } });
		try {
			await expect(connection.klient.global.workspaces.list()).rejects.toThrow("call timed out after 25ms");
		} finally { await connection.close(); }
	});

	it("rejects a nonresponsive handshake within the connection deadline", async () => {
		await connectionPeer(false);
		await expect(connectRuntime(homeDir, { connectionTimeoutMs: 25, callTimeoutMs: 0 })).rejects.toThrow("handshake timed out");
	});

	it("does not signal a daemon when its ownership handshake times out", async () => {
		await connectionPeer(false);
		const kill = vi.spyOn(process, "kill");
		try {
			await expect(stopRuntime(homeDir, 25)).rejects.toThrow("handshake timed out");
			expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
		} finally { kill.mockRestore(); }
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

	it("does not stop or replace a live runtime when its protocol is incompatible", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-preserve-"));
		daemon = await startTestDaemon(homeDir);
		const statePath = resolveRuntimePaths(homeDir).statePath;
		const original = await readFile(statePath, "utf8");
		const state = JSON.parse(original);
		await writeFile(statePath, JSON.stringify({ ...state, protocolVersion: 999 }));
		const spawn = vi.fn();
		const kill = vi.spyOn(process, "kill");
		try {
			await expect(ensureRuntime({ homeDir, spawn })).rejects.toThrow("has not been stopped");
			expect(spawn).not.toHaveBeenCalled();
			expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
			await writeFile(statePath, original);
			const client = await connectRuntime(homeDir);
			await client.close();
		} finally { kill.mockRestore(); await writeFile(statePath, original); }
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

	it("persists removal of the subagent candidate pool across config reload", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-star-config-"));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await connection.klient.global.config.replaceSections({ sections: {
				providers: { example: { type: "openai", apiKey: "YOUR_API_KEY" } },
				models: { "example/code": { provider: "example", model: "code", maxContextSize: 4096 } },
			} });
			await connection.klient.global.config.replace({ domain: "secondaryModel", value: { models: { "example/code": "Coding tasks" }, defaultModel: "example/code" } });
			await connection.klient.global.config.replace({ domain: "secondaryModel", value: { force: false } });
			await connection.klient.global.config.reload();
			expect(await connection.klient.global.config.get("secondaryModel")).toEqual({ force: false });
			const disk = await readFile(resolveRuntimePaths(homeDir).configPath, "utf8");
			expect(disk).not.toContain("Coding tasks");
		} finally { await connection.close(); }
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

	it("exposes host-provided product skills without enabling Kimi product skills", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-runtime-skills-"));
		const skillRoot = fileURLToPath(new URL("../../../apps/vspi/skills", import.meta.url));
		daemon = await startRuntimeDaemon({
			homeDir,
			hostIdentity: identity,
			env: { ...process.env, HOME: homeDir },
			skillDirs: [skillRoot],
		});
		const projectRoot = join(homeDir, "project");
		await mkdir(join(projectRoot, ".git"), { recursive: true });
		const connection = await connectRuntime(homeDir);
		try {
			const session = await connection.klient.global.sessions.create({ workDir: projectRoot });
			const skills = await connection.klient.session(session.id).skills.list();
			expect(skills).toContainEqual(expect.objectContaining({
				name: "vspi-self",
				path: join(skillRoot, "vspi-self", "SKILL.md"),
				description: expect.stringContaining("effort or vision capabilities"),
			}));
			expect(skills.find((skill) => skill.name === "vspi-self")?.disableModelInvocation).not.toBe(true);
			expect(skills).not.toContainEqual(expect.objectContaining({ name: "update-config" }));
		} finally {
			await connection.close();
		}
	});

	it("renders the shipped self skill with the current custom-home session and bounded diagnostics", async () => {
		const skillMdPath = fileURLToPath(new URL("../../../apps/vspi/skills/vspi-self/SKILL.md", import.meta.url));
		const skill = parseSkillText({
			skillMdPath,
			skillDirName: "vspi-self",
			source: "extra",
			text: await readFile(skillMdPath, "utf8"),
		});
		const catalog = new InMemorySkillCatalog();
		catalog.register(skill);
		const prompt = catalog.renderSkillPrompt(skill, "", {
			sessionId: "session-current",
			sessionDir: "/custom/runtime/sessions/workspace-current/session-current",
		});
		expect(catalog.getModelSkillListing()).toContain("vspi-self");
		expect(prompt).toContain("/custom/runtime/sessions/workspace-current/session-current");
		expect(prompt).toContain("vspi inspect session 'session-current'");
		expect(prompt).not.toContain("${KIMI_SESSION_");
		for (const command of ["vspi inspect paths", "vspi inspect models", "vspi config patch", "vspi config diagnostics"])
			expect(prompt).toContain(command);
		expect(prompt).toContain("Never select the newest session");
		expect(prompt).toContain("Do not read OAuth token stores");
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

	it("closes an owned daemon through IPC without sending a termination signal", async () => {
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
			await expect(stopRuntime(homeDir, 2000)).resolves.toBe(true);
			expect(kill).not.toHaveBeenCalledWith(daemon.state.pid, "SIGTERM");
			await expect(daemon.closed).resolves.toBeUndefined();
			await expect(readFile(resolveRuntimePaths(homeDir).leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			kill.mockRestore();
		}
	});

	it('closes idle attached clients during a safe update shutdown', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-idle-update-'));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			expect(await inspectRuntimeActivity(homeDir)).toMatchObject({ busyAgents: [], clients: 1 });
			await expect(stopRuntime(homeDir, 2000, { requireIdle: true })).resolves.toBe(true);
			await expect(daemon.closed).resolves.toBeUndefined();
		} finally { await connection.close(); }
	});

	it('does not restart a runtime after its owner requested shutdown', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-intentional-stop-'));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await stopRuntime(homeDir, 2000);
			await expect(reconnectRuntime(connection)).rejects.toBeInstanceOf(RuntimeStoppedError);
			await expect(inspectRuntime(homeDir)).resolves.toBeUndefined();
		} finally { await connection.close(); }
	});

	it('permits recovery when no matching intentional shutdown was recorded', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-unexpected-disconnect-'));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			const next = await reconnectRuntime(connection);
			try { expect(next.state.ownerNonce).toBe(connection.state.ownerNonce); }
			finally { await next.close(); }
		} finally { await connection.close(); }
	});

	it.each([false, undefined])('refuses passive startup with allowStart %s after an explicit stop', async (allowStart) => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-passive-start-'));
		daemon = await startTestDaemon(homeDir);
		await stopRuntime(homeDir, 2000);
		const spawn = vi.fn();
		await expect(ensureRuntime({ homeDir, spawn, allowStart })).rejects.toBeInstanceOf(RuntimeStoppedError);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('starts a new runtime after an explicit user wakeup', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-user-start-'));
		daemon = await startTestDaemon(homeDir);
		const previousOwner = daemon.state.ownerNonce;
		await stopRuntime(homeDir, 2000);
		const connection = await ensureRuntime({ homeDir, allowStart: true, spawn: async () => { daemon = await startTestDaemon(homeDir!); } });
		try { expect(connection.state.ownerNonce).not.toBe(previousOwner); }
		finally { await connection.close(); }
	});

	it('does not resurrect a stopped runtime when its shutdown markers are missing', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-missing-stop-marker-'));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await stopRuntime(homeDir, 2000);
			const paths = resolveRuntimePaths(homeDir);
			await rm(join(paths.serverDir, 'shutdown-intent.json'));
			await rm(join(paths.serverDir, 'shutdown.json'));
			await expect(reconnectRuntime(connection)).rejects.toThrow('not running');
			await expect(inspectRuntime(homeDir)).resolves.toBeUndefined();
		} finally { await connection.close(); }
	});

	async function daemonWithChild() {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-child-control-'));
		let sessionId = '';
		daemon = await startRuntimeDaemon({
			homeDir, hostIdentity: identity, env: { ...process.env, HOME: homeDir }, idleTimeoutMs: 0,
			startServer: async (options) => {
				const server = await startServer(options);
				const session = await server.core.accessor.get(ISessionManager).create({ workDir: homeDir! });
				sessionId = session.id;
				await session.accessor.get(IAgentLifecycleService).create({ agentId: 'child' });
				return server;
			},
		});
		return sessionId;
	}

	it('inspects idle child agents without invoking main-only goals', async () => {
		await daemonWithChild();
		const activity = await inspectRuntimeActivity(homeDir);
		expect(activity).toMatchObject({ busyAgents: [], scheduledAgents: [] });
		expect(activity?.inspectionError).toBeUndefined();
	});

	it('allows safe update shutdown when a live child agent is idle', async () => {
		await daemonWithChild();
		await expect(stopRuntime(homeDir, 2000, { requireIdle: true })).resolves.toBe(true);
		await expect(daemon!.closed).resolves.toBeUndefined();
	});

	it('stops explicitly when a main agent has an active goal', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-broken-goal-stop-'));
		daemon = await startRuntimeDaemon({
			homeDir, hostIdentity: identity, env: { ...process.env, HOME: homeDir }, idleTimeoutMs: 0,
			startServer: async (options) => {
				const server = await startServer(options);
				const session = await server.core.accessor.get(ISessionManager).create({ workDir: homeDir! });
				const agents = session.accessor.get(IAgentLifecycleService);
				await agents.resolve(await agents.create({ agentId: 'main' }), AgentGoal).createGoal({ objective: 'Finish pending work' });
				return server;
			},
		});
		await expect(stopRuntime(homeDir, 2000, { requireIdle: true })).rejects.toThrow('active work');
		await expect(stopRuntime(homeDir, 2000)).resolves.toBe(true);
		await expect(daemon.closed).resolves.toBeUndefined();
	});

	it('resumes a persisted active goal after stop then start without another user prompt', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-goal-restart-'));
		const recoveryPath = join(resolveRuntimePaths(homeDir).serverDir, 'goal-recovery.json');
		let core: Awaited<ReturnType<typeof startServer>>['core'];
		let requests = 0;
		const upstream = createHttpServer((request, response) => {
			request.resume(); requests++;
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'complete-goal', type: 'function', function: { name: 'UpdateGoal', arguments: '{"status":"complete"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const address = upstream.address();
		if (!address || typeof address === 'string') throw new Error('Missing listener');
		try {
			daemon = await startRuntimeDaemon({ homeDir, hostIdentity: identity, env: { ...process.env, HOME: homeDir }, idleTimeoutMs: 0,
				startServer: async options => { const server = await startServer(options); core = server.core; return server; } });
			const connection = await connectRuntime(homeDir);
			let sessionId: string;
			try {
				await connection.klient.global.config.replaceSections({ sections: {
					providers: { example: { type: 'openai', apiKey: 'YOUR_API_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1` } },
					models: { 'example/code': { provider: 'example', model: 'code', maxContextSize: 128000, capabilities: ['tool_use'] } },
					defaultModel: 'example/code', loopControl: { maxStepsPerTurn: 1 },
				} });
				const created = await connection.klient.global.sessions.create({ workDir: homeDir });
				sessionId = created.id;
				await connection.klient.session(sessionId).agent('main').getGoal();
				await connection.klient.session(sessionId).agent('main').setModel('example/code');
				const agents = core!.accessor.get(ISessionManager).get(sessionId)!.accessor.get(IAgentLifecycleService);
				await agents.resolve(agents.get('main')!, AgentGoal).createGoal({ objective: 'Complete after runtime restart' });
				await vi.waitFor(async () => { expect(JSON.parse(await readFile(recoveryPath, 'utf8'))).toContainEqual({ sessionId, goalId: expect.any(String) }); });
			} finally { await connection.close(); }
			await stopRuntime(homeDir);
			await daemon.closed;
			daemon = await startTestDaemon(homeDir);
			const recovered = await connectRuntime(homeDir);
			try {
				await vi.waitFor(async () => {
					const goal = (await recovered.klient.session(sessionId!).agent('main').getGoal()).goal;
					expect(goal, JSON.stringify({ goal, requests })).toBeNull();
					expect(JSON.stringify(await recovered.klient.session(sessionId!).agent('main').getHistory())).toContain('Goal completed successfully');
				});
				expect(requests).toBe(1);
			} finally { await recovered.close(); }
		} finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => { resolve(); })); }
	});

	it.each(['pause', 'cancel'] as const)('does not reactivate a goal after explicit %s then server stop/start', async action => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-goal-explicit-stop-'));
		let core: Awaited<ReturnType<typeof startServer>>['core'];
		daemon = await startRuntimeDaemon({ homeDir, hostIdentity: identity, env: { ...process.env, HOME: homeDir }, idleTimeoutMs: 0,
			startServer: async options => { const server = await startServer(options); core = server.core; return server; } });
		const connection = await connectRuntime(homeDir);
		let sessionId: string;
		try {
			sessionId = (await connection.klient.global.sessions.create({ workDir: homeDir })).id;
			const agent = connection.klient.session(sessionId).agent('main');
			await agent.getGoal();
			const agents = core!.accessor.get(ISessionManager).get(sessionId)!.accessor.get(IAgentLifecycleService);
			await agents.resolve(agents.get('main')!, AgentGoal).createGoal({ objective: 'Do not resume this goal' });
			if (action === 'pause') await agent.pauseGoal({ reason: 'Explicit user pause' });
			else await agent.cancelGoal();
		} finally { await connection.close(); }
		await stopRuntime(homeDir);
		await daemon.closed;
		expect(JSON.parse(await readFile(join(resolveRuntimePaths(homeDir).serverDir, 'goal-recovery.json'), 'utf8'))).toEqual([]);
		daemon = await startTestDaemon(homeDir);
		const restarted = await connectRuntime(homeDir);
		try {
			await restarted.klient.session(sessionId!).restore();
			const goal = (await restarted.klient.session(sessionId!).agent('main').getGoal()).goal;
			if (action === 'pause') expect(goal).toMatchObject({ status: 'paused', terminalReason: 'Explicit user pause' });
			else expect(goal).toBeNull();
		} finally { await restarted.close(); }
	});

	async function legacyControlPeer(ignoreTermination = false) {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-legacy-control-'));
		const paths = resolveRuntimePaths(homeDir);
		await mkdir(paths.serverDir, { recursive: true });
		const child = spawn(process.execPath, ['--input-type=module', '-e', `
			import { createServer } from 'node:net';
			const [home, socketPath, ignoreTermination] = process.argv.slice(1);
			if (ignoreTermination === 'true') process.on('SIGTERM', () => {});
			const server = createServer(socket => {
				let pending = '';
				socket.on('error', () => {});
				socket.on('data', chunk => {
					pending += chunk.toString();
					const lines = pending.split('\\n'); pending = lines.pop();
					for (const line of lines) {
						const frame = JSON.parse(line);
						const reply = frame.type === 'hello'
							? { type: 'hello_result', id: 'hello', data: { pid: process.pid, ownerNonce: 'legacy-owner', homeDir: home, controlProtocol: 1 } }
							: { type: 'error', id: frame.id, code: 50001, msg: 'Goals are only supported by the main agent' };
						socket.write(JSON.stringify(reply) + '\\n');
					}
				});
			});
			server.listen(socketPath, () => process.stdout.write('ready\\n'));
		`, homeDir, paths.ipcPath, String(ignoreTermination)], { stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = once(child, 'exit');
		closePeer = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
		await once(child.stdout, 'data');
		await writeFile(paths.tokenPath, 'TEST_ONLY_TOKEN');
		await writeFile(paths.statePath, JSON.stringify({ protocolVersion: 1, pid: child.pid, ownerNonce: 'legacy-owner', host: '127.0.0.1', port: 1, ipcPath: paths.ipcPath, startedAt: new Date().toISOString(), version: 'legacy' }));
		return { child, exited, paths };
	}

	it('reports unknown activity when the authenticated old daemon rejects inspection', async () => {
		await legacyControlPeer();
		expect(await inspectRuntimeActivity(homeDir)).toMatchObject({ inspectionError: 'Goals are only supported by the main agent' });
	});

	it('terminates an authenticated old daemon when its shutdown control throws', async () => {
		const peer = await legacyControlPeer();
		await expect(stopRuntime(homeDir, 2000)).resolves.toBe(true);
		expect(await peer.exited).toEqual([null, 'SIGTERM']);
		expect(JSON.parse(await readFile(join(peer.paths.serverDir, 'shutdown-intent.json'), 'utf8'))).toMatchObject({ ownerNonce: 'legacy-owner', reason: 'stop' });
	});

	it.skipIf(process.platform === 'win32')('force kills the authenticated daemon when it ignores termination', async () => {
		const peer = await legacyControlPeer(true);
		await expect(stopRuntime(homeDir, 1000)).resolves.toBe(true);
		expect(await peer.exited).toEqual([null, 'SIGKILL']);
	});

	it('rejects a shutdown confirmation for a different runtime owner', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-stale-stop-confirmation-'));
		daemon = await startTestDaemon(homeDir);
		await expect(stopRuntime(homeDir, 2000, { expectedOwnerNonce: 'different-owner' })).rejects.toThrow('changed after confirmation');
		expect(await inspectRuntime(homeDir)).toHaveProperty('pid', daemon.state.pid);
	});

	it('exits automatically after an unattached runtime remains idle', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-auto-idle-'));
		daemon = await startTestDaemon(homeDir, 100);
		await daemon.closed;
		await expect(readFile(resolveRuntimePaths(homeDir).statePath)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(JSON.parse(await readFile(join(resolveRuntimePaths(homeDir).serverDir, 'shutdown-intent.json'), 'utf8'))).toMatchObject({ ownerNonce: daemon.state.ownerNonce, reason: 'idle' });
	});

	it('keeps a scheduled task alive with no attached client', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'vsp-scheduled-idle-'));
		daemon = await startTestDaemon(homeDir, 300);
		const connection = await connectRuntime(homeDir);
		const session = await connection.klient.global.sessions.create({ workDir: homeDir });
		const agent = connection.klient.session(session.id).agent('main');
		const task = await agent.createCronTask({ cron: '0 0 1 1 *', prompt: 'future task', recurring: true });
		await connection.close();
		const witnessHome = await mkdtemp(join(tmpdir(), 'vsp-idle-witness-'));
		const witness = await startTestDaemon(witnessHome, 400);
		try {
			await witness.closed;
			expect(await inspectRuntimeActivity(homeDir)).toMatchObject({ scheduledAgents: [`${session.id}/main`] });
			const next = await connectRuntime(homeDir);
			try { await next.klient.session(session.id).agent('main').deleteCronTask(task.id); }
			finally { await next.close(); }
			await daemon.closed;
		} finally { await witness.close(); await rm(witnessHome, { recursive: true, force: true }); }
	});

	it("refuses invalid TOML without modifying user configuration", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-invalid-config-"));
		await writeFile(resolveRuntimePaths(homeDir).configPath, "[broken");
		await expect(startTestDaemon(homeDir)).rejects.toThrow("Invalid VSPi config.toml");
		expect(await readFile(resolveRuntimePaths(homeDir).configPath, "utf8")).toBe("[broken");
	});

	it("ignores legacy Pi configuration when starting an empty VSPi home", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-no-pi-"));
		const agentDir = join(homeDir, ".pi", "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { relay: { api: "openai", models: [{ id: "old" }] } } }));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			expect(await connection.klient.global.kosong.listModels()).toEqual([]);
		} finally { await connection.close(); }
	});

	it("supplies the approved relay and DeepSeek models without writing a generated model catalog", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-bundled-models-"));
		await writeFile(resolveRuntimePaths(homeDir).configPath, '[providers.vsplab]\ntype = "openai"\n[providers.deepseek]\ntype = "deepseek"\n');
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			const models = await connection.klient.global.kosong.listModels();
			expect(models).toEqual(expect.arrayContaining([
				expect.objectContaining({ model: "vsplab/deepseek-flash", display_name: "DeepSeek V4.1 Flash" }),
				expect.objectContaining({ model: "vsplab/gpt-6-astra", display_name: "GPT-6 Astra" }),
				expect.objectContaining({ model: "deepseek/deepseek-flash", display_name: "DeepSeek V4.1 Flash" }),
			]));
			expect(await readFile(resolveRuntimePaths(homeDir).configPath, "utf8")).not.toContain("[models");
		} finally { await connection.close(); }
	});

	it("preserves a flat user override through refresh and reload without persisting builtin defaults", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-model-overrides-"));
		await writeFile(resolveRuntimePaths(homeDir).configPath, '[providers.vsplab]\ntype = "openai"\n');
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await connection.klient.global.config.set({ domain: "models", patch: { "vsplab/deepseek-flash": { displayName: "My Flash", maxContextSize: 4096 } } });
			await connection.klient.global.kosong.refreshProviders({ providerId: "vsplab" });
			await connection.klient.global.config.reload();
			expect(await connection.klient.global.kosong.listModels()).toEqual(expect.arrayContaining([
				expect.objectContaining({ model: "vsplab/deepseek-flash", display_name: "My Flash", max_context_size: 4096 }),
			]));
			const disk = await readFile(resolveRuntimePaths(homeDir).configPath, "utf8");
			expect(disk).toContain('display_name = "My Flash"');
			expect(disk).not.toContain("gpt-6-astra");
			expect(disk).not.toContain("overrides");
			await connection.klient.global.config.replace({ domain: "models", value: {} });
			expect(await connection.klient.global.kosong.listModels()).toEqual(expect.arrayContaining([
				expect.objectContaining({ model: "vsplab/deepseek-flash", display_name: "DeepSeek V4.1 Flash", max_context_size: 1048576 }),
			]));
		} finally { await connection.close(); }
	});

	it("adds bundled models after configuring a provider on an already running daemon", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-model-provider-change-"));
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await connection.klient.global.config.set({ domain: "providers", patch: { vsplab: { type: "openai" } } });
			expect(await connection.klient.global.kosong.listModels()).toEqual(expect.arrayContaining([
				expect.objectContaining({ model: "vsplab/gpt-6-astra" }),
			]));
		} finally { await connection.close(); }
	});

	it("keeps a flat native-provider thinking override above the shipped effort profile", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-native-effort-"));
		await writeFile(resolveRuntimePaths(homeDir).configPath, '[providers.deepseek]\ntype = "deepseek"\n');
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			await connection.klient.global.config.set({ domain: "models", patch: { "deepseek/deepseek-flash": { thinking: { efforts: ["low", "high"], defaultEffort: "low" } } } });
			expect(await connection.klient.global.kosong.listModels()).toEqual(expect.arrayContaining([
				expect.objectContaining({ model: "deepseek/deepseek-flash", thinking: expect.objectContaining({ efforts: ["low", "high"], default_effort: "low" }) }),
			]));
		} finally { await connection.close(); }
	});

	it("keeps custom provider models separate from builtin defaults", async () => {
		homeDir = await mkdtemp(join(tmpdir(), "vsp-custom-model-"));
		await writeFile(resolveRuntimePaths(homeDir).configPath, '[providers.example]\ntype = "openai"\n[models."example/custom"]\nprovider = "example"\nmodel = "custom"\nmax_context_size = 4096\n');
		daemon = await startTestDaemon(homeDir);
		const connection = await connectRuntime(homeDir);
		try {
			expect((await connection.klient.global.kosong.listModels()).map(model => model.model)).toEqual(["example/custom"]);
		} finally { await connection.close(); }
	});
});

function startTestDaemon(homeDir: string, idleTimeoutMs = 0): Promise<RuntimeDaemon> {
	return startRuntimeDaemon({
		homeDir,
		hostIdentity: identity,
		env: { ...process.env, HOME: homeDir },
		idleTimeoutMs,
	});
}
