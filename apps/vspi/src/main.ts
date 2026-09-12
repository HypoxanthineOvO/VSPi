import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	connectRuntime,
	ensureRuntime,
	inspectRuntime,
	resolveRuntimePaths,
	startRuntimeDaemon,
	stopRuntime,
	recoverRuntime,
	type RuntimeConnection,
} from "@vsp/vsp-runtime";

import { dispatchCliCommand } from "./cli-command.js";
import {
	daemonEnvironment,
	prepareDaemonEnvironment,
	parseDaemonHomeDir,
} from "./daemon-environment.js";
import { dispatchExecCommand } from "./exec.js";
import { resolveSessionStartupMode } from "./v1/backend/klient-backend.js";
import { runVspiTui } from "./v1/run.js";
import { VSPI_VERSION } from "./v1/version.js";
import {
	assertCompatibleConnection,
	assertSupportedNodeVersion,
	createExpectedRuntimeIdentity,
	readRuntimeIdentity,
	removeRuntimeIdentity,
	runtimeIdentityMismatch,
	writeRuntimeIdentity,
	type ExpectedRuntimeIdentity,
} from "./runtime-identity.js";
import { configurePackagedRuntimeWorkers } from "./runtime-workers.js";
import { stageRuntimeBuild } from './runtime-build.js';

const identity = {
	productName: "vspi",
	version: VSPI_VERSION,
	platform: "vspi",
	displayName: "VSPi",
};

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (await dispatchCliCommand(args, { connect: ensureConnection, connectReadOnly: () => connectRuntime() })) return;
	assertSupportedNodeVersion();
	if (await dispatchExecCommand(args, { connect: ensureConnection })) return;
	if (args[0] === "daemon") {
		await daemonCommand(args.slice(1));
		return;
	}
	const connection = await ensureConnection();
	try {
		if (args[0] === "web") {
			const workspace = await connection.klient.global.workspaces.createOrTouch(
				{ root: process.cwd() },
			);
			process.stdout.write(
				`VSP Web runtime: http://${connection.state.host}:${String(connection.state.port)}\n`,
			);
			process.stdout.write(`Workspace: ${workspace.root}\n`);
			return;
		}
		if (process.stdin.isTTY && process.stdout.isTTY) {
			await runVspiTui(connection, {
				startupMode: resolveSessionStartupMode(args[0]),
				reconnect: () => ensureConnection(),
			});
			return;
		}
		const workspace = await connection.klient.global.workspaces.createOrTouch({
			root: process.cwd(),
		});
		process.stdout.write(
			`VSPi runtime ready (pid ${String(connection.state.pid)})\n`,
		);
		process.stdout.write(`Workspace: ${workspace.root}\n`);
		process.stdout.write("Interactive TUI requires a terminal.\n");
	} finally {
		await connection.close();
	}
}

async function daemonCommand(args: readonly string[]): Promise<void> {
	const homeDir = parseDaemonHomeDir(args);
	switch (args[0] ?? "status") {
		case "recover": {
			if (!args.includes('--confirm-stopped')) throw new Error('Only after verifying that all daemons for this home have stopped, run vspi daemon recover --confirm-stopped');
			await recoverRuntime(homeDir);
			process.stdout.write('Runtime lock recovery completed; previous lock files were preserved.\n');
			return;
		}
		case "serve":
			await serveDaemon(homeDir);
			return;
		case "start": {
			const connection = await ensureConnection(homeDir);
			process.stdout.write(
				`VSP runtime started at pid ${String(connection.state.pid)}\n`,
			);
			await connection.close();
			return;
		}
		case "status": {
			const state = await inspectRuntime(homeDir);
			if (state === undefined) {
				process.stdout.write("VSP runtime is stopped\n");
				return;
			}
			let connection: RuntimeConnection | undefined;
			try {
				connection = await connectRuntime(homeDir);
				const expected = await expectedRuntimeIdentity(homeDir);
				assertCompatibleConnection(
					expected,
					await readRuntimeIdentity(expected.homeDir),
					connection,
				);
				process.stdout.write(
					`VSP runtime is ready (pid ${String(state.pid)}, http://${state.host}:${String(state.port)}, protocol ${String(state.protocolVersion)})\n`,
				);
			} catch (error) {
				process.stdout.write(
					`VSP runtime process exists but is unreachable: ${error instanceof Error ? error.message : String(error)}\n`,
				);
				process.exitCode = 1;
			} finally {
				await connection?.close();
			}
			return;
		}
		case "stop": {
			const forceLegacy = args.includes('--force-legacy');
			if (forceLegacy) process.stderr.write('Warning: permitting forced termination of an authenticated legacy daemon; all of its tasks must already be finished.\n');
			const stopped = await stopRuntime(homeDir, 30_000, { forceLegacy });
			process.stdout.write(
				stopped ? "VSP runtime stopped\n" : "VSP runtime is already stopped\n",
			);
			return;
		}
		case "logs":
			process.stdout.write(`${resolveRuntimePaths(homeDir).logPath}\n`);
			return;
		default:
			throw new Error("Usage: vspi daemon [start|status|stop|logs]");
	}
}

async function serveDaemon(homeDir?: string): Promise<void> {
	configurePackagedRuntimeWorkers(import.meta.url);
	const expected = await expectedRuntimeIdentity(homeDir);
	const environment = await prepareDaemonEnvironment(process.env, {
		homeDir: expected.homeDir,
		entryPath: import.meta.filename,
		nodePath: process.execPath,
	});
	process.env.PATH = environment.PATH;
	const daemon = await startRuntimeDaemon({
		homeDir: expected.homeDir,
		hostIdentity: identity,
		env: environment,
		skillDirs: [fileURLToPath(new URL("../skills", import.meta.url))],
	});
	try {
		await writeRuntimeIdentity(expected, daemon.state.pid);
	} catch (error) {
		await daemon.close();
		throw error;
	}
	let closing = false;
	const diagnostic = (event: string, signal?: string) => {
		const memory = process.memoryUsage();
		process.stderr.write(`${JSON.stringify({ event, time: new Date().toISOString(), pid: process.pid, signal, uptimeSeconds: Math.round(process.uptime()), rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal })}\n`);
	};
	diagnostic("runtime.ready");
	const memoryTimer = setInterval(() => diagnostic("runtime.memory"), 60_000);
	memoryTimer.unref();
	await new Promise<void>((resolve, reject) => {
		const close = (signal: string): void => {
			if (closing) return;
			closing = true;
			clearInterval(memoryTimer);
			diagnostic("runtime.stopping", signal);
			void (async () => {
				try {
					await daemon.close();
					await removeRuntimeIdentity(expected.homeDir, daemon.state.pid);
					diagnostic("runtime.stopped", signal);
					resolve();
				} catch (error) {
					reject(error);
				}
			})();
		};
		process.once("SIGINT", () => close("SIGINT"));
		process.once("SIGTERM", () => close("SIGTERM"));
		void daemon.closed.then(async () => {
			clearInterval(memoryTimer);
			await removeRuntimeIdentity(expected.homeDir, daemon.state.pid);
			diagnostic("runtime.stopped", "shutdown");
			resolve();
		}).catch(reject);
	});
}

async function ensureConnection(homeDir?: string): Promise<RuntimeConnection> {
	const expected = await expectedRuntimeIdentity(homeDir);
	const running = await inspectRuntime(expected.homeDir);
	if (running !== undefined) {
		const metadata =
			(await readRuntimeIdentity(expected.homeDir)) ??
			(await waitForRuntimeIdentity(expected.homeDir, running.pid, 250));
		const mismatch = runtimeIdentityMismatch(expected, metadata, running);
		if (mismatch !== undefined) {
			throw new Error(`VSP runtime 身份不匹配（${mismatch}）。现有 daemon 和任务保持运行；请使用相同版本的客户端，或使用独立 VSPI_HOME。确认所有任务结束后，才可显式运行 vspi daemon stop 切换版本。`);
		}
	}
	const connection = await ensureRuntime({
		homeDir: expected.homeDir,
		spawn: async ({ homeDir: runtimeHomeDir, logPath }) => {
			const runtimePaths = resolveRuntimePaths(runtimeHomeDir);
			const diagnosticDir = join(runtimePaths.serverDir, "diagnostics");
			mkdirSync(runtimePaths.serverDir, {
				recursive: true,
				mode: 0o700,
			});
			mkdirSync(diagnosticDir, { recursive: true, mode: 0o700 });
			const logFd = openSync(logPath, "a", 0o600);
			try {
				const entry = await stageRuntimeBuild(import.meta.filename, runtimeHomeDir, expected.buildId);
				const child = spawn(
					process.execPath,
					[
						...process.execArgv,
						"--report-on-fatalerror",
						`--diagnostic-dir=${diagnosticDir}`,
						entry,
						"daemon",
						"serve",
						"--home-dir",
						runtimeHomeDir,
					],
					{
						detached: true,
						cwd: runtimePaths.serverDir,
						stdio: ["ignore", logFd, logFd],
						env: daemonEnvironment(process.env),
						windowsHide: true,
					},
				);
				child.unref();
			} finally {
				closeSync(logFd);
			}
		},
	});
	try {
		const metadata = await waitForRuntimeIdentity(
			expected.homeDir,
			connection.state.pid,
		);
		assertCompatibleConnection(expected, metadata, connection);
		return connection;
	} catch (error) {
		await connection.close();
		throw error;
	}
}

const expectedRuntimeIdentities = new Map<
	string,
	Promise<ExpectedRuntimeIdentity>
>();

function expectedRuntimeIdentity(
	homeDir?: string,
): Promise<ExpectedRuntimeIdentity> {
	const resolvedHomeDir = resolveRuntimePaths(homeDir).homeDir;
	let expected = expectedRuntimeIdentities.get(resolvedHomeDir);
	if (expected === undefined) {
		expected = createExpectedRuntimeIdentity({
			entryPath: import.meta.filename,
			homeDir: resolvedHomeDir,
			productName: identity.productName,
			version: identity.version,
			platform: identity.platform,
		});
		expectedRuntimeIdentities.set(resolvedHomeDir, expected);
	}
	return expected;
}

async function waitForRuntimeIdentity(
	homeDir: string,
	pid: number,
	timeoutMs = 1_000,
): Promise<Awaited<ReturnType<typeof readRuntimeIdentity>>> {
	const deadline = Date.now() + timeoutMs;
	do {
		const metadata = await readRuntimeIdentity(homeDir);
		if (metadata?.pid === pid) return metadata;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	} while (Date.now() < deadline);
	return readRuntimeIdentity(homeDir);
}

try {
	await main();
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
