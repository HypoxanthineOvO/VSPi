import { updateVspi, type SelfUpdateResult } from "./v1/update/self-update.js";
import { VSPI_VERSION } from "./v1/version.js";

export interface CliCommandDependencies {
	readonly update?: (currentVersion: string) => Promise<SelfUpdateResult>;
	readonly write?: (message: string) => void;
}

export async function dispatchCliCommand(
	args: readonly string[],
	dependencies: CliCommandDependencies = {},
): Promise<boolean> {
	const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
	if (args[0] === "--version" || args[0] === "-v") {
		write(`${VSPI_VERSION}\n`);
		return true;
	}
	if (args[0] !== "update") return false;
	if (args.length > 1) throw new Error("Usage: vspi update");
	const result = await (dependencies.update ?? updateVspi)(VSPI_VERSION);
	write(
		result.status === "updated"
			? `VSPi 已更新到 ${result.latestVersion}。请重启 VSPi 以使用新版本。\n`
			: `VSPi 当前已是最新版本 ${result.currentVersion}。\n`,
	);
	return true;
}
