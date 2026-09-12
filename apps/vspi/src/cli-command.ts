import { join } from "node:path";
import { connectRuntime, resolveRuntimePaths, type RuntimeConnection } from "@vsp/vsp-runtime";
import type { AppSettings } from "./v1/domain/types.js";
import { loadSettings } from "./v1/config/settings.js";
import { runAuthSetup, type AuthSetupOptions } from "./v1/app/auth-setup.js";
import { updateVspi, type SelfUpdateResult } from "./v1/update/self-update.js";
import { VSPI_VERSION } from "./v1/version.js";

export interface CliCommandDependencies {
	readonly update?: (currentVersion: string) => Promise<SelfUpdateResult>;
	readonly write?: (message: string) => void;
	readonly connect?: () => Promise<RuntimeConnection>;
	readonly connectReadOnly?: () => Promise<RuntimeConnection>;
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
  vspi init [provider]    初始化 Provider 和默认模型
  vspi config [provider]  配置 Provider 或读写 Core 配置（--help 查看用法）
  vspi inspect [paths|models|session <id>]  只读检查运行中的 daemon
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
       vspi config inspect <section>
       vspi config patch <section> <json>
       vspi config set <section> <json>
       vspi config diagnostics
       vspi config reload

不带参数时打开交互式 Provider 配置。
path 输出实际 config.toml 路径，不启动 runtime。
get/inspect/patch/set 使用 Core 配置 section 名（例如 defaultModel、secondaryModel）。
get/inspect 输出会隐藏凭据；不要把隐藏后的值交给 set。
inspect 显示各配置层；diagnostics 只读检查，不重载配置。
patch 通过 Core schema 校验并合并给定字段，保留其它字段。
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
				? `VSPi 已安装 ${result.latestVersion}。${result.runtimeRestarted ? 'Daemon 已完成安全切换。' : '没有启动或替换运行中的 Daemon。'}请重启客户端。\n`
				: `VSPi 当前已是最新版本 ${result.currentVersion}。\n`,
		);
		return true;
	}
	const command = args[0];
	if (command === "inspect") {
		await dispatchInspect(args.slice(1), dependencies, write);
		return true;
	}
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
		await setup({
			mode: command === "logout" ? "logout" : command === "login" ? "login" : "config",
			settings,
			connection,
			stdinIsTTY: dependencies.stdinIsTTY,
			stdoutIsTTY: dependencies.stdoutIsTTY,
			providerRef: args[1],
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
	if (!["get", "inspect", "patch", "set", "diagnostics", "reload"].includes(subcommand ?? ""))
		return false;
	if ((subcommand === "get" || subcommand === "inspect") && args.length !== 2)
		throw new Error(`Usage: vspi config ${subcommand} <section>`);
	if ((subcommand === "patch" || subcommand === "set") && args.length !== 3)
		throw new Error(`Usage: vspi config ${subcommand} <section> <json>`);
	if (subcommand === "diagnostics" && args.length !== 1)
		throw new Error("Usage: vspi config diagnostics");
	if (subcommand === "reload" && args.length !== 1)
		throw new Error("Usage: vspi config reload");
	let section = "";
	let setValue: unknown;
	if (subcommand === "get" || subcommand === "inspect" || subcommand === "patch" || subcommand === "set")
		section = args[1] ?? "";
	if (subcommand === "patch" || subcommand === "set") {
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
		if (JSON.stringify(setValue).includes(REDACTED))
			throw new Error("Redacted config cannot be written back; patch only the fields you intend to change.");
	}
	const readOnly = subcommand === "get" || subcommand === "inspect" || subcommand === "diagnostics";
	const connect = readOnly
		? readOnlyConnector(dependencies)
		: dependencies.connect ?? (() => Promise.reject(new Error("Runtime connection is not configured")));
	const connection = await connect();
	try {
		if (subcommand === "get") {
			const value = await connection.klient.global.config.get(section);
			writeJson(write, value);
			return true;
		}
		if (subcommand === "inspect") {
			writeJson(write, await connection.klient.global.config.inspect(section));
			return true;
		}
		if (subcommand === "diagnostics") {
			writeJson(write, await connection.klient.global.config.diagnostics());
			return true;
		}
		if (subcommand === "patch") {
			await connection.klient.global.config.set({ domain: section, patch: setValue });
			write(`配置 section ${section} 已更新\n`);
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
		writeJson(write, diagnostics);
		return true;
	} finally {
		await connection.close();
	}
}

const INSPECT_USAGE = "Usage: vspi inspect [paths|models|session <id>]\n只读取运行中的 daemon；不启动、重启或恢复会话。\n";
const REDACTED = "[REDACTED]";

function readOnlyConnector(dependencies: CliCommandDependencies): () => Promise<RuntimeConnection> {
	return dependencies.connectReadOnly ?? dependencies.connect ?? (() => connectRuntime());
}

async function dispatchInspect(
	args: readonly string[],
	dependencies: CliCommandDependencies,
	write: (message: string) => void,
): Promise<void> {
	const command = args[0] ?? "paths";
	if (["--help", "-h", "help"].includes(command) && args.length === 1) {
		write(INSPECT_USAGE);
		return;
	}
	if (!((command === "paths" || command === "models") && args.length <= 1) &&
		!(command === "session" && args.length === 2 && /^[\w-]+$/u.test(args[1] ?? "")))
		throw new Error(INSPECT_USAGE);
	const connection = await readOnlyConnector(dependencies)();
	try {
		const { env, klient } = connection;
		if (command === "models") {
			writeJson(write, await klient.global.kosong.listModels());
			return;
		}
		const paths = resolveRuntimePaths(env.homeDir);
		if (command === "session") {
			const session = await klient.global.sessions.get(args[1]!);
			if (session === undefined) throw new Error(`Session not found: ${args[1]}`);
			if (!/^[\w-]+$/u.test(session.workspaceId) || !/^[\w-]+$/u.test(session.id))
				throw new Error("Invalid session storage identity");
			const sessionDir = join(env.sessionsDir, session.workspaceId, session.id);
			writeJson(write, {
				id: session.id,
				workspaceId: session.workspaceId,
				cwd: session.cwd,
				archived: session.archived,
				lastTurnReason: session.lastTurnReason,
				sessionDir,
				transcriptPath: join(sessionDir, "agents", "main", "wire.jsonl"),
			});
			return;
		}
		writeJson(write, {
			homeDir: env.homeDir,
			configPath: env.configPath,
			sessionsDir: env.sessionsDir,
			logsDir: env.logsDir,
			runtimeLogPath: paths.logPath,
			profilesDir: join(env.homeDir, "agents"),
			pid: connection.state.pid,
			version: connection.state.version,
		});
	} finally {
		await connection.close();
	}
}

function writeJson(write: (message: string) => void, value: unknown): void {
	write(`${JSON.stringify(redactConfig(value), null, 2)}\n`);
}

function redactConfig(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactConfig);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [
			key,
			/(?:api.?key|access.?token|refresh.?token|id.?token|^token$|secret|password|credential|authorization|cookie|headers|^env$)/iu.test(key)
				? REDACTED
				: redactConfig(item),
		]));
	}
	if (typeof value === "string") {
		return value
			.replaceAll(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, `$1${REDACTED}@`)
			.replaceAll(/([?&](?:api[_-]?key|token|key|secret|password|access_token)=)[^&\s]+/giu, `$1${REDACTED}`)
			.replaceAll(/\b(Bearer|Basic)\s+[^\s"']+/giu, `$1 ${REDACTED}`);
	}
	return value;
}
