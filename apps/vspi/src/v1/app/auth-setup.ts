import type { Klient, ProviderCatalogItem } from "@moonshot-ai/klient";
import type { RuntimeConnection } from "@vsp/vsp-runtime";
import {
	Input,
	Key,
	matchesKey,
	ProcessTerminal,
	TuiMainScreen,
	type Component,
	type Focusable,
	type TUI,
} from "@moonshot-ai/pi-tui";
import { formatProviderDisplayName } from "../backend/klient-backend.js";
import type { ProviderAuthInteraction } from "../backend/types.js";
import type { AppSettings } from "../domain/types.js";
import { loginWithOAuth } from "../providers/oauth-login.js";
import { configureProxy, ensureProviderProxy } from '../providers/proxy-setup.js';
import { catalogEffortCapability, effortLabel } from "../domain/effort.js";
import { frame, padLine, visibleWidth, wrapTextWithAnsi, alignRight } from "../ui/ansi.js";
import { AuthDialog } from "../ui/auth-dialog.js";
import {
	applySettingsToCapabilities,
	detectTerminalCapabilities,
} from "../ui/capabilities.js";
import { createTheme, type VspiTheme } from "../ui/theme.js";
import {
	customProviderId,
	discoverProviderModels,
	type CustomProviderProtocol,
} from "../providers/custom-provider.js";

export type AuthSetupMode = "config" | "login" | "logout" | "proxy";

type CredentialType = "api_key" | "oauth";

interface SetupEntry {
	providerId: string;
	providerName: string;
	type: CredentialType | "custom";
	label: string;
	configured: boolean;
}

export interface AuthSetupOptions {
	mode: AuthSetupMode;
	providerRef?: string;
	settings: AppSettings;
	connection: RuntimeConnection;
	stdinIsTTY?: () => boolean;
	stdoutIsTTY?: () => boolean;
}

export async function runAuthSetup(options: AuthSetupOptions): Promise<void> {
	if (!(options.stdinIsTTY?.() ?? process.stdin.isTTY) || !(options.stdoutIsTTY?.() ?? process.stdout.isTTY)) {
		throw new Error("vspi config/login/logout/proxy 需要交互式 TTY");
	}
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal, true);
	const capabilities = applySettingsToCapabilities(
		detectTerminalCapabilities(),
		options.settings,
	);
	const theme = createTheme(capabilities, options.settings.theme);
	let complete: (() => void) | undefined;
	let resultMessage = "";
	const finished = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const app = new AuthSetupApp(
		tui,
		theme,
		options.connection.klient,
		options.mode,
		(message) => {
			resultMessage = message ?? "";
			complete?.();
		},
		options.providerRef !== undefined,
	);
	await app.load();
	tui.addChild(app);
	tui.setFocus(app);
	terminal.setTitle("VSPi Setup");
	tui.start();
	try {
		await app.startInitial(options.providerRef);
		await finished;
	} finally {
		tui.stop();
		await terminal.drainInput();
	}
	if (resultMessage) process.stdout.write(`${resultMessage}\n`);
}

export class AuthSetupApp implements Component, Focusable {
	private entries: SetupEntry[] = [];
	private selected = 0;
	private dialog: AuthDialog | undefined;
	private notice = "";
	private focusedState = false;
	private running = false;
	private query = "";
	private readonly searchInput = new Input();

	constructor(
		private readonly tui: TUI,
		private readonly theme: VspiTheme,
		private readonly klient: Klient,
		private readonly mode: AuthSetupMode,
		private readonly finish: (message?: string) => void,
		private readonly exitAfterAction: boolean,
	) {
		this.searchInput.focused = true;
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
	}

	async load(): Promise<void> {
		if (this.mode === 'proxy') return;
		const [providers, inspection, builtinProviders, loginProviders] = await Promise.all([
			this.klient.global.kosong.listProviders(),
			this.klient.global.config.inspect<Record<string, Record<string, unknown>>>(
				"providers",
			),
			this.klient.global.kosong.listBuiltinProviders(),
			this.klient.global.auth.listLoginProviders(),
		]);
		const configured = inspection.userValue ?? {};
		const loginOnlyProviders: ProviderCatalogItem[] = loginProviders.map((provider) => ({
			id: provider.id, type: provider.id, has_api_key: false, status: "unconfigured", models: [],
		}));
		const allProviders = [...new Map([...loginOnlyProviders, ...builtinProviders, ...providers].map((provider) => [provider.id, provider])).values()];
		this.entries = allProviders
			// managed:* 是托管渠道的内部 id，没有已存凭据时不展示。
			.filter((provider) => !provider.id.startsWith("managed:") || hasStoredCredential(configured[provider.id]))
			.flatMap((provider) => entriesForProvider(provider, configured[provider.id], this.mode, loginProviders.some((login) => login.id === provider.type || login.id === provider.id)))
			.concat(this.mode === "logout" ? [] : [customEntry()])
			.toSorted(compareEntries);
		this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
		this.tui.requestRender();
	}

	async startInitial(providerRef?: string): Promise<void> {
		if (this.mode === 'proxy') {
			const dialog = new AuthDialog('代理', () => { this.tui.requestRender(); }, () => { this.finish(); }, '配置');
			this.dialog = dialog;
			try {
				await configureProxy(this.klient, dialog);
				if (!dialog.signal.aborted) this.finish('代理配置已保存。');
			} catch (error) { if (!dialog.signal.aborted) throw error; }
			finally { this.dialog = undefined; }
			return;
		}
		if (!providerRef) return;
		const normalized = providerRef.toLowerCase();
		const matches = this.entries.filter(
			(entry) =>
				entry.providerId.toLowerCase() === normalized ||
				entry.providerName.toLowerCase() === normalized,
		);
		const entry = matches.find((candidate) => candidate.type === "oauth") ?? matches[0];
		if (!entry) {
			throw new Error(`未找到可配置的 Provider：${providerRef}`);
		}
		this.selected = Math.max(0, this.visibleEntries().indexOf(entry));
		await this.activate(entry);
	}

	private visibleEntries(): SetupEntry[] {
		const query = this.query.trim().toLowerCase();
		const filtered = query
			? this.entries.filter((entry) =>
				`${entry.providerName} ${entry.providerId} ${entry.label}`
					.toLowerCase()
					.includes(query),
			)
			: this.entries;
		// 展示顺序即遍历顺序：已配置在前，其余在后。
		return filtered
			.filter((entry) => entry.configured)
			.concat(filtered.filter((entry) => !entry.configured));
	}

	private searchRow(): string {
		const value = this.query === "" ? this.theme.muted("输入名称筛选") : this.query;
		return `${this.theme.muted("搜索 ")}${value}${this.theme.inverse(" ")}`;
	}

	handleInput(data: string): void {
		if (this.dialog) {
			this.dialog.handleInput(data);
			return;
		}
		if (this.running) return;
		const entries = this.visibleEntries();
		if (matchesKey(data, Key.escape)) {
			if (this.query) {
				this.query = "";
				this.searchInput.setValue("");
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			this.finish();
			return;
		}
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.down))
			this.selected = Math.min(entries.length - 1, this.selected + 1);
		else if (matchesKey(data, Key.enter)) {
			const entry = entries[this.selected];
			if (entry) void this.activate(entry);
		} else {
			const before = this.searchInput.getValue();
			this.searchInput.handleInput(data);
			const next = this.searchInput.getValue();
			if (next !== before) {
				this.query = next;
				this.selected = 0;
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.dialog) return this.dialog.render(width, this.theme);
		const bodyWidth = Math.max(1, width - 4);
		const entries = this.visibleEntries();
		const title = this.mode === "logout" ? "移除凭据" : "VSPi Config · Provider 登录";
		if (entries.length === 0) {
			return frame(
				[
					this.searchRow(),
					this.theme.muted(
						this.query
							? "没有匹配的 Provider"
							: this.mode === "logout"
								? "没有已保存的凭据"
								: "没有可交互的认证方式",
					),
				],
				width,
				this.theme,
				{ title, focused: true, paddingX: 1 },
			);
		}
		const nameWidth = Math.min(
			30,
			Math.max(...entries.map((entry) => visibleWidth(entry.providerName))),
		);
		const entryRow = (index: number): string => {
			const entry = entries[index];
			if (!entry) return padLine("", bodyWidth);
			const active = index === this.selected;
			const status = entry.configured
				? this.theme.success("已配置")
				: this.theme.muted("未配置");
			const name = `${entry.providerName}${" ".repeat(
				Math.max(0, nameWidth - visibleWidth(entry.providerName)),
			)}`;
			const line = alignRight(
				`${active ? this.theme.focus("› ") : "  "}${name}  ${this.theme.muted(entry.label)}`,
				status,
				bodyWidth,
			);
			return active ? this.theme.selected(padLine(line, bodyWidth)) : line;
		};
		// 两个分区：已配置在前，其余（可添加 + 自定义）在后；搜索行固定在顶部。
		const displayRows: Array<string | number> = [];
		const pushSection = (label: string, indexes: number[]): void => {
			if (indexes.length === 0) return;
			displayRows.push(`${label} ${indexes.length}`);
			for (const index of indexes) displayRows.push(index);
		};
		const configuredIndexes = entries.flatMap((entry, index) => (entry.configured ? [index] : []));
		const otherIndexes = entries.flatMap((entry, index) => (entry.configured ? [] : [index]));
		pushSection("已配置", configuredIndexes);
		pushSection("可添加", otherIndexes);
		const selectedRow = Math.max(
			0,
			displayRows.findIndex((row) => row === this.selected),
		);
		const maxRows = Math.max(3, (this.tui.terminal.rows ?? 24) - 6);
		const start = Math.max(
			0,
			Math.min(
				selectedRow - Math.floor(maxRows / 2),
				displayRows.length - maxRows,
			),
		);
		const rows = [
			this.searchRow(),
			...displayRows
				.slice(start, start + maxRows)
				.map((row) =>
					typeof row === "number"
						? entryRow(row)
						: this.theme.bold(this.theme.muted(` ${row}`)),
				),
		];
		if (this.notice)
			rows.push("", ...wrapTextWithAnsi(this.theme.warning(this.notice), bodyWidth));
		rows.push("", this.theme.muted("↑↓ 选择 · 输入筛选 · Enter 确认 · Esc 退出"));
		return frame(rows, width, this.theme, {
			title,
			focused: true,
			paddingX: 1,
			footer: `${this.selected + 1} / ${entries.length}`,
		});
	}

	invalidate(): void {}

	private async activate(entry: SetupEntry): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.notice = "";
		try {
			if (entry.type === "custom") {
				const result = await this.configureCustomProvider();
				const message = `${result.name} 已添加，发现 ${result.modelCount} 个模型，API Key 已保存`;
				if (this.exitAfterAction) this.finish(message);
				else {
					this.notice = message;
					await this.load();
				}
				return;
			}
			if (this.mode === "logout") {
				await logoutProvider(this.klient, entry.providerId, entry.type);
				const message = `${entry.providerName} 的已保存凭据已移除`;
				if (this.exitAfterAction) this.finish(message);
				else {
					this.notice = message;
					await this.load();
				}
				return;
			}
			const dialog = new AuthDialog(
				entry.providerName,
				() => {
					this.tui.requestRender();
				},
				() => {
					this.running = false;
					if (this.exitAfterAction) this.finish();
				},
				entry.type === "oauth" ? "登录" : "配置",
			);
			this.dialog = dialog;
			await loginProvider(this.klient, entry.providerId, entry.type, dialog);
			if (dialog.signal.aborted) return;
			if (this.mode === "config") await configureDefaultModel(this.klient, entry.providerId, dialog);
			this.dialog = undefined;
			this.finish(
				entry.type === "oauth"
					? `${entry.providerName} 账号已连接`
					: `${entry.providerName} API Key 已保存`,
			);
		} catch (error) {
			this.dialog = undefined;
			if (this.running) {
				this.notice = `${this.mode === "logout" ? "移除失败" : "登录失败"}：${
					error instanceof Error ? error.message : "未知错误"
				}`;
			}
		} finally {
			this.running = false;
			if (this.dialog?.signal.aborted) this.dialog = undefined;
			this.tui.requestRender();
		}
	}

	private async configureCustomProvider(): Promise<{
		name: string;
		modelCount: number;
	}> {
		const dialog = new AuthDialog(
			"自定义中转站",
			() => {
				this.tui.requestRender();
			},
			() => {
				this.running = false;
				if (this.exitAfterAction) this.finish();
			},
			"配置",
		);
		this.dialog = dialog;
		try {
			const name = (
				await dialog.prompt({
					type: "text",
					message: "中转站名称",
					placeholder: "例如 My Gateway",
					signal: dialog.signal,
				})
			).trim();
			const baseUrl = (
				await dialog.prompt({
					type: "text",
					message: "Base URL",
					placeholder: "https://gateway.example.com/v1",
					signal: dialog.signal,
				})
			).trim();
			const protocol = (await dialog.prompt({
				type: "select",
				message: "接口类型",
				options: [
					{ id: "openai", label: "OpenAI Compatible" },
					{ id: "openai_responses", label: "OpenAI Responses" },
					{ id: "anthropic", label: "Anthropic Messages" },
					{ id: "google-genai", label: "Google Generative AI" },
				],
				signal: dialog.signal,
			})) as CustomProviderProtocol;
			const apiKey = await dialog.prompt({
				type: "secret",
				message: "API Key",
				placeholder: "保存到 VSPi Core 配置",
				signal: dialog.signal,
			});
			if (!name || !baseUrl || !apiKey)
				throw new Error("名称、Base URL 和 API Key 都不能为空");
			dialog.notify({ type: "progress", message: "正在读取模型列表（最多 5 秒）..." });
			const models = await discoverProviderModels(
				baseUrl,
				protocol,
				apiKey,
				dialog,
			);
			const id = customProviderId(name, baseUrl);
			const [providers, modelInspection] = await Promise.all([
				this.klient.global.config.inspect<Record<string, unknown>>("providers"),
				this.klient.global.config.inspect<Record<string, unknown>>("models"),
			]);
			const providerValue = {
				...providers.userValue,
				[id]: { name, type: protocol, baseUrl, apiKey },
			};
			const modelValue = { ...modelInspection.userValue };
			for (const model of models) {
				modelValue[`${id}/${model.id}`] = {
					provider: id,
					model: model.id,
					maxContextSize: 128_000,
					displayName: model.name,
				};
			}
			await this.klient.global.config.replaceSections({
				sections: { providers: providerValue, models: modelValue },
			});
			if (this.mode === "config") await configureDefaultModel(this.klient, id, dialog);
			return { name, modelCount: models.length };
		} finally {
			this.dialog = undefined;
		}
	}
}

export async function configureDefaultModel(
	klient: Klient,
	providerId: string,
	interaction: ProviderAuthInteraction,
): Promise<void> {
	const [catalog, providers] = await Promise.all([
		klient.global.kosong.listModels(),
		klient.global.kosong.listProviders(),
	]);
	const models = catalog.filter((model) => model.provider === providerId);
	const provider = providers.find((candidate) => candidate.id === providerId);
	if (models.length === 0) throw new Error("Provider 已登录，但没有可选择的模型，请检查配置");
	const modelId = await interaction.prompt({
		type: "select", message: "默认模型",
		options: models.map((model) => ({ id: model.model, label: model.display_name ?? model.model })),
		signal: interaction.signal,
	});
	const model = models.find((candidate) => candidate.model === modelId);
	if (!model) throw new Error("模型选择无效");
	const capability = catalogEffortCapability({
		...model.thinking,
		efforts: model.support_efforts ?? model.thinking.efforts,
		default_effort: model.default_effort ?? model.thinking.default_effort,
	}, { type: provider?.type, identity: providerId });
	const efforts = capability.options;
	const defaultEffort = capability.defaultEffort;
	const effort = efforts.length > 1
		? await interaction.prompt({
			type: "select", message: "默认 Effort",
			options: efforts.toSorted((left, right) => Number(right === defaultEffort) - Number(left === defaultEffort))
				.map((id) => ({ id, label: effortLabel(id) })),
			signal: interaction.signal,
		}) : efforts[0];
	if (effort !== undefined && !efforts.includes(effort)) throw new Error("Effort 选择无效");
	interaction.signal?.throwIfAborted();
	await klient.global.kosong.setDefaultModel(modelId);
	await klient.global.config.set({
		domain: "thinking",
		patch: { enabled: effort !== "off", effort: effort === "off" || effort === "on" ? undefined : effort },
	});
}

export async function loginProvider(
	klient: Klient,
	providerId: string,
	type: CredentialType,
	interaction: ProviderAuthInteraction,
): Promise<void> {
	await ensureProviderProxy(klient, providerId, interaction);
	if (type === "api_key") {
		const apiKey = await interaction.prompt({
			type: "secret",
			message: `${providerId} API Key`,
			placeholder: "API Key",
			signal: interaction.signal,
		});
		const inspection = await klient.global.config.inspect<
			Record<string, Record<string, unknown>>
		>("providers");
		const providers = { ...inspection.userValue };
		const provider = providers[providerId];
		if (provider === undefined) {
			await klient.global.kosong.configureBuiltinProvider(providerId, apiKey);
			return;
		}
		providers[providerId] = { ...provider, apiKey, apiKeyEnv: undefined, oauth: undefined };
		await klient.global.config.replace({ domain: "providers", value: providers });
		interaction.notify({
			type: "info",
			message: "API Key 已保存到 VSPi Core 配置",
		});
		return;
	}
	await loginWithOAuth(klient.global.auth, providerId, interaction);
}

async function logoutProvider(
	klient: Klient,
	providerId: string,
	type: CredentialType,
): Promise<void> {
	if (type === "oauth") {
		await klient.global.auth.logout(providerId);
		return;
	}
	const inspection = await klient.global.config.inspect<
		Record<string, Record<string, unknown>>
	>("providers");
	const providers = { ...inspection.userValue };
	const provider = providers[providerId];
	if (provider === undefined) throw new Error(`Provider ${providerId} 不存在`);
	const { apiKey: _apiKey, apiKeyEnv: _apiKeyEnv, ...withoutKey } = provider;
	providers[providerId] = withoutKey;
	await klient.global.config.replace({ domain: "providers", value: providers });
}

function hasStoredCredential(
	config: Record<string, unknown> | undefined,
): boolean {
	return (
		config?.apiKey !== undefined ||
		config?.apiKeyEnv !== undefined ||
		config?.oauth !== undefined
	);
}

function entriesForProvider(
	provider: ProviderCatalogItem,
	config: Record<string, unknown> | undefined,
	mode: AuthSetupMode,
	canLogin = false,
): SetupEntry[] {
	const configuredType = config?.oauth !== undefined ? "oauth" : "api_key";
	const stored = hasStoredCredential(config);
	if (mode === "logout" && !stored) return [];
	const customName =
		typeof config?.name === "string" && config.name.trim().length > 0
			? config.name
			: undefined;
	const displayName = customName ?? formatProviderDisplayName(provider.id);
	const entries: SetupEntry[] = [];
	if ((mode !== "logout" && (canLogin || provider.id === "kimi")) || config?.oauth !== undefined) {
		entries.push({
			providerId: provider.id,
			providerName: provider.id === 'openai-codex' ? 'OpenAI OAuth (ChatGPT / Codex)' : displayName,
			type: "oauth",
			label: "订阅账号",
			configured: configuredType === "oauth" && provider.status === "connected",
		});
	}
	if ((provider.type !== 'devin' && provider.id !== 'devin') && (mode !== "logout" || config?.apiKey !== undefined || config?.apiKeyEnv !== undefined)) {
		entries.push({
			providerId: provider.id,
			providerName: displayName,
			type: "api_key",
			label: "API Key",
			configured: configuredType === "api_key" && provider.has_api_key,
		});
	}
	return entries;
}

function customEntry(): SetupEntry {
	return {
		providerId: "custom",
		providerName: "添加自定义中转站",
		type: "custom",
		label: "自定义",
		configured: false,
	};
}

function compareEntries(left: SetupEntry, right: SetupEntry): number {
	const priority = [
		"vsplab",
		"kimi",
		"deepseek",
		"xiaomi",
		"zai",
		"minimax",
		"openai",
		"anthropic",
	];
	const leftIndex = priority.indexOf(left.providerId);
	const rightIndex = priority.indexOf(right.providerId);
	return (
		(leftIndex < 0 ? priority.length : leftIndex) -
			(rightIndex < 0 ? priority.length : rightIndex) ||
		left.providerName.localeCompare(right.providerName) ||
		(left.type === "oauth" ? -1 : 1)
	);
}
