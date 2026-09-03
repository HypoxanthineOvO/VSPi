import type { RuntimeConnection } from "@vsp/vsp-runtime";
import type { AppSettings } from "./v1/domain/types.js";
import { loadSettings } from "./v1/config/settings.js";
import { runAuthSetup, type AuthSetupOptions } from "./v1/app/auth-setup.js";
import { updateVspi, type SelfUpdateResult } from "./v1/update/self-update.js";
import { VSPI_VERSION } from "./v1/version.js";

export interface CliCommandDependencies {
	readonly update?: (currentVersion: string) => Promise<SelfUpdateResult>;
	readonly write?: (message: string) => void;
	readonly connect?: () => Promise<RuntimeConnection>;
	readonly authSetup?: (options: AuthSetupOptions) => Promise<void>;
	readonly loadSettings?: () => Promise<AppSettings>;
	readonly stdinIsTTY?: () => boolean;
	readonly stdoutIsTTY?: () => boolean;
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
	if (args[0] === "update") {
		if (args.length > 1) throw new Error("Usage: vspi update");
		const result = await (dependencies.update ?? updateVspi)(VSPI_VERSION);
		write(
			result.status === "updated"
				? `VSPi 已更新到 ${result.latestVersion}。请重启 VSPi 以使用新版本。\n`
				: `VSPi 当前已是最新版本 ${result.currentVersion}。\n`,
		);
		return true;
	}
	const command = args[0];
	if (command !== "config" && command !== "init" && command !== "login" && command !== "logout")
		return false;
	if (args.length > 2) throw new Error(`Usage: vspi ${command}${command === "config" || command === "init" ? " [custom]" : " [provider]"}`);
	if (!(dependencies.stdinIsTTY?.() ?? process.stdin.isTTY) || !(dependencies.stdoutIsTTY?.() ?? process.stdout.isTTY))
		throw new Error("vspi config/login/logout 需要交互式 TTY");
	const connection = await (dependencies.connect ?? (() => Promise.reject(new Error("Runtime connection is not configured"))))();
	try {
		const setup = dependencies.authSetup ?? runAuthSetup;
		const settings = await (dependencies.loadSettings ?? (() => loadSettings(process.cwd())))();
		if (command === "init") write("vspi init 已更名为 vspi config；本次继续执行配置。\n");
		await setup({
			mode: command === "logout" ? "logout" : command === "login" ? "login" : "config",
			settings,
			connection,
			stdinIsTTY: dependencies.stdinIsTTY,
			stdoutIsTTY: dependencies.stdoutIsTTY,
			...(args[1] !== undefined ? { providerRef: args[1] } : {}),
		});
	} finally {
		await connection.close();
	}
	return true;
}
