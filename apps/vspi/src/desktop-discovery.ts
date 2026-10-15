import { readFile } from "node:fs/promises";

import { resolveRuntimePaths, type RuntimeConnection } from "@vsp/vsp-runtime";

export interface DesktopDiscoveryInput {
	once(event: "close" | "end" | "error", listener: (error?: Error) => void): unknown;
	removeListener(
		event: "close" | "end" | "error",
		listener: (error?: Error) => void,
	): unknown;
	resume(): unknown;
	pause(): unknown;
}

export interface DesktopDiscoveryOutput {
	readonly isTTY?: boolean;
	write(line: string): unknown;
}

export async function runDesktopDiscovery(options: {
	connect: () => Promise<RuntimeConnection>;
	input: DesktopDiscoveryInput;
	output: DesktopDiscoveryOutput;
}): Promise<void> {
	if (options.output.isTTY === true) {
		throw new Error(
			"vspi daemon desktop emits a runtime bearer token and refuses an interactive terminal",
		);
	}
	let detached = false;
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const detach = (): void => {
		if (detached) return;
		detached = true;
		finish();
	};
	options.input.once("end", detach);
	options.input.once("error", detach);
	options.input.once("close", detach);
	const onSigint = (): void => detach();
	const onSigterm = (): void => detach();
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	options.input.resume();
	try {
		const connection = await options.connect();
		try {
			if (!detached) {
				if (connection.state.runtimeId === undefined) {
					throw new Error("VSP runtime does not expose a stable runtime identity");
				}
				const token = (
					await readFile(
						resolveRuntimePaths(connection.env.homeDir).tokenPath,
						"utf8",
					)
				).trim();
				if (token.length === 0) throw new Error("VSP runtime token is empty");
				if (!detached) {
					options.output.write(
						`${JSON.stringify({
							desktopProtocol: 1,
							protocolVersion: connection.state.protocolVersion,
							runtimeId: connection.state.runtimeId,
							version: connection.state.version,
							homeDir: connection.env.homeDir,
							ipcPath: connection.state.ipcPath,
							httpPort: connection.state.port,
							token,
						})}\n`,
					);
				}
			}
			await finished;
		} finally {
			await connection.close();
		}
	} finally {
		options.input.removeListener("end", detach);
		options.input.removeListener("error", detach);
		options.input.removeListener("close", detach);
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
		options.input.pause();
	}
}
