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
