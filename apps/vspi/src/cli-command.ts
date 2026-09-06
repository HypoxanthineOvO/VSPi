import { resolveRuntimePaths, type RuntimeConnection } from "@vsp/vsp-runtime";
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

export const VSPI_USAGE = `VSPi ${VSPI_VERSION}

Usage: vspi [command]

Commands:
  vspi                    启动交互式 TUI（需要终端）
  vspi continue           继续当前工作区最近会话
  vspi resume             恢复会话并打开会话面板
  vspi exec ...           非交互执行（vspi exec --help 查看用法）
  vspi update             更新到最新发布版本
  vspi config [provider]  配置 Provider 或读写 Core 配置（--help 查看用法）
  vspi login|logout [provider]  登录 / 移除 Provider 凭据
  vspi web                输出 Web runtime 地址
  vspi daemon <start|status|stop|logs>
  vspi --version|-v       输出版本号
  vspi --help|-h          显示本帮助

配置（TOML，修改后重启 VSPi 生效）:
  路径: ~/.vspi/config.toml（用 VSPI_HOME 环境变量可改根目录）
  默认模型: default_model = "vsplab/gpt-6-astra"
  Provider: [providers.<id>] 段声明 base_url 与 type
  模型: [models."provider/model"] 段，示例:
    [models."vsplab/gpt-6-astra"]
    protocol = "openai_responses"
    provider = "vsplab"
    model = "gpt-6-astra"
    max_context_size = 1050000
    capabilities = [ "image_in", "thinking" ]
    support_efforts = [ "low", "medium", "high", "xhigh", "max" ]
    default_effort = "high"
  凭据: vspi login <provider>
  日志: vspi daemon logs
`;

export const VSPI_CONFIG_USAGE = `Usage: vspi config [provider]
       vspi config path
       vspi config get <section>
       vspi config set <section> <json>
       vspi config reload

不带参数时打开交互式 Provider 配置。
path 输出实际 config.toml 路径，不启动 runtime。
get/set 使用 Core 配置 section 名（例如 defaultModel、secondaryModel）。
set 通过 Core schema 校验并原子写入配置；JSON 参数必须是完整 section 值。
reload 重新读取磁盘配置并输出 diagnostics。
`;

export async function dispatchCliCommand(
	args: readonly string[],
	dependencies: CliCommandDependencies = {},
): Promise<boolean> {
	const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
	if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
		write(VSPI_USAGE);
		return true;
	}
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
	if (command !== "config" && command !== "init" && command !== "login" && command !== "logout") {
		if (
			command === undefined ||
			command === "continue" ||
			command === "resume" ||
			command === "exec" ||
			command === "web" ||
			command === "daemon"
		)
			return false;
		throw new Error(
			`${command.startsWith("-") ? "Unknown option" : "Unknown command"}: ${command}\nRun vspi --help for usage.`,
		);
	}
	if (command === "config" && await dispatchNonInteractiveConfig(args.slice(1), dependencies, write))
		return true;
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

async function dispatchNonInteractiveConfig(
	args: readonly string[],
	dependencies: CliCommandDependencies,
	write: (message: string) => void,
): Promise<boolean> {
	const subcommand = args[0];
	if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
		if (args.length > 1) throw new Error("Usage: vspi config --help");
		write(VSPI_CONFIG_USAGE);
		return true;
	}
	if (subcommand === "path") {
		if (args.length > 1) throw new Error("Usage: vspi config path");
		write(`${resolveRuntimePaths().configPath}\n`);
		return true;
	}
	if (subcommand?.startsWith("-"))
		throw new Error(`Unknown option for vspi config: ${subcommand}\nRun vspi config --help for usage.`);
	if (subcommand !== "get" && subcommand !== "set" && subcommand !== "reload")
		return false;
	if (subcommand === "get" && args.length !== 2)
		throw new Error("Usage: vspi config get <section>");
	if (subcommand === "set" && args.length !== 3)
		throw new Error("Usage: vspi config set <section> <json>");
	if (subcommand === "reload" && args.length !== 1)
		throw new Error("Usage: vspi config reload");
	let section = "";
	let setValue: unknown;
	if (subcommand === "get" || subcommand === "set")
		section = args[1] ?? "";
	if (subcommand === "set") {
		const json = args[2];
		if (json === undefined)
			throw new Error("Usage: vspi config set <section> <json>");
		try {
			setValue = JSON.parse(json);
		} catch (error) {
			throw new Error(
				`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
	const connect =
		dependencies.connect ??
		(() => Promise.reject(new Error("Runtime connection is not configured")));
	const connection = await connect();
	try {
		if (subcommand === "get") {
			const value = await connection.klient.global.config.get(section);
			write(`${JSON.stringify(value, null, 2)}\n`);
			return true;
		}
		if (subcommand === "set") {
			await connection.klient.global.config.replace({
				domain: section,
				value: setValue,
			});
			write(`配置 section ${section} 已更新\n`);
			return true;
		}
		await connection.klient.global.config.reload();
		const diagnostics = await connection.klient.global.config.diagnostics();
		write(`${JSON.stringify(diagnostics, null, 2)}\n`);
		return true;
	} finally {
		await connection.close();
	}
}
