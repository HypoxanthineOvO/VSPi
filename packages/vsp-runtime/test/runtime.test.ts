/**
 * Scenario: one VSP daemon exposes a shared Kimi Core over IPC.
 * Responsibilities: public connection, workspace persistence, exclusive ownership, cleanup.
 * Wiring: real KAP/Core/Klient with isolated filesystem state and no model network calls.
 * Run: pnpm -C packages/vsp-runtime test
 */
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes, readdir, link, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSkillText } from "@moonshot-ai/agent-core-v2/features/skill/catalog/parser";
import { InMemorySkillCatalog } from "@moonshot-ai/agent-core-v2/features/skill/catalog/registry";

import {
	connectRuntime,
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
