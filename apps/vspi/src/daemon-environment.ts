import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function prepareDaemonEnvironment(
	environment: NodeJS.ProcessEnv,
	options: { homeDir: string; entryPath: string; nodePath: string },
): Promise<NodeJS.ProcessEnv> {
	const identity = createHash("sha256").update(`${options.nodePath}\0${options.entryPath}`).digest("hex").slice(0, 16);
	const directory = join(options.homeDir, "server", "cli", identity);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
	const shellPath = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/") : value;
	const batchPath = (value: string) => value.replaceAll("%", "%%");
	const launchers = {
		vspi: `#!/bin/sh\nif [ -z "$VSPI_HOME" ]; then export VSPI_HOME=${quote(options.homeDir)}; fi\nexec ${quote(shellPath(options.nodePath))} ${quote(shellPath(options.entryPath))} "$@"\n`,
		"vspi.cmd": `@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not defined VSPI_HOME set "VSPI_HOME=${batchPath(options.homeDir)}"\r\n"${batchPath(options.nodePath)}" "${batchPath(options.entryPath)}" %*\r\n`,
	};
	for (const [name, content] of Object.entries(launchers)) {
		const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, content, { mode: 0o700 });
			await rename(temporary, join(directory, name));
		} finally {
			await rm(temporary, { force: true });
		}
	}
	const clean = daemonEnvironment(environment);
	const pathKey = process.platform === "win32"
		? Object.keys(clean).find((key) => key.toLowerCase() === "path") ?? "PATH"
		: "PATH";
	const existingPath = clean[pathKey];
	if (process.platform === "win32") {
		for (const key of Object.keys(clean)) {
			if (key.toLowerCase() === "path") delete clean[key];
		}
	}
	return { ...clean, PATH: [directory, existingPath].filter(Boolean).join(delimiter) };
}

export function daemonEnvironment(
	environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const { VSPI_HOME: _vspiHome, ...clean } = environment;
	return clean;
}

export function parseDaemonHomeDir(args: readonly string[]): string | undefined {
	const index = args.indexOf("--home-dir");
	if (index === -1) return undefined;
	const homeDir = args[index + 1];
	if (homeDir === undefined || homeDir.length === 0) {
		throw new Error("Missing value for --home-dir");
	}
	return homeDir;
}
