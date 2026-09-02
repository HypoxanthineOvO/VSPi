import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";

import {
	connectRuntime,
	ensureRuntime,
	inspectRuntime,
	resolveRuntimePaths,
	startRuntimeDaemon,
	stopRuntime,
	type RuntimeConnection,
} from "@vsp/vsp-runtime";

import { dispatchCliCommand } from "./cli-command.js";
import {
	daemonEnvironment,
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

const identity = {
	productName: "vspi",
	version: VSPI_VERSION,
	platform: "vspi",
	displayName: "VSPi",
};

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (await dispatchCliCommand(args)) return;
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
			const stopped = await stopRuntime(homeDir);
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
	const daemon = await startRuntimeDaemon({
		homeDir: expected.homeDir,
		hostIdentity: identity,
		env: daemonEnvironment(process.env),
	});
	try {
		await writeRuntimeIdentity(expected, daemon.state.pid);
	} catch (error) {
		await daemon.close();
		throw error;
	}
	let closing = false;
	await new Promise<void>((resolve, reject) => {
		const close = (): void => {
			if (closing) return;
			closing = true;
			void (async () => {
				try {
					await daemon.close();
					await removeRuntimeIdentity(expected.homeDir, daemon.state.pid);
					resolve();
				} catch (error) {
					reject(error);
				}
			})();
		};
		process.once("SIGINT", close);
		process.once("SIGTERM", close);
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
		if (mismatch !== undefined) await stopRuntime(expected.homeDir, 5_000);
	}
	const connection = await ensureRuntime({
		homeDir: expected.homeDir,
		spawn: ({ homeDir: runtimeHomeDir, logPath }) => {
			mkdirSync(resolveRuntimePaths(runtimeHomeDir).serverDir, {
				recursive: true,
				mode: 0o700,
			});
			const logFd = openSync(logPath, "a", 0o600);
			try {
				const entry = import.meta.filename;
				const child = spawn(
					process.execPath,
					[
						...process.execArgv,
						entry,
						"daemon",
						"serve",
						"--home-dir",
						runtimeHomeDir,
					],
					{
						detached: true,
						stdio: ["ignore", logFd, logFd],
						env: daemonEnvironment(process.env),
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
		await stopRuntime(expected.homeDir, 5_000).catch(() => {});
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
