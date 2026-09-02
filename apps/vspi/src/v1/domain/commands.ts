export interface CommandDefinition {
	id: string;
	aliases: string[];
	label: string;
	description: string;
	group: "VSPi" | "扩展";
	source?: string;
}

export type ActionHandler =
	| "newSession"
	| "sessions"
	| "externalImport"
	| "skills"
	| "compact"
	| "update"
	| "reload"
	| "plan"
	| "goal"
	| "models"
	| "providers"
	| "login"
	| "logout"
	| "prompt"
	| "settings"
	| "thinkingSettings"
	| "effort"
	| "policy"
	| "tools"
	| "agents"
	| "tasks"
	| "cron"
	| "usage"
	| "theme"
	| "tui"
	| "quit";

export interface ActionDefinition extends CommandDefinition {
	handler?: ActionHandler;
	availability: "enabled" | "disabled";
	disabledReason?: string;
}

export interface CommandMatch {
	command: CommandDefinition;
	canonicalId: string;
	canonicalToken: string;
	matchedToken: string;
	matchKind: "canonical" | "alias";
	source: string;
}

export const BUILTIN_COMMAND_SOURCE = "builtin";

export const ACTION_REGISTRY: ActionDefinition[] = [
	{
		id: "new",
		aliases: ["clear"],
		label: "/new",
		description: "新建会话",
		group: "VSPi",
		handler: "newSession",
		availability: "enabled",
	},
	{
		id: "sessions",
		aliases: ["resume", "session"],
		label: "/sessions",
		description: "会话与分支",
		group: "VSPi",
		handler: "sessions",
		availability: "enabled",
	},
	{
		id: "import",
		aliases: [],
		label: "/import",
		description: "导入 Codex 或 Claude Code 历史会话",
		group: "VSPi",
		handler: "externalImport",
		availability: "enabled",
	},
	{
		id: "skills",
		aliases: ["skill"],
		label: "/skills",
		description: "管理、安装与导入 Skill",
		group: "VSPi",
		handler: "skills",
		availability: "enabled",
	},
	{
		id: "compact",
		aliases: [],
		label: "/compact",
		description: "压缩当前上下文",
		group: "VSPi",
		handler: "compact",
		availability: "enabled",
	},
	{
		id: "update",
		aliases: [],
		label: "/update",
		description: "检查并安装最新版本",
		group: "VSPi",
		handler: "update",
		availability: "enabled",
	},
	{
		id: "reload",
		aliases: [],
		label: "/reload",
		description: "平滑重启：续接当前会话并加载最新配置",
		group: "VSPi",
		handler: "reload",
		availability: "enabled",
	},
	{
		id: "model",
		aliases: [],
		label: "/model",
		description: "选择模型或模型组",
		group: "VSPi",
		handler: "models",
		availability: "enabled",
	},
	{
		id: "providers",
		aliases: ["provider"],
		label: "/providers",
		description: "管理 Provider",
		group: "VSPi",
		handler: "providers",
		availability: "enabled",
	},
	{
		id: "login",
		aliases: [],
		label: "/login",
		description: "登录 Provider 账号或配置 API Key",
		group: "VSPi",
		handler: "login",
		availability: "enabled",
	},
	{
		id: "logout",
		aliases: [],
		label: "/logout",
		description: "移除已保存的 Provider 凭据",
		group: "VSPi",
		handler: "logout",
		availability: "enabled",
	},
	{
		id: "plan",
		aliases: [],
		label: "/plan",
		description: "查看当前计划",
		group: "VSPi",
		handler: "plan",
		availability: "enabled",
	},
	{
		id: "goal",
		aliases: [],
		label: "/goal",
		description: "创建、续跑与查看持久 Goal",
		group: "VSPi",
		handler: "goal",
		availability: "enabled",
	},
	{
		id: "prompt",
		aliases: [],
		label: "/prompt",
		description: "管理 Prompt Profile",
		group: "VSPi",
		handler: "prompt",
		availability: "enabled",
	},
	{
		id: "thinking",
		aliases: [],
		label: "/thinking",
		description: "打开 thinking 设置",
		group: "VSPi",
		handler: "thinkingSettings",
		availability: "enabled",
	},
	{
		id: "effort",
		aliases: [],
		label: "/effort",
		description: "设置思考强度",
		group: "VSPi",
		handler: "effort",
		availability: "enabled",
	},
	{
		id: "agents",
		aliases: ["subagents", "teammates"],
		label: "/agents",
		description: "浏览 Subagent 对话与活动",
		group: "VSPi",
		handler: "agents",
		availability: "enabled",
	},
	{
		id: "tasks",
		aliases: ["jobs", "background"],
		label: "/tasks",
		description: "浏览 Agent jobs、进程与问题",
		group: "VSPi",
		handler: "tasks",
		availability: "enabled",
	},
	{
		id: "cron",
		aliases: ["schedule"],
		label: "/cron",
		description: "查看、创建或取消前台定时任务",
		group: "VSPi",
		handler: "cron",
		availability: "enabled",
	},
	{
		id: "tools",
		aliases: ["capabilities"],
		label: "/tools",
		description: "查看工具与集成边界",
		group: "VSPi",
		handler: "tools",
		availability: "enabled",
	},
	{
		id: "policy",
		aliases: ["permission"],
		label: "/policy",
		description: "查看执行 Policy",
		group: "VSPi",
		handler: "policy",
		availability: "enabled",
	},
	{
		id: "usage",
		aliases: [],
		label: "/usage",
		description: "查看上下文与费用",
		group: "VSPi",
		handler: "usage",
		availability: "enabled",
	},
	{
		id: "settings",
		aliases: [],
		label: "/settings",
		description: "全局与项目设置",
		group: "VSPi",
		handler: "settings",
		availability: "enabled",
	},
	{
		id: "theme",
		aliases: [],
		label: "/theme",
		description: "选择界面主题",
		group: "VSPi",
		handler: "theme",
		availability: "enabled",
	},
	{
		id: "tui",
		aliases: [],
		label: "/tui",
		description: "在全屏（应用内滚动）与常规（终端原生滚动）间切换",
		group: "VSPi",
		handler: "tui",
		availability: "enabled",
	},
	{
		id: "quit",
		aliases: ["exit", "q"],
		label: "/quit",
		description: "退出 VSPi",
		group: "VSPi",
		handler: "quit",
		availability: "enabled",
	},
];

export const COMMANDS: CommandDefinition[] = ACTION_REGISTRY;

const ACTIONS_BY_ID = new Map(
	ACTION_REGISTRY.map((action) => [action.id, action]),
);

export function getActionDefinition(
	command: CommandDefinition | string,
): ActionDefinition | undefined {
	return ACTIONS_BY_ID.get(typeof command === "string" ? command : command.id);
}

function score(value: string, query: string): number | null {
	let cursor = 0;
	let result = 0;
	const lower = value.toLowerCase();
	for (const character of query.toLowerCase()) {
		const found = lower.indexOf(character, cursor);
		if (found < 0) return null;
		result += found === cursor ? 0 : found - cursor + 1;
		cursor = found + 1;
	}
	return result;
}

function commandToken(value: string): string {
	return `/${value.replace(/^\//, "")}`;
}

export function matchCommands(
	query: string,
	commands = COMMANDS,
): CommandMatch[] {
	const normalized = commandToken(query.trim()).toLowerCase();
	const matches: CommandMatch[] = [];
	for (const command of commands) {
		const canonicalToken = commandToken(command.id);
		const source = command.source ?? BUILTIN_COMMAND_SOURCE;
		if (canonicalToken.toLowerCase().startsWith(normalized)) {
			matches.push({
				command,
				canonicalId: command.id,
				canonicalToken,
				matchedToken: canonicalToken,
				matchKind: "canonical",
				source,
			});
		}
		for (const alias of command.aliases) {
			const matchedToken = commandToken(alias);
			if (!matchedToken.toLowerCase().startsWith(normalized)) continue;
			matches.push({
				command,
				canonicalId: command.id,
				canonicalToken,
				matchedToken,
				matchKind: "alias",
				source,
			});
		}
	}
	return matches;
}

export function filterCommands(
	query: string,
	commands = COMMANDS,
): CommandDefinition[] {
	const normalized = query.trim().replace(/^\//, "");
	if (!normalized) return commands;
	const seen = new Set<string>();
	const prefixMatches = matchCommands(query, commands)
		.map((match) => match.command)
		.filter((command) => {
			if (seen.has(command.id)) return false;
			seen.add(command.id);
			return true;
		});
	if (prefixMatches.length > 0) return prefixMatches;
	return commands
		.map((command) => {
			const candidates = [command.id, ...command.aliases, command.description];
			const scores = candidates
				.map((value) => score(value, normalized))
				.filter((value): value is number => value !== null);
			return { command, score: scores.length > 0 ? Math.min(...scores) : null };
		})
		.filter(
			(entry): entry is { command: CommandDefinition; score: number } =>
				entry.score !== null,
		)
		.sort(
			(left, right) =>
				left.score - right.score ||
				left.command.label.localeCompare(right.command.label, "zh-CN"),
		)
		.map((entry) => entry.command);
}

export function exactCommandCandidates(
	input: string,
	commands = COMMANDS,
): CommandDefinition[] {
	const token = commandToken(
		input.trim().split(/\s+/, 1)[0] ?? "",
	).toLowerCase();
	const exact = matchCommands(token, commands).filter(
		(match) => match.matchedToken.toLowerCase() === token,
	);
	return [
		...new Map(
			exact.map((match) => [match.canonicalId, match.command]),
		).values(),
	];
}

export function commandCompletion(
	input: string,
	commands = COMMANDS,
): CommandMatch | undefined {
	const matches = matchCommands(input, commands);
	const canonicalIds = new Set(matches.map((match) => match.canonicalId));
	if (canonicalIds.size !== 1) return undefined;
	return matches.find((match) => match.matchKind === "canonical") ?? matches[0];
}

export function resolveCommand(
	input: string,
	commands = COMMANDS,
): CommandDefinition | undefined {
	const candidates = exactCommandCandidates(input, commands);
	return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * C19 快速修复：面向模型的命令契约。VSPi 与上游 pi CLI 是不同产品，
 * 模型此前依据捆绑的 pi 文档推荐了不存在的命令；由注册表动态生成清单，
 * 命令增删时提示词自动跟随，不维护第二份手写列表。
 */
export function describeCommandsForPrompt(): string {
	const lines = ACTION_REGISTRY.map(
		(action) => `- ${action.label}：${action.description}`,
	);
	return `# VSPi 命令契约
VSPi 与上游 pi coding agent CLI 是不同产品：上游文档（包括 node_modules 内捆绑的 pi docs）描述的 CLI 参数、命令与扩展热加载行为均不适用于 VSPi，不得据此向用户推荐。VSPi 实际支持的全部 TUI 命令如下；除此之外的 / 命令一律不存在，不要建议用户输入清单外的命令，需要时让用户在命令面板（输入 / 后浏览）自行查看。
${lines.join("\n")}
修改 VSPi 本体或其配置文件后，配置不会在当前进程内自动生效；此时建议用户输入 /reload 平滑重启并自动续接当前会话，而不是让用户退出重开或手动拼接启动参数。`;
}
