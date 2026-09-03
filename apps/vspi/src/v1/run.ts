import { randomUUID } from "node:crypto";
import type { RuntimeConnection } from "@vsp/vsp-runtime";

import { VspiApp } from "./app/vspi-app.js";
import {
  shutdownInteractiveSession,
  startUiAfterSplash,
} from "./app/startup.js";
import { AttachmentService } from "./attachments/service.js";
import {
	KlientChatBackend,
	type SessionStartupMode,
} from "./backend/klient-backend.js";
import { loadSettings } from "./config/settings.js";
import {
	catalogEffortCapability,
	resolveCatalogEffort,
} from "./domain/effort.js";
import {
	applySettingsToCapabilities,
	detectTerminalCapabilities,
} from "./ui/capabilities.js";
import {
	ScrollbackProcessTerminal,
	ScrollbackTUI,
} from "./ui/scrollback-terminal.js";
import { openTerminalUrl } from "./ui/terminal-link.js";
import { createTheme } from "./ui/theme.js";
import { VspiTuiAltScreen } from "./ui/tui-frame-pacer.js";

export async function runVspiTui(
	connection: RuntimeConnection,
	options: { readonly startupMode?: SessionStartupMode } = {},
): Promise<void> {
	const settings = await loadSettings(process.cwd(), undefined, {
		trustedProject: true,
	});
	const terminal = new ScrollbackProcessTerminal();
	const tui =
		settings.tuiMode === "fullscreen"
			? new VspiTuiAltScreen(terminal, true, undefined, {
					openUrl: openTerminalUrl,
				})
			: new ScrollbackTUI(terminal, true);
	const capabilities = applySettingsToCapabilities(
		detectTerminalCapabilities(),
		settings,
	);
	const theme = createTheme(capabilities, settings.theme);
	const startupMode = options.startupMode ?? "new";
	const backend = new KlientChatBackend(connection, process.cwd(), startupMode);
	const attachments = new AttachmentService(randomUUID(), theme);
	let closing = false;
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	const app = new VspiApp(tui, theme, backend, {
		cwd: process.cwd(),
		settings,
		attachments,
		openOnStart: startupMode === "resume" ? "sessions" : undefined,
		startupRuntimeDiagnostic: connection.migrationWarning
			? formatRuntimeMigrationWarning(connection.migrationWarning.reason)
			: undefined,
		runtimeDefaultsFactory: () => ({
			load: async () => {
				const [defaultModel, thinking, models, providers] = await Promise.all([
					connection.klient.global.config.get<string | undefined>(
						"defaultModel",
					),
					connection.klient.global.config.get<{ effort?: string } | undefined>(
						"thinking",
					),
					connection.klient.global.kosong.listModels(),
					connection.klient.global.kosong.listProviders(),
				]);
				const selected =
					defaultModel === undefined
						? undefined
						: models.find(
								(model) =>
									`${model.provider}/${displayModelId(model.provider, model.model)}` ===
									defaultModel,
							);
				const provider = providers.find(
					(candidate) => candidate.id === selected?.provider,
				);
				const effort = catalogEffortCapability(selected?.thinking, {
					identity: selected?.provider,
					type: provider?.type,
				});
				const efforts =
					selected === undefined
						? (["off"] as const)
						: effort.options;
				return {
					value: {
						model:
							selected === undefined
								? undefined
								: {
										provider: selected.provider,
										id: displayModelId(selected.provider, selected.model),
									},
						effort: resolveCatalogEffort(thinking?.effort, {
							options: [...efforts],
							defaultEffort: effort.defaultEffort,
						}),
					},
					diagnostics: [],
				};
			},
			save: async (_scope, value) => {
				await connection.klient.global.config.replace({
					domain: "thinking",
					value: { effort: value.effort },
				});
				return connection.env.configPath;
			},
		}),
		onExit: () => {
			void shutdown();
		},
	});
	const shutdown = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		try {
			await shutdownInteractiveSession({
				tui: app.getActiveTui(),
				drainInput: () => terminal.drainInput(),
				prepareShutdown: () => app.requestShutdown(),
				disposeApp: () => app.dispose(),
			});
		} finally {
			resolveExit();
		}
	};
	const terminate = (): void => {
		void shutdown();
	};
	process.once("SIGTERM", terminate);
	process.once("SIGHUP", terminate);
	tui.addChild(app);
	tui.setFocus(app);
	terminal.setTitle("VSPi");
	try {
		await startUiAfterSplash({
			width: terminal.columns,
			theme,
			write: (chunk) => {
				if (!closing) terminal.write(chunk);
			},
			startApp: async () => {
				await app.start();
				return app.startupStatus();
			},
			startTui: (startupSurface) => {
				if (closing) return;
				app.setStartupSurface(startupSurface);
				app.getActiveTui().start();
			},
		});
		await exited;
	} finally {
		process.off("SIGTERM", terminate);
		process.off("SIGHUP", terminate);
		if (!closing) await shutdown();
	}
}

export function formatRuntimeMigrationWarning(reason: string): string {
	switch (reason) {
		case "bad-toml":
			return "启动时已修复损坏的配置文件";
		case "effort-repair":
			return "启动时已修复不兼容的 Thinking Effort 配置";
		case "default-model-repair":
			return "启动时已修复无效的默认模型配置";
		default:
			return "启动时已迁移旧版配置";
	}
}

function displayModelId(provider: string, alias: string): string {
	const prefix = `${provider}/`;
	return alias.startsWith(prefix) ? alias.slice(prefix.length) : alias;
}
