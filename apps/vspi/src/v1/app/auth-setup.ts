import type { Klient, ProviderCatalogItem } from "@moonshot-ai/klient";
import type { RuntimeConnection } from "@vsp/vsp-runtime";
import {
	Key,
	matchesKey,
	ProcessTerminal,
	TuiMainScreen,
	type Component,
	type Focusable,
	type TUI,
} from "@moonshot-ai/pi-tui";
import type { ProviderAuthInteraction } from "../backend/types.js";
import type { AppSettings } from "../domain/types.js";
import { frame, padLine, wrapTextWithAnsi, alignRight } from "../ui/ansi.js";
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

export type AuthSetupMode = "config" | "login" | "logout";

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
		throw new Error("vspi config/login/logout 需要交互式 TTY");
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

class AuthSetupApp implements Component, Focusable {
	private entries: SetupEntry[] = [];
	private selected = 0;
	private dialog: AuthDialog | undefined;
	private notice = "";
	private focusedState = false;
	private running = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: VspiTheme,
		private readonly klient: Klient,
		private readonly mode: AuthSetupMode,
		private readonly finish: (message?: string) => void,
		private readonly exitAfterAction: boolean,
	) {}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
	}

	async load(): Promise<void> {
		const [providers, inspection] = await Promise.all([
			this.klient.global.kosong.listProviders(),
			this.klient.global.config.inspect<Record<string, Record<string, unknown>>>(
				"providers",
			),
		]);
		const configured = inspection.userValue ?? {};
		this.entries = providers
			.flatMap((provider) => entriesForProvider(provider, configured[provider.id], this.mode))
			.concat(this.mode === "logout" ? [] : [customEntry()])
			.toSorted(compareEntries);
		this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
		this.tui.requestRender();
	}

	async startInitial(providerRef?: string): Promise<void> {
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
		this.selected = this.entries.indexOf(entry);
		await this.activate(entry);
	}

	handleInput(data: string): void {
		if (this.dialog) {
			this.dialog.handleInput(data);
			return;
		}
		if (this.running) return;
		if (matchesKey(data, Key.escape)) {
			this.finish();
			return;
		}
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.down))
			this.selected = Math.min(this.entries.length - 1, this.selected + 1);
		else if (matchesKey(data, Key.enter)) {
			const entry = this.entries[this.selected];
			if (entry) void this.activate(entry);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.dialog) return this.dialog.render(width, this.theme);
		const bodyWidth = Math.max(1, width - 4);
		if (this.entries.length === 0) {
			return frame(
				[
					this.theme.muted(
						this.mode === "logout"
							? "没有已保存的凭据"
							: "没有可交互的认证方式",
					),
				],
				width,
				this.theme,
				{
					title: this.mode === "logout" ? "移除凭据" : "VSPi Config",
					focused: true,
				},
			);
		}
		const maxRows = Math.max(3, (this.tui.terminal.rows ?? 24) - 5);
		const start = Math.max(
			0,
			Math.min(
				this.selected - Math.floor(maxRows / 2),
				this.entries.length - maxRows,
			),
		);
		const rows = this.entries.slice(start, start + maxRows).map((entry, offset) => {
			const active = start + offset === this.selected;
			const status = entry.configured
				? this.theme.success("已配置")
				: this.theme.muted("未配置");
			const line = alignRight(
				`${active ? this.theme.focus("› ") : "  "}${entry.providerName} · ${entry.label}`,
				status,
				bodyWidth,
			);
			return active ? this.theme.selected(padLine(line, bodyWidth)) : line;
		});
		if (this.notice)
			rows.push("", ...wrapTextWithAnsi(this.theme.warning(this.notice), bodyWidth));
		rows.push("", this.theme.muted("↑↓ 选择 · Enter 确认 · Esc 退出"));
		return frame(rows, width, this.theme, {
			title: this.mode === "logout" ? "移除凭据" : "VSPi Config · Provider 登录",
			focused: true,
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
			return { name, modelCount: models.length };
		} finally {
			this.dialog = undefined;
		}
	}
}

async function loginProvider(
	klient: Klient,
	providerId: string,
	type: CredentialType,
	interaction: ProviderAuthInteraction,
): Promise<void> {
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
		if (provider === undefined) throw new Error(`Provider ${providerId} 不存在`);
		providers[providerId] = { ...provider, apiKey };
		await klient.global.config.replace({ domain: "providers", value: providers });
		interaction.notify({
			type: "info",
			message: "API Key 已保存到 VSPi Core 配置",
		});
		return;
	}
	const started = await klient.global.auth.startLogin(providerId);
	if (started.status === "authenticated") return;
	interaction.notify({
		type: "device_code",
		verificationUri: started.verification_uri_complete,
		userCode: started.user_code,
	});
	while (!interaction.signal?.aborted) {
		await delay(Math.max(500, started.interval * 1_000));
		const flow = await klient.global.auth.flow(providerId);
		if (flow?.status === "authenticated") return;
		if (flow !== undefined && flow.status !== "pending") {
			throw new Error(flow.error_message ?? `OAuth ${flow.status}`);
		}
	}
	await klient.global.auth.cancelLogin(providerId);
	throw new Error("Login cancelled");
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
	const { apiKey: _apiKey, ...withoutKey } = provider;
	providers[providerId] = withoutKey;
	await klient.global.config.replace({ domain: "providers", value: providers });
}

function entriesForProvider(
	provider: ProviderCatalogItem,
	config: Record<string, unknown> | undefined,
	mode: AuthSetupMode,
): SetupEntry[] {
	const configuredType = config?.oauth !== undefined ? "oauth" : "api_key";
	const hasStoredCredential =
		config?.apiKey !== undefined || config?.oauth !== undefined;
	if (mode === "logout" && !hasStoredCredential) return [];
	const entries: SetupEntry[] = [];
	if (provider.id === "kimi" || config?.oauth !== undefined) {
		entries.push({
			providerId: provider.id,
			providerName: provider.id,
			type: "oauth",
			label: "订阅账号",
			configured: configuredType === "oauth" && provider.status === "connected",
		});
	}
	if (mode !== "logout" || config?.apiKey !== undefined) {
		entries.push({
			providerId: provider.id,
			providerName: provider.id,
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
		providerName: "自定义中转站",
		type: "custom",
		label: "名称 · Base URL · API Key · 类型",
		configured: false,
	};
}

function compareEntries(left: SetupEntry, right: SetupEntry): number {
	const priority = [
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
