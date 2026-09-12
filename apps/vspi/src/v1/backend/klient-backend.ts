import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
	AgentCronTask,
	AgentHandle,
	AgentEventPayloads,
	AgentTaskInfo,
	TowerMissionProjection,
	IDisposable,
	QuestionRequest,
	SessionHandle,
	SessionMeta,
} from "@moonshot-ai/klient";
import type { RuntimeConnection } from "@vsp/vsp-runtime";
import { loginWithOAuth } from "../providers/oauth-login.js";

import type { AgentSnapshot } from "../agents/types.js";
import type { CompactOptions } from "../continuity/compaction-profiles.js";
import type { CronTask } from "../cron/types.js";
import { DEFAULT_USAGE } from "../domain/defaults.js";
import {
	catalogEffortCapability,
	normalizeEffortLevel,
	resolveCatalogEffort,
	preferredVisibleEffort,
	visibleEffortLevels,
} from "../domain/effort.js";
import type {
	CronSessionPresentation,
	EffortLevel,
	PlanItem,
	ProviderOption,
	Question,
	SessionMarkerMessage,
	SessionOption,
	TranscriptMessage,
	UsageSnapshot,
} from "../domain/types.js";
import type {
	ApprovalRequest,
	ApprovalResponse,
	PolicyLevel,
	PolicySnapshot,
} from "../policy/execution-policy.js";
import { OutputSpeedTracker } from "./output-speed.js";
import { editSubagentModels, subagentModelPreferences } from "../domain/subagent-models.js";
import { isOfficialRecommendedModel } from "../domain/recommended-models.js";
import type { SubagentModelEdit, SubagentModelPreferences } from "./types.js";
import type {
	AgentConversationActivity,
	AgentConversationBlock,
	AgentConversationPage,
	BackendSubscription,
	CancelResult,
	ChatBackend,
	ChatBackendEvents,
	ModelSelectionResult,
	ProviderAuthInteraction,
	RuntimeGoalSnapshot,
	RuntimeGoalStatus,
	RuntimeModelOption,
	SendOptions,
	SendResult,
	TaskDashboardItem,
	TaskDashboardSnapshot,
} from "./types.js";

interface TurnState {
	effort?: EffortLevel;
	readonly id: number;
	readonly segment: number;
	readonly assistantId: string;
	readonly thinkingId: string;
}

interface PendingPrompt {
	resolve(result: SendResult): void;
	reject(error: Error): void;
}

type PromptLifecyclePhase =
	| "queued"
	| "consuming"
	| "started"
	| "responding"
	| "completed"
	| "failed"
	| "cancelled";

interface QueuedPrompt {
	readonly text: string;
	readonly delivery: "steer" | "followUp";
	phase: PromptLifecyclePhase;
}

const PROMPT_LIFECYCLE_ORDER: readonly PromptLifecyclePhase[] = [
	"queued",
	"consuming",
	"started",
	"responding",
	"completed",
];

interface ProviderAvailability {
	readonly modelIds: ReadonlySet<string>;
	readonly expiresAt: number;
}

const PROVIDER_AVAILABILITY_TTL_MS = 5 * 60_000;

export type SessionStartupMode = "new" | "continue" | "resume";

export function resolveSessionStartupMode(
	command: string | undefined,
): SessionStartupMode {
	if (command === "continue") return "continue";
	if (command === "resume") return "resume";
	return "new";
}

export function sessionDisplayLabel(item: {
	readonly title?: string;
	readonly lastPrompt?: string;
}): string {
	const title = normalizeSessionLabel(item.title);
	if (title !== undefined && title.toLocaleLowerCase() !== "new session")
		return title;
	return normalizeSessionLabel(item.lastPrompt) ?? "空会话";
}

function normalizeSessionLabel(value: string | undefined): string | undefined {
	const normalized = value?.replace(/\s+/gu, " ").trim();
	return normalized ? normalized : undefined;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

export class KlientChatBackend implements ChatBackend {
	readonly kind = "runtime" as const;
	supportsVision = false;
	private events: ChatBackendEvents | undefined;
	private connection: RuntimeConnection;
	private session: SessionHandle | undefined;
	private agent: AgentHandle | undefined;
	private meta: SessionMeta | undefined;
	private subscriptions: IDisposable[] = [];
	private globalSubscriptions: IDisposable[] = [];
	private childConversationSubscription: BackendSubscription | undefined;
	private turn: TurnState | undefined;
	private lastRetryKey: string | undefined;
	private pendingPrompts = new Map<string, PendingPrompt>();
	private queuedPrompts = new Map<string, QueuedPrompt>();
	private promptPhases = new Map<string, PromptLifecyclePhase>();
	private promptTurns = new Map<number, Set<string>>();
	private turnEndWaiters = new Map<number, Set<() => void>>();
	private tasks = new Map<string, AgentTaskInfo>();
	private taskOutputs = new Map<string, string>();
	private parentTaskSummaries = new Map<string, string>();
	private pendingTodoUpdates = new Map<string, PlanItem[]>();
	private lastTodoItems: PlanItem[] = [];
	private towerPlanActive = false;
	private toolNames = new Map<string, string>();
	private cronTasks: CronTask[] = [];
	private runtimeGoalRevision = 0;
	private taskPoll: NodeJS.Timeout | undefined;
	private towerPoll: NodeJS.Timeout | undefined;
	private busy = false;
	private connectionFailed = false;
	private recovering = false;
	private disposed = false;
	private draftModelAlias: string | undefined;
	private draftPermission: "auto" | "yolo" | "manual" | undefined;
	private policyRevision = 0;
	private policy: PolicyLevel = "Auto";
	private permissionWrite: Promise<void> = Promise.resolve();
	private sessionCreation: Promise<void> | undefined;
	private submissionEpoch = 0;
	private subagentTimeoutSeconds = 0;
	private readonly outputSpeed = new OutputSpeedTracker();
	private lastUsageSnapshot: UsageSnapshot | undefined;
	private cacheTelemetryObserved = false;
	private effort: EffortLevel = "medium";
	private currentModel = "";
	private currentModelLabel = "";
	private currentProvider = "";
	private providerAvailability = new Map<string, ProviderAvailability>();
	private modelOptionsPromise: Promise<RuntimeModelOption[]> | undefined;
	private subagentModelWrite: Promise<unknown> = Promise.resolve();
	private activityRevision = 0;
	private modelRevision = 0;
	private readonly polls = new Map<string, { promise: Promise<void>; next?: () => Promise<void> }>();
	private readonly pendingInteractions = new Map<string, AbortController>();
	private interactionsDirty = false;
	private interactionRefresh: Promise<void> | undefined;
	private historyBefore: number | undefined;
	private hydrating = false;
	private historyRevision = 0;
	private historyOverflow = false;
	private historyEventBytes = 0;
	private historyEvents: Array<{ revision?: number; apply: () => void }> = [];

	constructor(
		connection: RuntimeConnection,
		private readonly cwd: string,
		private readonly startupMode: SessionStartupMode,
		private readonly reconnectRuntime?: () => Promise<RuntimeConnection>,
		private readonly recoveryDelays: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000],
		private readonly recentSessionDelays: readonly number[] = [0, 100, 400, 1000],
	) {
		this.connection = connection;
	}

	get runtimeConnection(): RuntimeConnection {
		return this.connection;
	}

	get modelLabel(): string {
		if (!this.currentModelLabel) return "未选择模型";
		return `${formatProviderDisplayName(this.currentProvider)} · ${this.currentModelLabel}`;
	}

	get modelId(): string {
		return this.currentModel;
	}

	get modelProvider(): string | undefined {
		return this.currentProvider || undefined;
	}

	isSessionReady(): boolean {
		return this.session !== undefined;
	}

	async start(events: ChatBackendEvents): Promise<void> {
		this.events = events;
		this.subscribeGlobalCatalog();
		void this.refreshRelayCatalogs();
		void this.connection.klient.global.config.get<{ timeoutMs?: number } | undefined>("subagent")
			.then((config) => { if (config?.timeoutMs !== undefined) this.subagentTimeoutSeconds = config.timeoutMs / 1000; })
			.catch(() => {});
		const workspace =
			await this.connection.klient.global.workspaces.createOrTouch({
				root: this.cwd,
			});
		if (this.startupMode === "resume") { await this.prepareDraft("startup"); return; }
		let meta: SessionMeta | undefined;
		if (this.startupMode === "continue") {
			let latest: Awaited<ReturnType<RuntimeConnection['klient']['global']['sessions']['list']>>['items'][number] | undefined;
			for (const wait of this.recentSessionDelays) {
				if (wait > 0) await delay(wait);
				if (this.disposed) return;
				const page = await this.connection.klient.global.sessions.list({ workspaceIds: [workspace.id], limit: 1 });
				latest = page.items[0];
				if (latest) break;
			}
			if (latest !== undefined) {
				const existing = this.connection.klient.session(latest.id);
				await existing.restore();
				meta = await existing.get();
			}
			else events.onNotice('尚未找到可续接记录；若会话刚创建，请稍后使用 /sessions 刷新选择。当前仅打开草稿。', 'info');
		}
		if (meta) await this.bindSession(meta, "resume");
		else await this.prepareDraft("startup");
		events.onSessionReady?.();
	}

	private async prepareDraft(reason: "startup" | "new"): Promise<void> {
		this.clearBindings();
		this.session = undefined;
		this.agent = undefined;
		this.meta = undefined;
		this.draftPermission = undefined;
		const policyRevision = ++this.policyRevision;
		const [alias, thinking, models, providers, permission] = await Promise.all([
			this.connection.klient.global.config.get<string | undefined>("defaultModel"),
			this.connection.klient.global.config.get<{ effort?: string; modelEfforts?: Record<string, string> } | undefined>("thinking"),
			this.connection.klient.global.kosong.listModels(),
			this.connection.klient.global.kosong.listProviders(),
			this.connection.klient.global.config.get<"auto" | "yolo" | "manual" | undefined>("defaultPermissionMode"),
		]);
		if (this.policyRevision === policyRevision) this.publishPolicy(permission ?? "auto");
		const selected = models.find((model) => model.model === alias);
		this.draftModelAlias = selected?.model;
		this.applyModel(selected?.provider ?? "", selected ? displayModelId(selected.provider, selected.model) : "", selected?.capabilities ?? [], selected?.display_name);
		const capability = catalogEffortCapability(selected?.thinking, { identity: selected?.provider, type: providers.find((provider) => provider.id === selected?.provider)?.type });
		const previousEffort = (alias ? thinking?.modelEfforts?.[alias] : undefined) ?? thinking?.effort;
		this.effort = preferredVisibleEffort(previousEffort, capability);
		if (previousEffort !== undefined && previousEffort !== this.effort) this.events?.onNotice(`旧默认 Effort ${previousEffort} 不受当前模型支持，已预选 ${this.effort}；可通过 /model 重新确认`, "warning");
		this.events?.onSessionReset?.({ id: `draft-${randomUUID()}`, reason, effort: this.effort });
		this.events?.onPlanItems?.([]);
		this.events?.onUsage({ ...DEFAULT_USAGE, contextWindow: selected?.max_context_size ?? 0 });
	}

	private async refreshRelayCatalogs(): Promise<void> {
		try {
			const providers = await this.connection.klient.global.kosong.listProviders();
			for (const provider of providers.filter((provider) => provider.id === "vsplab" || provider.type === "vsplab")) {
				const result = await this.connection.klient.global.kosong.refreshProviders({ providerId: provider.id });
				for (const failure of result.failed) this.events?.onNotice(`模型目录刷新失败，保留本地快照：${failure.reason}`, "warning");
			}
		} catch (error) {
			this.events?.onNotice(`模型目录补充暂不可用：${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	private async ensureSession(epoch: number): Promise<void> {
		if (this.sessionCreation) { await this.sessionCreation; return; }
		if (this.agent) return;
		if (!this.sessionCreation) {
			const create = async () => {
				if (!this.draftModelAlias) throw new Error("请先配置并选择模型");
				const meta = await this.connection.klient.global.sessions.create({ workDir: this.cwd });
				try {
					if (epoch !== this.submissionEpoch) { await this.connection.klient.session(meta.id).delete(); return; }
					await this.bindSession(meta, "created");
					this.events?.onSessionReady?.();
				} catch (error) {
					this.clearBindings(); this.agent = undefined; this.session = undefined; this.meta = undefined;
					await this.connection.klient.session(meta.id).delete().catch(() => this.events?.onNotice("初始化失败的空会话未能清理", "warning"));
					throw error;
				}
			};
			const pending = create();
			this.sessionCreation = pending;
			void pending.finally(() => { if (this.sessionCreation === pending) this.sessionCreation = undefined; }).catch(() => {});
		}
		await this.sessionCreation;
	}

	async send(text: string, options: SendOptions): Promise<SendResult> {
		if (!text.trim() && options.attachments.length === 0) return { status: "cancelled" };
		const epoch = this.submissionEpoch;
		const input: Parameters<AgentHandle["prompt"]>[0]["input"] = [
			{ type: "text", text },
			...await Promise.all(options.attachments.map(async (attachment) => ({
				type: "image_url" as const,
				imageUrl: { url: `data:${attachment.mimeType};base64,${(await readFile(attachment.path)).toString("base64")}` },
			}))),
		];
		if (epoch !== this.submissionEpoch) return { status: "cancelled" };
		await this.ensureSession(epoch);
		if (epoch !== this.submissionEpoch) return { status: "cancelled" };
		const agent = this.requireAgent();
		if (this.busy) {
			const promptId = options.clientMessageId ?? randomUUID();
			const delivery = options.behavior === "followUp" ? "followUp" : "steer";
			this.queuedPrompts.set(promptId, {
				text,
				delivery,
				phase: "queued",
			});
			this.setPromptPhase(promptId, "queued");
			this.publishQueueState();
			try {
				if (delivery === "followUp") {
					await agent.prompt({ input, promptId });
				} else {
					await agent.steer({ input, promptId });
				}
			} catch (error) {
				this.queuedPrompts.delete(promptId);
				this.setPromptPhase(promptId, "failed");
				this.publishQueueState();
				throw error;
			}
			return { status: "queued", delivery };
		}
		const promptId = options.clientMessageId ?? randomUUID();
		const completion = new Promise<SendResult>((resolve, reject) => {
			this.pendingPrompts.set(promptId, { resolve, reject });
		});
		void completion.catch(() => {});
		try {
			await agent.prompt({ input, promptId });
		} catch (error) {
			this.pendingPrompts.delete(promptId);
			throw error;
		}
		return completion;
	}

	async cancel(): Promise<CancelResult> {
		this.submissionEpoch += 1;
		const agent = this.agent;
		if (agent === undefined) return { queuedMessages: [] };
		const queued = [...this.queuedPrompts.values()];
		const turnId = this.turn?.id;
		const ended =
			turnId === undefined ? undefined : this.waitForTurnEnd(turnId);
		await agent.cancelCompaction();
		await agent.cancel({ turnId });
		if (ended !== undefined) await ended;
		this.queuedPrompts.clear();
		this.publishQueueState();
		return { queuedMessages: queued.filter((item) => item.phase === "queued").map((item) => item.text) };
	}

	compact(options?: CompactOptions): Promise<boolean> {
		return this.requireAgent().compact({
			instruction: options?.customInstructions,
		});
	}

	async newSession(): Promise<void> {
		this.submissionEpoch += 1;
		await this.sessionCreation?.catch(() => {});
		await this.prepareDraft("new");
		this.events?.onSessionReady?.();
	}

	async listSessions(): Promise<SessionOption[]> {
		const workspaces = await withTimeout(
			this.connection.klient.global.workspaces.list(),
			10_000,
			"读取 workspace 超时",
		);
		const workspace = workspaces.find((item) => item.root === this.cwd);
		if (workspace === undefined) return [];
		const page = await withTimeout(
			this.connection.klient.global.sessions.list({
				workspaceIds: [workspace.id],
				limit: 100,
			}),
			10_000,
			"读取会话列表超时",
		);
		return page.items.map((item) => ({
			id: item.id,
			label: sessionDisplayLabel(item),
			relativeTime: relativeTime(item.updatedAt),
			branchDepth: 0,
			current: item.id === this.meta?.id,
		}));
	}

	async switchSession(id: string): Promise<void> {
		const handle = this.connection.klient.session(id);
		const restored = await withTimeout(
			handle.restore(),
			15_000,
			"恢复会话超时",
		);
		if (!restored) throw new Error(`Session ${id} 不存在`);
		const meta = await withTimeout(handle.get(), 10_000, "读取会话信息超时");
		await this.bindSession(meta, "resume");
		this.events?.onSessionReady?.();
	}

	async generateSessionTitle(): Promise<string | undefined> {
		return this.requireSession().generateTitle({ source: "digest" });
	}

	async forkSession(id: string): Promise<void> {
		const forked = await this.connection.klient.session(id).fork();
		await this.bindSession(forked, "fork");
		this.events?.onSessionReady?.();
	}

	async getModelOptions(): Promise<RuntimeModelOption[]> {
		if (this.modelOptionsPromise === undefined) {
			const pending = this.loadModelOptions();
			this.modelOptionsPromise = pending;
			void pending.catch(() => {
				if (this.modelOptionsPromise === pending)
					this.modelOptionsPromise = undefined;
			});
		}
		return this.modelOptionsPromise;
	}

	private async loadModelOptions(): Promise<RuntimeModelOption[]> {
		const [models, providers] = await Promise.all([
			this.connection.klient.global.kosong.listModels(),
			this.connection.klient.global.kosong.listProviders(),
		]);
		await Promise.all(
			providers
				.filter(
					(provider) =>
						provider.status === "connected" &&
						provider.has_api_key &&
						provider.base_url !== undefined &&
						!hiddenLegacyProvider(provider.id),
				)
				.map((provider) => this.queryProviderAvailability(provider.id)),
		);
		const selectableProviders = new Set(
			providers
				.filter(
					(provider) =>
						provider.status === "connected" &&
						!hiddenLegacyProvider(provider.id),
				)
				.map((provider) => provider.id),
		);
		const providerTypes = new Map(
			providers.map((provider) => [provider.id, provider.type]),
		);
		return models
			.filter((model) => selectableProviders.has(model.provider))
			.map((model) => ({
				id: displayModelId(model.provider, model.model),
				protocol: model.protocol,
				provider: model.provider,
				alias: model.model,
				brand: formatProviderDisplayName(model.provider),
				label: formatModelDisplayName(
					model.provider,
					displayModelId(model.provider, model.model),
					model.display_name,
				),
				vision: model.capabilities?.includes("image_in") ?? false,
				curated: isOfficialRecommendedModel(displayModelId(model.provider, model.model), model.display_name),
				releasedAt: model.released_at,
				efforts: visibleEffortLevels(catalogEffortCapability(model.thinking, {
					identity: model.provider,
					type: providerTypes.get(model.provider),
				}).options),
				effortMutable: visibleEffortLevels(catalogEffortCapability(model.thinking, {
					identity: model.provider,
					type: providerTypes.get(model.provider),
				}).options).length > 1,
				defaultEffort: preferredVisibleEffort(undefined, catalogEffortCapability(model.thinking, {
					identity: model.provider,
					type: providerTypes.get(model.provider),
				})),
				price:
					model.pricing === undefined
						? {}
						: {
								inputUsdPerMillion: model.pricing.input_usd_per_million,
								outputUsdPerMillion: model.pricing.output_usd_per_million,
								cacheReadUsdPerMillion:
									model.pricing.cache_read_usd_per_million,
								cacheWriteUsdPerMillion:
									model.pricing.cache_write_usd_per_million,
								source: model.pricing_source ?? "provider" as const,
								referenceProvider: model.provider,
								contextTiers: model.pricing.context_tiers?.map((tier) => ({
									contextTokensAbove: tier.context_tokens_above,
									inputUsdPerMillion: tier.input_usd_per_million,
									outputUsdPerMillion: tier.output_usd_per_million,
								})),
							},
				contextWindow: model.max_context_size,
			}));
	}

	async getModelGroups() {
		return [];
	}

	async getSubagentModelPreferences(): Promise<SubagentModelPreferences> {
		const timeout = await this.connection.klient.global.config.get<{ timeoutMs?: number } | undefined>("subagent");
		if (timeout?.timeoutMs !== undefined) this.subagentTimeoutSeconds = timeout.timeoutMs / 1000;
		return subagentModelPreferences(await this.connection.klient.global.config.get<Record<string, unknown> | undefined>("secondaryModel"));
	}

	updateSubagentModelPreferences(edit: SubagentModelEdit): Promise<SubagentModelPreferences> {
		const save = async () => {
			const config = this.connection.klient.global.config;
			const inspection = await config.inspect<Record<string, unknown>>("secondaryModel");
			const current = subagentModelPreferences(inspection.userValue);
			if (current.force) throw new Error("secondary_model.force=true；请先在 core 配置中关闭 force，再编辑候选池");
			if (edit.model === "primary") throw new Error("primary 是继承主模型的保留标识，不能加入候选池");
			const removing = edit.action === "toggle" && Object.hasOwn(current.models, edit.model);
			if (!removing) {
				const models = await this.connection.klient.global.kosong.listModels();
				if (!models.some((model) => model.model === edit.model)) throw new Error("模型已不在当前目录中，请刷新后重试");
			}
			const next = editSubagentModels(current, edit);
			await config.replace({ domain: "secondaryModel", value: {
				...inspection.userValue,
				model: undefined,
				force: false,
				models: Object.keys(next.models).length ? next.models : undefined,
				defaultModel: next.defaultModel,
			} });
			return this.getSubagentModelPreferences();
		};
		const pending = this.subagentModelWrite.then(save, save);
		this.subagentModelWrite = pending.catch(() => undefined);
		return pending;
	}

	async getProviderOptions(): Promise<ProviderOption[]> {
		const [providers, builtins, loginProviders, configured] = await Promise.all([
			this.connection.klient.global.kosong.listProviders(),
			this.connection.klient.global.kosong.listBuiltinProviders(),
			this.connection.klient.global.auth.listLoginProviders(),
			this.connection.klient.global.config.inspect<Record<string, Record<string, unknown>>>("providers"),
		]);
		return [...new Map([...builtins, ...providers].map((provider) => [provider.id, provider])).values()]
			.filter((provider) => !hiddenLegacyProvider(provider.id))
			.map((provider) => ({
				id: provider.id,
				label: formatProviderDisplayName(provider.id),
				protocol: provider.type,
				status:
					provider.status === "connected"
						? "已配置"
						: provider.status === "error"
							? "异常"
							: "未配置",
				detail: `${String(provider.models?.length ?? 0)} models`,
				baseUrl: provider.base_url,
				custom: true,
				authMethods: [
					{ type: "api_key" as const, label: "API Key" },
					...loginProviders.some((login) => login.id === provider.type || login.id === provider.id)
						? [{ type: "oauth" as const, label: "订阅账号" }] : [],
				],
				storedCredential: configured.userValue?.[provider.id]?.["oauth"] !== undefined
					? "oauth" : provider.has_api_key ? "api_key" : undefined,
			}));
	}

	async selectModel(
		provider: string,
		id: string,
		requestedEffort?: EffortLevel,
	): Promise<ModelSelectionResult> {
		const epoch = this.submissionEpoch;
		const agent = this.agent;
		const [models, providers] = await Promise.all([
			this.connection.klient.global.kosong.listModels(),
			this.connection.klient.global.kosong.listProviders(),
		]);
		const selectedProvider = providers.find(
			(candidate) => candidate.id === provider,
		);
		if (
			selectedProvider?.status !== "connected" ||
			hiddenLegacyProvider(provider)
		) {
			throw new Error(`Provider ${provider} 当前不可用`);
		}
		const alias = resolveModelAlias(models, provider, id);
		const model = models.find((item) => item.model === alias);
		if (!model) throw new Error(`模型 ${alias} 不在当前目录中`);
		const capability = catalogEffortCapability(model.thinking, { identity: provider, type: selectedProvider.type });
		const effort = requestedEffort ?? (await this.getPreferredModelEffort(provider, id)).effort;
		if (!capability.options.includes(effort)) throw new Error(`模型 ${alias} 不支持 Effort ${effort}，请重新选择`);
		if (epoch !== this.submissionEpoch || agent !== this.agent) throw new Error("Session changed");
		const binding = await agent?.setModel(alias, effort);
		const applied = binding?.thinking ?? (agent ? await agent.getThinking() : effort);
		if (epoch !== this.submissionEpoch || agent !== this.agent) throw new Error("Session changed");
		this.effort = normalizeEffortLevel(applied, effort);
		this.draftModelAlias = alias;
		this.applyModel(
			model.provider,
			displayModelId(model.provider, model.model),
			model.capabilities ?? [],
			model.display_name,
		);
		let warning = this.effort === effort ? undefined : `所选 Effort ${effort} 被配置约束为 ${this.effort}`;
		try { await this.connection.klient.global.kosong.setDefaultModel(alias); }
		catch (error) { warning = `当前选择已生效，但默认模型未保存：${error instanceof Error ? error.message : String(error)}`; }
		return {
			modelId: id,
			vision: this.supportsVision,
			contextWindow: model.max_context_size,
			profileModelId: id,
			effort: this.effort,
			warning,
		};
	}

	async getPreferredModelEffort(provider: string, id: string): Promise<{ effort: EffortLevel; warning?: string }> {
		const model = (await this.getModelOptions()).find((item) => item.provider === provider && item.id === id);
		if (!model) throw new Error(`模型 ${provider}/${id} 不在当前目录中`);
		const thinking = await this.connection.klient.global.config.get<{ modelEfforts?: Record<string, string> } | undefined>("thinking");
		const current = provider === this.currentProvider && id === this.currentModel;
		const saved = current && this.agent ? this.effort : thinking?.modelEfforts?.[model.alias] ?? (current ? this.effort : undefined);
		const effort = preferredVisibleEffort(saved, { options: model.efforts, defaultEffort: model.defaultEffort ?? "off" });
		return {
			effort,
			warning: saved !== undefined && saved !== effort ? `之前的 Effort ${saved} 不在当前可选档位中，请确认 ${effort === "off" ? "固定配置" : effort}` : undefined,
		};
	}

	async rememberModelEffort(provider: string, id: string, effort: EffortLevel): Promise<void> {
		const models = await this.connection.klient.global.kosong.listModels();
		const alias = resolveModelAlias(models, provider, id);
		await this.connection.klient.global.config.set({ domain: "thinking", patch: { modelEfforts: { [alias]: effort } } });
	}

	async runProviderProbe(
		providerId: string,
		mode: "check-config" | "test-connection" | "minimal-generation",
		confirmCost?: () => Promise<boolean>,
	): Promise<{ ok: boolean; diagnostic: string }> {
		const provider =
			await this.connection.klient.global.kosong.getProvider(providerId);
		if ((provider.models?.length ?? 0) === 0) {
			return { ok: false, diagnostic: `Provider ${providerId} 没有已配置模型` };
		}
		if (provider.status !== "connected") {
			return { ok: false, diagnostic: `Provider ${providerId} 缺少可用凭据` };
		}
		if (
			mode === "minimal-generation" &&
			confirmCost !== undefined &&
			!(await confirmCost())
		) {
			return { ok: false, diagnostic: "已取消最小生成测试" };
		}
		return {
			ok: true,
			diagnostic:
				mode === "check-config"
					? `Provider ${providerId} 配置完整，包含 ${String(provider.models?.length ?? 0)} 个模型`
					: `Provider ${providerId} 的模型与凭据已由 Core 解析；当前 Core 不提供无计费网络探测`,
		};
	}

	async loginProvider(
		providerId: string,
		type: "api_key" | "oauth",
		interaction: ProviderAuthInteraction,
	): Promise<void> {
		if (type === "api_key") {
			const apiKey = await interaction.prompt({
				type: "secret",
				message: `${providerId} API Key`,
				placeholder: "API Key",
				signal: interaction.signal,
			});
			const inspection =
				await this.connection.klient.global.config.inspect<
					Record<string, Record<string, unknown>>
				>("providers");
			const providers = { ...inspection.userValue };
			const provider = providers[providerId];
			if (provider === undefined) {
				await this.connection.klient.global.kosong.configureBuiltinProvider(providerId, apiKey);
				return;
			}
			providers[providerId] = { ...provider, apiKey, oauth: undefined };
			await this.connection.klient.global.config.replace({
				domain: "providers",
				value: providers,
			});
			interaction.notify({
				type: "info",
				message: "API Key 已保存到 VSPi Core 配置",
			});
			return;
		}
		await loginWithOAuth(this.connection.klient.global.auth, providerId, interaction);
	}

	async logoutProvider(providerId: string): Promise<void> {
		const inspection =
			await this.connection.klient.global.config.inspect<
				Record<string, Record<string, unknown>>
			>("providers");
		const providers = { ...inspection.userValue };
		const provider = providers[providerId];
		if (provider === undefined)
			throw new Error(`Provider ${providerId} 不存在`);
		if (provider["oauth"] !== undefined) {
			await this.connection.klient.global.auth.logout(providerId);
			return;
		}
		providers[providerId] = { ...provider, apiKey: undefined };
		await this.connection.klient.global.config.replace({
			domain: "providers",
			value: providers,
		});
	}

	async getEffortOptions(): Promise<EffortLevel[]> {
		const model = (await this.getModelOptions()).find(
			(item) =>
				item.provider === this.currentProvider && item.id === this.currentModel,
		);
		return model?.efforts ?? ["off"];
	}

	async setEffort(level: EffortLevel): Promise<EffortLevel> {
		if (!this.agent) { this.effort = level; return level; }
		await this.agent.setThinking(level);
		this.effort = normalizeEffortLevel(await this.agent.getThinking(), level);
		return this.effort;
	}

	async setPolicy(policy: PolicyLevel): Promise<PolicySnapshot> {
		const mode =
			policy === "Auto" ? "auto" : policy === "YOLO" ? "yolo" : "manual";
		if (!this.agent) {
			this.draftPermission = mode;
			return this.publishPolicy(mode, policy);
		}
		const agent = this.agent;
		await this.writePermission(agent, mode);
		return this.refreshPolicy(agent, policy);
	}

	private writePermission(agent: AgentHandle, mode: "auto" | "yolo" | "manual"): Promise<void> {
		const write = this.permissionWrite.catch(() => {}).then(async () => {
			if (this.agent !== agent || this.disposed) return;
			await agent.setPermission(mode);
		});
		this.permissionWrite = write;
		return write;
	}

	private policySnapshot(): PolicySnapshot {
		return {
			policy: this.policy,
			boundary: "Host",
			sandboxed: false,
			recovery: false,
			sessionAllowlist: [],
		};
	}

	private publishPolicy(mode: "auto" | "yolo" | "manual", preferred?: PolicyLevel): PolicySnapshot {
		const manual = preferred ?? this.policy;
		this.policy = mode === "auto" ? "Auto" : mode === "yolo" ? "YOLO" : manual === "Safe" ? "Safe" : "Standard";
		this.policyRevision += 1;
		const snapshot = this.policySnapshot();
		this.events?.onPolicySnapshot?.(snapshot);
		return snapshot;
	}

	private async refreshPolicy(agent: AgentHandle, preferred?: PolicyLevel): Promise<PolicySnapshot> {
		const revision = this.policyRevision;
		const mode = await agent.getPermission();
		if (this.agent !== agent || this.policyRevision !== revision) return this.policySnapshot();
		return this.publishPolicy(mode, preferred);
	}

	stopAgentTask(taskId: string): Promise<void> {
		return this.requireAgent().stopTask({ taskId, reason: "Stopped by user" });
	}

	detachAgentTask(taskId: string): Promise<void> {
		return this.requireAgent().detachTask({ taskId });
	}

	async detachForegroundTasks(): Promise<number> {
		const agent = this.requireAgent();
		const tasks = await agent.getTasks({ activeOnly: true, limit: 100 });
		const foreground = tasks.filter(
			(task) =>
				task.status === "running" &&
				task.detached !== true &&
				(task.kind === "process" || task.kind === "agent"),
		);
		let detached = 0;
		for (const task of foreground) {
			await agent.detachTask({ taskId: task.taskId });
			detached += 1;
		}
		if (detached > 0) await this.refreshTasks(true);
		return detached;
	}

	isProjectTrusted(): boolean {
		return true;
	}

	async getAgentTask(taskId: string): Promise<TaskDashboardItem | undefined> {
		const task = await this.requireAgent().getTask(taskId);
		return task === undefined
			? undefined
			: toTaskDashboardItem(task, this.taskOutputs.get(task.taskId));
	}

	getAgentSnapshot(): AgentSnapshot {
		const active = [...this.tasks.values()]
			.filter(
				(task): task is Extract<AgentTaskInfo, { kind: "agent" }> =>
					task.kind === "agent" && task.status === "running",
			)
			.map((task) =>
				toAgentRunSnapshot(task, this.taskOutputs.get(task.taskId)),
			);
		const recent = [...this.tasks.values()]
			.filter(
				(task): task is Extract<AgentTaskInfo, { kind: "agent" }> =>
					task.kind === "agent" && task.status !== "running",
			)
			.map((task) =>
				toAgentRunSnapshot(task, this.taskOutputs.get(task.taskId)),
			);
		return {
			enabled: true,
			projectTrusted: true,
			recovery: false,
			limits: {
				maxDepth: 5,
				maxAgentsPerTree: 128,
				maxConcurrency: 16,
				maxRunTokens: 0,
				maxTreeTokens: 0,
				maxTreeCostUsd: 0,
				maxRunSeconds: this.subagentTimeoutSeconds,
			},
			pools: [],
			active,
			recent,
			teammates: [],
			authority: {
				pendingRequired: [],
				turnOverrides: [],
				sessionOverrides: [],
				taskEpoch: 0,
			},
		};
	}

	getTaskSnapshot(): TaskDashboardSnapshot {
		const items = [...this.tasks.values()].map((task) =>
			toTaskDashboardItem(task, this.taskOutputs.get(task.taskId)),
		);
		return {
			agents: items.filter(
				(item): item is Extract<TaskDashboardItem, { kind: "agent" }> =>
					item.kind === "agent",
			),
			processes: items.filter(
				(item): item is Extract<TaskDashboardItem, { kind: "process" }> =>
					item.kind === "process",
			),
			questions: items.filter(
				(item): item is Extract<TaskDashboardItem, { kind: "question" }> =>
					item.kind === "question",
			),
		};
	}

	async getAgentConversation(
		runId: string,
		options: { cursor?: string; limit?: number } = {},
	): Promise<AgentConversationPage> {
		const run = this.requireChildAgent(runId);
		const agentId = run.agentId ?? run.taskId;
		const cursor = options.cursor?.match(/^h:(\d+):(\d*)$/u);
		if (options.cursor && !cursor) throw new Error('历史游标已失效，请重新打开 Subagent');
		const before = cursor ? Number(cursor[1]) : undefined;
		const child = this.requireSession().agent(agentId);
		const [page, tokens] = await Promise.all([child.getHistory({ before, limit: 20 }), child.getContextTokenCount()]);
		const projected = projectAgentConversation(runId, agentId, page.items, tokens, { cursor: cursor?.[2] || undefined, limit: options.limit, active: before !== undefined || page.activity.turn !== undefined });
		const end = (page.before ?? 0) + page.items.length;
		return { ...projected, totalBlocks: undefined, nextCursor: projected.nextCursor ? `h:${end}:${projected.nextCursor}` : page.before !== undefined ? `h:${page.before}:` : undefined };
	}

	subscribeAgentConversation(
		runId: string,
		listener: (activity: AgentConversationActivity) => void,
	): BackendSubscription {
		const run = this.requireChildAgent(runId);
		const agentId = run.agentId ?? run.taskId;
		this.childConversationSubscription?.dispose();
		const child = this.requireSession().agent(agentId);
		const subscriptions = [
			child.events.on("turn.started", (event) => {
				listener({ kind: "turn", state: "started", turnId: event.turnId });
			}),
			child.events.on("turn.ended", (event) => {
				listener({ kind: "turn", state: event.reason, turnId: event.turnId });
			}),
			child.events.on("assistant.delta", (event) => {
				listener({
					kind: "assistant",
					turnId: event.turnId,
					delta: event.delta,
				});
			}),
			child.events.on("thinking.delta", (event) => {
				listener({
					kind: "thinking",
					turnId: event.turnId,
					delta: event.delta,
				});
			}),
			child.events.on("tool.call.started", (event) => {
				listener({
					kind: "tool",
					state: "started",
					turnId: event.turnId,
					toolCallId: event.toolCallId,
					toolName: event.name,
					text: event.description,
				});
			}),
			child.events.on("tool.progress", (event) => {
				listener({
					kind: "tool",
					state: "progress",
					turnId: event.turnId,
					toolCallId: event.toolCallId,
					text: event.update.text,
				});
			}),
			child.events.on("tool.result", (event) => {
				listener({
					kind: "tool",
					state: event.isError ? "error" : "completed",
					turnId: event.turnId,
					toolCallId: event.toolCallId,
					text: summarizeOutput(event.output),
				});
			}),
		];
		let disposed = false;
		const subscription: BackendSubscription = {
			dispose: () => {
				if (disposed) return;
				disposed = true;
				for (const item of subscriptions) item.dispose();
				if (this.childConversationSubscription === subscription)
					this.childConversationSubscription = undefined;
			},
		};
		this.childConversationSubscription = subscription;
		return subscription;
	}

	listCronTasks(): readonly CronTask[] {
		return this.cronTasks;
	}

	async createCronTask(input: {
		runAt: number;
		prompt: string;
	}): Promise<CronTask> {
		const task = await this.requireAgent().createCronTask({
			cron: cronExpressionFor(input.runAt),
			prompt: input.prompt,
			recurring: false,
		});
		await this.publishCronTasks();
		return toCronTask(task);
	}

	async deleteCronTask(id: string): Promise<boolean> {
		const deleted = await this.requireAgent().deleteCronTask(id);
		await this.publishCronTasks();
		return deleted;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.submissionEpoch += 1;
		await this.sessionCreation?.catch(() => {});
		this.clearBindings();
		for (const subscription of this.globalSubscriptions) subscription.dispose();
		this.globalSubscriptions = [];
	}

	private async bindSession(
		meta: SessionMeta,
		reason: "startup" | "new" | "resume" | "fork" | "created",
	): Promise<void> {
		this.clearBindings();
		const draftPermission = reason === "created" ? this.draftPermission : undefined;
		this.draftPermission = undefined;
		this.policyRevision += 1;
		if (reason !== "created") this.policy = "Standard";
		this.meta = meta;
		this.session = this.connection.klient.session(meta.id);
		this.agent = this.session.agent("main");
		if (draftPermission !== undefined) await this.writePermission(this.agent, draftPermission);
		let thinking = await this.connection.klient.global.config.get<
			{ effort?: string } | undefined
		>("thinking");
		let defaultModel = await this.connection.klient.global.config.get<
			string | undefined
		>("defaultModel");
		if (reason === "created") { defaultModel = this.draftModelAlias ?? defaultModel; thinking = { effort: this.effort }; }
		let restoredModel: string | undefined;
		if (reason === "resume" || reason === "fork") {
			restoredModel = await this.agent.getModel();
			const catalog = await this.connection.klient.global.kosong.listModels();
			if (catalog.some((model) => model.model === restoredModel)) {
				defaultModel = restoredModel;
				thinking = { effort: await this.agent.getThinking() };
			}
		}
		if (defaultModel !== undefined) {
			const resolvedDefaultModel =
				await this.resolveAvailableDefaultModel(defaultModel);
			const selectedModel = (await this.connection.klient.global.kosong.listModels()).find((model) => model.model === resolvedDefaultModel);
			if (!selectedModel) throw new Error(`模型 ${resolvedDefaultModel} 不在当前目录中`);
			const selected = { model: selectedModel };
			if (reason !== "resume" && reason !== "fork" && resolvedDefaultModel !== defaultModel) await this.connection.klient.global.kosong.setDefaultModel(resolvedDefaultModel);
			if (restoredModel !== resolvedDefaultModel) await this.agent.setModel(resolvedDefaultModel);
			this.applyModel(
				selected.model.provider,
				displayModelId(selected.model.provider, selected.model.model),
				selected.model.capabilities ?? [],
				selected.model.display_name,
			);
			const providers =
				await this.connection.klient.global.kosong.listProviders();
			const effort = catalogEffortCapability(selected.model.thinking, {
				identity: selected.model.provider,
				type: providers.find(
					(candidate) => candidate.id === selected.model.provider,
				)?.type,
			});
			await this.normalizeCurrentEffort(
				{
					efforts: effort.options,
					defaultEffort: effort.defaultEffort,
				},
				thinking?.effort,
			);
			if (resolvedDefaultModel !== defaultModel) {
				this.events?.onNotice(
					`默认模型 ${defaultModel} 当前账号不可用，已切换到 ${resolvedDefaultModel}`,
					"warning",
				);
			}
		} else {
			this.effort = "off";
			this.currentModel = "";
			this.currentModelLabel = "";
			this.currentProvider = "";
			this.supportsVision = false;
		}
		this.events?.onSessionReset?.({ id: meta.id, reason, effort: this.effort });
		this.hydrating = reason !== 'created';
		this.subscribe();
		await this.refreshPolicy(this.agent);
		const agent = this.agent;
		const revision = this.activityRevision;
		const activity = await agent.getActivity();
		if (this.agent === agent && this.activityRevision === revision && !this.hydrating) this.applyActivity(activity);
		this.refreshInteractions();
		await this.publishRuntimeGoalStatus();
		if (reason !== "created") {
			try { await this.restoreHistory(); }
			catch (error) { this.events?.onNotice(`历史尚未同步，当前连接与活动状态已保留；可使用 /history latest 重试：${error instanceof Error ? error.message : String(error)}`, 'warning'); }
		}
		this.taskPoll = setInterval(() => void this.refreshTasks(), 1_000);
		this.taskPoll.unref();
		this.towerPoll = setInterval(() => void this.refreshTowerMissions(), 1_000);
		this.towerPoll.unref();
		await this.refreshTasks();
		await this.refreshTowerMissions();
		await this.publishCronTasks();
		await this.publishUsage();
	}

	private async resolveAvailableDefaultModel(alias: string): Promise<string> {
		const provider = alias.split("/", 1)[0] ?? "";
		if (provider.length === 0) return alias;
		const availability = await this.queryApiKeyProviderAvailability(provider);
		if (availability === undefined) return alias;
		const raw = alias.slice(provider.length + 1);
		if (providerModelAvailable(availability, provider, raw)) return alias;
		const models = await this.connection.klient.global.kosong.listModels();
		const fallback = models.find(
			(model) =>
				model.provider === provider &&
				providerModelAvailable(
					availability,
					model.provider,
					displayModelId(model.provider, model.model),
				),
		);
		return fallback === undefined
			? alias
			: resolveModelAlias(
					models,
					provider,
					displayModelId(fallback.provider, fallback.model),
				);
	}

	private async queryApiKeyProviderAvailability(
		providerId: string,
	): Promise<ReadonlySet<string> | undefined> {
		const providers =
			await this.connection.klient.global.kosong.listProviders();
		const provider = providers.find((item) => item.id === providerId);
		if (
			provider?.status !== "connected" ||
			!provider.has_api_key ||
			provider.base_url === undefined
		)
			return undefined;
		return this.queryProviderAvailability(providerId);
	}

	private async queryProviderAvailability(
		providerId: string,
	): Promise<ReadonlySet<string> | undefined> {
		const cached = this.providerAvailability.get(providerId);
		if (cached !== undefined && cached.expiresAt > Date.now())
			return cached.modelIds;
		try {
			const result =
				await this.connection.klient.global.kosong.queryAvailableModels(
					providerId,
				);
			const modelIds = new Set(result.modelIds);
			this.providerAvailability.set(providerId, {
				modelIds,
				expiresAt: Date.now() + PROVIDER_AVAILABILITY_TTL_MS,
			});
			return modelIds;
		} catch {
			return undefined;
		}
	}

	private subscribeGlobalCatalog(): void {
		const changed = () => {
			this.providerAvailability.clear();
			this.modelOptionsPromise = undefined;
			this.events?.onRuntimeCatalogChanged?.();
		};
		this.globalSubscriptions.push(
			this.connection.klient.events.onError((error) => this.handleConnectionError(error)),
			this.connection.klient.events.on("kosong.providers.changed", changed),
			this.connection.klient.events.on("kosong.models.changed", changed),
		);
	}

	private handleConnectionError(error: Error): void {
		if (error.message !== "ipc closed") { this.events?.onSessionError?.(error); return; }
		if (this.connectionFailed) return;
		this.connectionFailed = true;
		this.turn = undefined;
		for (const pending of this.pendingPrompts.values()) pending.reject(error);
		this.pendingPrompts.clear();
		for (const id of this.queuedPrompts.keys()) this.setPromptPhase(id, "failed");
		this.queuedPrompts.clear();
		this.publishQueueState();
		this.setBusy(false);
		if (this.reconnectRuntime && !this.disposed) {
			void this.recoverConnection();
			return;
		}
		this.events?.onSessionError?.(error);
	}

	private async recoverConnection(): Promise<void> {
		if (this.recovering) return;
		this.recovering = true;
		const delays = this.recoveryDelays;
		try {
			for (let attempt = 1; attempt <= delays.length; attempt += 1) {
				if (this.disposed) return;
				this.events?.onRuntimeConnectionState?.("reconnecting", attempt);
				await delay(delays[attempt - 1]!);
				if (this.disposed) return;
				try {
					const connection = await this.reconnectRuntime!();
					if (this.disposed) {
						await connection.close().catch(() => {});
						return;
					}
					for (const subscription of this.globalSubscriptions) subscription.dispose();
					this.globalSubscriptions = [];
					this.clearBindings();
					await this.connection.close().catch(() => {});
					if (this.disposed) {
						await connection.close().catch(() => {});
						return;
					}
					this.connection = connection;
					this.providerAvailability.clear();
					this.modelOptionsPromise = undefined;
					this.submissionEpoch += 1;
					this.subscribeGlobalCatalog();
					void this.refreshRelayCatalogs();
					if (this.meta) await this.switchSession(this.meta.id);
					else await this.prepareDraft("startup");
					if (this.disposed) {
						this.clearBindings();
						for (const subscription of this.globalSubscriptions) subscription.dispose();
						this.globalSubscriptions = [];
						await connection.close().catch(() => {});
						return;
					}
					this.connectionFailed = false;
					this.events?.onRuntimeConnectionState?.("reconnected", attempt);
					return;
				} catch {
					continue;
				}
			}
			this.events?.onRuntimeConnectionState?.("failed", delays.length);
		} finally {
			this.recovering = false;
		}
	}

	private poll(name: string, run: () => Promise<void>): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const key = `${this.meta?.id ?? 'draft'}:${name}`;
		const pending = this.polls.get(key);
		if (pending) { pending.next = run; return pending.promise; }
		const item: { promise: Promise<void>; next?: () => Promise<void> } = { promise: Promise.resolve() };
		this.polls.set(key, item);
		item.promise = (async () => {
			let next: (() => Promise<void>) | undefined = run;
			while (next && !this.disposed) {
				await next();
				next = item.next;
				item.next = undefined;
			}
		})().finally(() => { if (this.polls.get(key) === item) this.polls.delete(key); });
		return item.promise;
	}

	private ensureTurn(turnId: number, segment?: number): void {
		this.activityRevision++;
		if (this.turn?.id !== turnId || segment !== undefined && this.turn.segment !== segment) {
			this.finishTurnSegment();
			this.turn = { ...turnState(turnId, segment ?? 0), effort: this.effort };
		}
		this.setBusy(true);
	}

	private applyActivity(activity: { turn?: { turnId: number; step: number; retry?: { nextAttempt: number; maxAttempts: number; delayMs: number; statusCode?: number } } }): void {
		if (activity.turn) {
			if (this.turn?.id !== activity.turn.turnId) this.turn = { ...turnState(activity.turn.turnId, Math.max(0, activity.turn.step - 1)), effort: this.effort };
			this.setBusy(true);
			const retry = activity.turn.retry;
			if (retry) {
				const key = `${activity.turn.turnId}:${activity.turn.step}:${retry.nextAttempt}`;
				if (this.lastRetryKey !== key) {
					this.lastRetryKey = key;
					for (const id of [this.turn.assistantId, this.turn.thinkingId]) {
						if (this.streamMessages.has(id)) this.events?.onMessageUpdate(id, { text: '[本次响应中断，已放弃未完成内容]', streaming: false });
					}
					this.advanceTurnSegment();
					this.events?.onNotice(`模型调用暂时失败${retry.statusCode ? `（HTTP ${retry.statusCode}）` : ''}，${Math.ceil(retry.delayMs / 1000)} 秒后进行第 ${retry.nextAttempt}/${retry.maxAttempts} 次尝试；可随时中断`, 'warning');
				}
			}
		} else {
			this.finishTurnSegment();
			this.turn = undefined;
			this.lastRetryKey = undefined;
			this.setBusy(false);
		}
	}

	private async refreshModelBinding(agent: AgentHandle): Promise<void> {
		const revision = ++this.modelRevision;
		try {
			const [alias, effort, models] = await Promise.all([agent.getModel(), agent.getThinking(), this.connection.klient.global.kosong.listModels()]);
			if (this.agent !== agent || this.modelRevision !== revision || this.disposed) return;
			const model = models.find(item => item.model === alias);
			const provider = model?.provider ?? alias.split('/')[0] ?? '';
			this.applyModel(provider, displayModelId(provider, alias), model?.capabilities ?? [], model?.display_name);
			this.effort = normalizeEffortLevel(effort);
			this.events?.onModelChanged?.(this.effort);
		} catch (error) {
			if (this.agent === agent && !this.disposed) this.events?.onNotice(`模型状态同步失败：${error instanceof Error ? error.message : String(error)}`, 'warning');
		}
	}

	private subscribe(): void {
		const agent = this.requireAgent();
		const session = this.requireSession();
		const events = {
			on: <E extends keyof AgentEventPayloads>(name: E, listener: (event: AgentEventPayloads[E]) => void) => agent.events.on(name, event => {
				if (this.agent !== agent) return;
				const revision = record(event)['viewRevision'];
				if (typeof revision === 'number' && revision <= this.historyRevision && name !== 'error') return;
				if (!this.hydrating || name === 'error') { listener(event); return; }
				this.historyEventBytes += JSON.stringify(event).length * 2;
				if (this.historyEvents.length >= 1024 || this.historyEventBytes > 8 * 1024 * 1024) {
					this.historyOverflow = true; this.historyEvents = []; return;
				}
				this.historyEvents.push({ revision: typeof revision === 'number' ? revision : undefined, apply: () => { listener(event); } });
			}),
		};
		this.subscriptions.push(
			events.on("agent.status.updated", () => { void this.refreshModelBinding(agent); }),
			events.on("agent.activity.updated", (activity) => {
				if (this.agent !== agent) return;
				this.activityRevision++;
				this.applyActivity(activity);
			}),
			events.on("permission.mode.changed", ({ mode }) => {
				if (this.agent === agent) this.publishPolicy(mode);
			}),
			events.on("turn.started", (event) => {
				this.outputSpeed.reset();
				this.turn = { ...turnState(event.turnId, 0), effort: this.effort };
				if (event.promptId !== undefined) {
					this.promptTurns.set(event.turnId, new Set([event.promptId]));
					this.setPromptPhase(event.promptId, "started");
				}
				this.setBusy(true);
			}),
			events.on("assistant.delta", (event) => {
				this.ensureTurn(event.turnId, typeof record(event)['viewSegment'] === 'number' ? record(event)['viewSegment'] as number : undefined);
				this.setPromptPhaseForTurn(event.turnId, "responding");
				this.publishSpeed(this.outputSpeed.recordDelta(event.delta));
				const id = this.turn?.assistantId ?? `assistant:${event.turnId}`;
				this.appendStream(id, event.delta, "text");
			}),
			events.on("thinking.delta", (event) => {
				this.ensureTurn(event.turnId, typeof record(event)['viewSegment'] === 'number' ? record(event)['viewSegment'] as number : undefined);
				this.setPromptPhaseForTurn(event.turnId, "responding");
				const id = this.turn?.thinkingId ?? `thinking:${event.turnId}`;
				this.appendStream(id, event.delta, "thinking");
			}),
			events.on("turn.step.started", (event) => {
				if (this.turn) this.turn.effort = this.effort;
				this.setPromptPhaseForTurn(event.turnId, "started");
			}),
			events.on("tool.call.started", (event) => {
				this.advanceTurnSegment();
				this.toolNames.set(event.toolCallId, event.name);
				if (event.name === "TodoList") {
					const items = projectTodoPlanItems(event.args);
					if (items !== undefined)
						this.pendingTodoUpdates.set(event.toolCallId, items);
				}
				this.events?.onMessage({
					id: event.toolCallId,
					role: "assistant",
					kind: "tool",
					name: event.name,
					summary: event.description ?? summarizeArgs(event.args),
					status: "running",
					expanded: false,
				});
			}),
			events.on("tool.result", (event) => {
				const toolName = this.toolNames.get(event.toolCallId);
				this.toolNames.delete(event.toolCallId);
				const todoItems = this.pendingTodoUpdates.get(event.toolCallId);
				this.pendingTodoUpdates.delete(event.toolCallId);
				if (!event.isError && todoItems !== undefined) {
					this.lastTodoItems = structuredClone(todoItems);
					if (!this.towerPlanActive) this.events?.onPlanItems?.(todoItems);
				}
				this.events?.onMessageUpdate(event.toolCallId, {
					status: event.isError ? "error" : "success",
					output: summarizeOutput(event.output),
				});
				if (toolName === "CronCreate" || toolName === "CronDelete")
					void this.publishCronTasks();
				void this.refreshTasks();
			}),
			events.on("turn.ended", (event) => {
				this.finishTurnSegment();
				this.turn = undefined;
				this.setBusy(false);
				this.resolveTurnEnd(event.turnId);
				this.promptTurns.delete(event.turnId);
				if (event.reason !== "completed") {
					this.events?.onNotice(
						`Turn ${event.reason}`,
						event.reason === "cancelled" ? "warning" : "error",
					);
				}
				void this.publishUsage(true);
			}),
			events.on("prompt.completed", (event) => {
				this.removeQueuedPrompt(event.promptId);
				this.setPromptPhase(
					event.promptId,
					event.reason === "failed" || event.reason === "blocked"
						? "failed"
						: "completed",
				);
				const pending = this.pendingPrompts.get(event.promptId);
				this.pendingPrompts.delete(event.promptId);
				pending?.resolve({ status: "completed" });
			}),
			events.on("prompt.aborted", (event) => {
				this.removeQueuedPrompt(event.promptId);
				this.setPromptPhase(event.promptId, "cancelled");
				const pending = this.pendingPrompts.get(event.promptId);
				this.pendingPrompts.delete(event.promptId);
				pending?.resolve({ status: "cancelled" });
			}),
			events.on("prompt.submitted", (event) => {
				const userSubmitted =
					this.pendingPrompts.has(event.promptId) ||
					this.queuedPrompts.has(event.promptId);
				if (event.status === "running")
					this.consumeQueuedPrompt(event.promptId);
				if (userSubmitted) return;
				const cron = projectCronSessionMessage(
					event.userMessageId,
					contentText(event.content),
				);
				if (cron !== undefined) this.events?.onMessage(cron);
				else this.events?.onMessage({ id: event.userMessageId, role: 'user', kind: 'text', text: contentText(event.content) });
			}),
			events.on("prompt.queued", (event) => {
				if (this.queuedPrompts.has(event.promptId))
					this.setPromptPhase(event.promptId, "queued");
				this.publishQueueState();
			}),
			events.on("prompt.steered", (event) => {
				const turnPrompts =
					this.promptTurns.get(this.turn?.id ?? -1) ?? new Set<string>();
					for (const promptId of event.promptIds) {
						this.consumeQueuedPrompt(promptId);
						turnPrompts.add(promptId);
					}
					if (this.turn !== undefined)
						this.promptTurns.set(this.turn.id, turnPrompts);
			}),
			events.on("goal.updated", (event) => {
				this.setRuntimeGoalStatus(event.snapshot?.status, true);
			}),
			events.on("compaction.started", (event) => {
				this.events?.onCompactionActivity?.({
					type: "started",
					trigger: event.trigger,
					startedAt: event.time ?? Date.now(),
				});
			}),
			events.on("compaction.blocked", (event) => {
				this.events?.onCompactionActivity?.({
					type: "blocked",
					turnId: event.turnId,
				});
			}),
			events.on("compaction.completed", (event) => {
				this.events?.onCompactionActivity?.({
					type: "completed",
					result: event.result,
				});
				void this.publishUsage();
			}),
			events.on("compaction.cancelled", () => {
				this.events?.onCompactionActivity?.({ type: "cancelled" });
			}),
			events.on("error", (event) => {
				if (event["code"] === "compaction.failed")
					this.events?.onCompactionActivity?.({ type: "failed" });
				this.events?.onMessage({
					id: `error:${Date.now()}`,
					role: "assistant",
					kind: "error",
					summary: event.message,
					detail: event.message,
					model: this.currentModel,
					expanded: false,
				});
			}),
			session.events.on("interactions.changed", () =>
				this.refreshInteractions(),
			),
			session.events.on("interactions.resolved", () => this.refreshInteractions()),
			agent.events.onError((error) => this.handleConnectionError(error)),
			session.events.onError((error) => this.handleConnectionError(error)),
		);
	}

	private async publishHistory(): Promise<void> {
		const agent = this.requireAgent();
		for (let attempt = 0; attempt < 4; attempt++) {
			this.historyOverflow = false;
			const page = await agent.getHistory({ limit: 100 });
			if (this.agent !== agent) return;
			if (this.historyOverflow) { this.historyEventBytes = 0; continue; }
			this.historyBefore = page.before;
			this.historyRevision = page.revision;
			this.projectHistory(page.items, false);
			this.effort = normalizeEffortLevel(page.effort);
			await this.refreshModelBinding(agent);
			this.applyActivity(page.activity);
			if (page.live) {
				this.turn = { ...turnState(page.live.turnId, page.live.segment), effort: this.effort };
				if (page.live.text) this.appendStream(this.turn.assistantId, page.live.text, 'text');
				if (page.live.thinking) this.appendStream(this.turn.thinkingId, page.live.thinking, 'thinking');
			}
			for (const tool of page.activity.turn?.activeToolCalls ?? []) this.events?.onMessageUpdate(tool.toolCallId, { status: 'running' });
			this.hydrating = false;
			const buffered = this.historyEvents;
			this.historyEvents = []; this.historyEventBytes = 0;
			for (const event of buffered) if (event.revision === undefined || event.revision > page.revision) event.apply();
			if (page.before !== undefined) this.events?.onNotice('已加载最近 100 条记录；使用 /history 分页查看更早记录', 'info');
			if (page.truncated) this.events?.onNotice('超长记录已限制展示长度，完整内容仍保存在会话记录中', 'warning');
			return;
		}
		throw new Error('历史同步期间事件过多，请等待当前步骤完成后重新接入');
	}

	private async restoreHistory(): Promise<void> {
		const agent = this.requireAgent();
		this.hydrating = true;
		try { await this.publishHistory(); }
		catch (error) {
			if (this.agent !== agent) return;
			this.hydrating = false;
			const events = this.historyEvents;
			this.historyEvents = []; this.historyEventBytes = 0; this.historyOverflow = false;
			for (const event of events) event.apply();
			const revision = this.activityRevision;
			const activity = await agent.getActivity();
			if (this.agent === agent && this.activityRevision === revision) this.applyActivity(activity);
			throw error;
		}
	}

	async loadOlderHistory(latest = false): Promise<void> {
		if (latest) { await this.restoreHistory(); return; }
		if (this.historyBefore === undefined) { this.events?.onNotice('没有更早的记录', 'info'); return; }
		const agent = this.requireAgent();
		const page = await agent.getHistory({ before: this.historyBefore, limit: 100 });
		if (this.agent !== agent) return;
		this.historyBefore = page.before;
		this.projectHistory(page.items, true);
	}

	private projectHistory(history: readonly unknown[], prepend: boolean): void {
		const messages: TranscriptMessage[] = [];
		const emit = (message: TranscriptMessage) => { messages.push(message); };
		const update = (id: string, patch: Partial<TranscriptMessage>) => {
			const message = messages.find(item => item.id === id);
			if (message) Object.assign(message, patch);
			else emit({ id, role: 'assistant', kind: 'tool', name: 'Tool', summary: '', status: 'success', expanded: false, ...patch } as TranscriptMessage);
		};
		const toolNames = new Map<string, string>();
		const todoUpdates = new Map<string, PlanItem[]>();
		let latestTodoItems: PlanItem[] | undefined;
		for (const [index, raw] of history.entries()) {
			const message = record(raw);
			const role = message["role"];
			const messageId =
				typeof message["id"] === "string"
					? message["id"]
					: `history:${String(index)}`;
			const content = Array.isArray(message["content"])
				? message["content"]
				: [];
			if (role === "user") {
				const origin = record(message["origin"]);
				const text = contentText(content);
				if (origin["kind"] === "user" && text.length > 0) {
					emit({
						id: messageId,
						role: "user",
						kind: "text",
						text,
					});
				} else if (
					origin["kind"] === "task" &&
					text.length > 0
				) {
					emit({
						id: messageId,
						role: "assistant",
						kind: "session",
						text,
					});
				} else if (origin["kind"] === "cron_job" && text.length > 0) {
					const cron = projectCronSessionMessage(messageId, text, origin);
					if (cron !== undefined) this.events?.onMessage(cron);
				}
				continue;
			}
			if (role === "assistant") {
				const thinking = contentThinking(content);
				if (thinking.length > 0) {
					emit({
						id: `${messageId}:thinking`,
						role: "assistant",
						kind: "thinking",
						effort: this.effort,
						text: thinking,
						collapsed: true,
						streaming: false,
					});
				}
				const text = contentText(content);
				if (text.length > 0) {
					emit({
						id: messageId,
						role: "assistant",
						kind: "text",
						text,
						streaming: false,
					});
				}
				const toolCalls = Array.isArray(message["toolCalls"])
					? message["toolCalls"]
					: [];
				for (const rawToolCall of toolCalls) {
					const toolCall = record(rawToolCall);
					const id =
						typeof toolCall["id"] === "string"
							? toolCall["id"]
							: `${messageId}:tool`;
					const name =
						typeof toolCall["name"] === "string" ? toolCall["name"] : "Tool";
					toolNames.set(id, name);
					if (name === "TodoList") {
						const items = projectTodoPlanItems(toolCall["arguments"]);
						if (items !== undefined) todoUpdates.set(id, items);
					}
					emit({
						id,
						role: "assistant",
						kind: "tool",
						name,
						summary:
							typeof toolCall["arguments"] === "string"
								? toolCall["arguments"]
								: "",
						status: "success",
						expanded: false,
					});
				}
				continue;
			}
			if (role === "tool") {
				const toolCallId =
					typeof message["toolCallId"] === "string"
						? message["toolCallId"]
						: messageId;
				const todoItems = todoUpdates.get(toolCallId);
				if (message["isError"] !== true && todoItems !== undefined)
					latestTodoItems = todoItems;
				update(toolCallId, {
					name: toolNames.get(toolCallId) ?? "Tool",
					status: message["isError"] === true ? "error" : "success",
					output: contentText(content),
				});
			}
		}
		if (this.events?.onHistory) this.events.onHistory(messages, prepend);
		else for (const message of messages) this.events?.onMessage(message);
		if (!prepend && latestTodoItems !== undefined) {
			this.lastTodoItems = structuredClone(latestTodoItems);
			if (!this.towerPlanActive) this.events?.onPlanItems?.(latestTodoItems);
		}
	}

	private appendStream(
		id: string,
		delta: string,
		kind: "text" | "thinking",
	): void {
		const existing = this.streamMessages.get(id);
		if (existing === undefined) {
			const message: TranscriptMessage =
				kind === "text"
					? {
							id,
							role: "assistant",
							kind: "text",
							text: delta,
							streaming: true,
						}
					: {
							id,
							role: "assistant",
							kind: "thinking",
							effort: this.turn?.effort ?? this.effort,
							text: delta,
							collapsed: true,
							streaming: true,
						};
			this.streamMessages.set(id, message);
			this.events?.onMessage(message);
			return;
		}
		if (existing.kind === "text") {
			const next = `${existing.text}${delta}`;
			existing.text = next;
			this.events?.onMessageUpdate(id, { text: next });
		} else if (existing.kind === "thinking") {
			const next = `${existing.text}${delta}`;
			existing.text = next;
			this.events?.onMessageUpdate(id, { text: next });
		}
	}

	private readonly streamMessages = new Map<string, TranscriptMessage>();

	private advanceTurnSegment(): void {
		const turn = this.turn;
		if (turn === undefined) return;
		this.finishTurnSegment();
		this.turn = { ...turnState(turn.id, turn.segment + 1), effort: turn.effort };
	}

	private finishTurnSegment(): void {
		const turn = this.turn;
		if (turn === undefined) return;
		for (const id of [turn.assistantId, turn.thinkingId]) {
			if (!this.streamMessages.has(id)) continue;
			this.events?.onMessageUpdate(id, { streaming: false });
			this.streamMessages.delete(id);
		}
	}

	private async processInteractions(): Promise<void> {
		const session = this.requireSession();
		const [questions, approvals] = await Promise.all([session.questions.list(), session.approvals.list()]);
		if (this.session !== session || this.disposed) return;
		const ids = new Set([...questions, ...approvals].flatMap(request => request.id ? [request.id] : []));
		for (const [id, controller] of this.pendingInteractions) {
			if (ids.has(id)) continue;
			this.pendingInteractions.delete(id);
			controller.abort();
		}
		if (this.pendingInteractions.size > 0) return;
		const question = questions.find(request => request.id !== undefined);
		const approval = question ? undefined : approvals.find(request => request.id !== undefined);
		const id = question?.id ?? approval?.id;
		if (!id) return;
		const controller = new AbortController();
		this.pendingInteractions.set(id, controller);
		const respond = async () => {
			if (question) await this.answerQuestion(question, session, controller.signal);
			else if (approval) {
				const response = await this.events?.onHandoffInteraction?.({ kind: 'approval', request: toApprovalRequest(approval.toolName, approval.action) }, controller.signal);
				if (controller.signal.aborted || this.session !== session || response?.kind !== 'approval') return;
				await session.approvals.decide(id, fromApprovalResponse(response.response));
			}
		};
		void respond().then(() => {
			if (!controller.signal.aborted && this.session === session) this.refreshInteractions();
		}).catch((error: unknown) => {
			if (!controller.signal.aborted && this.session === session && !(error instanceof Error && error.name === 'AbortError')) this.events?.onSessionError?.(error instanceof Error ? error : new Error(String(error)));
		}).finally(() => {
			if (this.pendingInteractions.get(id) === controller) this.pendingInteractions.delete(id);
		});
	}

	private refreshInteractions(): void {
		this.interactionsDirty = true;
		if (this.interactionRefresh || !this.session || this.disposed) return;
		const refresh = async () => {
			while (this.interactionsDirty && this.session && !this.disposed) {
				this.interactionsDirty = false;
				await this.processInteractions();
			}
		};
		this.interactionRefresh = refresh().catch((error: unknown) => {
			if (!this.disposed) this.events?.onSessionError?.(error instanceof Error ? error : new Error(String(error)));
		}).finally(() => { this.interactionRefresh = undefined; if (this.interactionsDirty) this.refreshInteractions(); });
	}

	private async answerQuestion(request: QuestionRequest, session: SessionHandle, signal: AbortSignal): Promise<void> {
		if (request.id === undefined || this.events?.onQuestion === undefined)
			return;
		const questions = request.questions.map(
			(question, index): Question => ({
				id: `${request.id}:${String(index)}`,
				title: question.header ?? "Question",
				prompt: question.question,
				kind: question.multiSelect ? "multiChoice" : "singleChoice",
				options: question.options.map((option, optionIndex) => ({
					id: String(optionIndex),
					label: option.label,
					description: option.description,
				})),
			}),
		);
		const answered = await this.events.onQuestion(questions, signal);
		if (signal.aborted || this.session !== session) return;
		const result: Record<string, string | true> = {};
		for (const [index, question] of request.questions.entries()) {
			const answer = answered[index]?.answer;
			const serialized = serializeQuestionAnswer(question.options, answer);
			if (serialized !== undefined) result[question.question] = serialized;
		}
		await session.questions.answer(request.id, {
			answers: result,
		});
	}

	private refreshTasks(strict = false): Promise<void> {
		return this.poll('tasks', () => this.readTasks(strict));
	}

	private async readTasks(strict: boolean): Promise<void> {
		const agent = this.agent;
		if (agent === undefined) return;
		let tasks: readonly AgentTaskInfo[];
		try {
			tasks = await agent.getTasks({ activeOnly: false, limit: 100 });
		} catch (error) {
			if (strict) throw error;
			return;
		}
		if (this.agent !== agent) return;
		const previous = this.tasks;
		const listedTaskIds = new Set(tasks.map((task) => task.taskId));
		const missingRunningAgents = [...previous.values()].filter(
			(task) =>
				task.kind === "agent" &&
				task.status === "running" &&
				!listedTaskIds.has(task.taskId),
		);
		const rechecked = await Promise.all(
			missingRunningAgents.map(async (previousTask) => {
				try {
					return { task: await agent.getTask(previousTask.taskId) };
				} catch {
					return { task: previousTask };
				}
			}),
		);
		const mergedTasks = [
			...tasks,
			...rechecked.flatMap(({ task }) => (task === undefined ? [] : [task])),
		];
		if (this.agent !== agent) return;
		this.tasks = reconcileTaskSnapshot(previous, mergedTasks, Date.now());
		for (const id of this.taskOutputs.keys()) if (!this.tasks.has(id)) this.taskOutputs.delete(id);
		const retainedParents = new Set([...this.tasks.values()].flatMap(task => task.kind === 'agent' && task.parentToolCallId ? [task.parentToolCallId] : []));
		for (const id of this.parentTaskSummaries.keys()) if (!retainedParents.has(id)) this.parentTaskSummaries.delete(id);
		const outputs = mergedTasks
				.filter(
					(task) =>
						task.kind === "agent" &&
						task.status !== "running" &&
						previous.get(task.taskId)?.status !== task.status,
				);
		for (let offset = 0; offset < outputs.length; offset += 4) {
			await Promise.all(outputs.slice(offset, offset + 4).map(async (task) => {
					try {
						const output = await agent.getTaskOutput({ taskId: task.taskId, tail: 200 });
						if (this.agent === agent && this.tasks.has(task.taskId)) this.taskOutputs.set(task.taskId, output);
					} catch {
						if (this.agent === agent) this.taskOutputs.delete(task.taskId);
					}
			}));
			if (this.agent !== agent) return;
		}
		if (this.agent !== agent) return;
		this.publishParentTaskSummaries();
		this.events?.onAgentSnapshot?.(this.getAgentSnapshot());
		this.events?.onTaskSnapshot?.(this.getTaskSnapshot());
	}

	private refreshTowerMissions(): Promise<void> {
		return this.poll('tower', () => this.readTowerMissions());
	}

	private async readTowerMissions(): Promise<void> {
		const agent = this.agent;
		if (agent === undefined) return;
		try {
			const active = await agent.isTowerActive();
			if (this.agent !== agent) return;
			if (active) {
				this.towerPlanActive = true;
				const missions = await agent.getTowerMissions();
				if (this.agent !== agent) return;
				this.events?.onTowerMissions?.([...missions]);
				this.events?.onPlanItems?.(projectTowerMissionPlanItems(missions));
			} else if (this.towerPlanActive) {
				this.towerPlanActive = false;
				this.events?.onTowerMissions?.([]);
				this.events?.onPlanItems?.(this.lastTodoItems);
			}
		} catch {}
	}

	private publishParentTaskSummaries(): void {
		const grouped = new Map<
			string,
			Extract<AgentTaskInfo, { kind: "agent" }>[]
		>();
		for (const task of this.tasks.values()) {
			if (task.kind !== "agent" || task.parentToolCallId === undefined)
				continue;
			const group = grouped.get(task.parentToolCallId) ?? [];
			group.push(task);
			grouped.set(task.parentToolCallId, group);
		}
		for (const [toolCallId, group] of grouped) {
			const summary = parentTaskSummary(group);
			if (this.parentTaskSummaries.get(toolCallId) === summary) continue;
			this.parentTaskSummaries.set(toolCallId, summary);
			this.events?.onMessageUpdate(toolCallId, { summary });
		}
	}

	private async publishCronTasks(): Promise<void> {
		const agent = this.agent;
		if (agent === undefined) return;
		try {
			const tasks = await agent.getCronTasks();
			if (this.agent !== agent) return;
			this.cronTasks = tasks.map(toCronTask);
			this.events?.onCronSnapshot?.(this.cronTasks);
		} catch {}
	}

	private async publishRuntimeGoalStatus(): Promise<void> {
		const revision = this.runtimeGoalRevision;
		try {
			const status = (await this.requireAgent().getGoal()).goal?.status;
			if (revision === this.runtimeGoalRevision)
				this.setRuntimeGoalStatus(status, false);
		} catch {
			if (revision === this.runtimeGoalRevision)
				this.setRuntimeGoalStatus(undefined, false);
		}
	}

	private setRuntimeGoalStatus(
		status: RuntimeGoalStatus | undefined,
		live: boolean,
	): void {
		if (live) this.runtimeGoalRevision += 1;
		this.events?.onRuntimeGoalStatus?.(status);
	}

	async pauseGoal(): Promise<RuntimeGoalSnapshot> {
		const snapshot = await this.requireAgent().pauseGoal();
		this.setRuntimeGoalStatus(snapshot.status, true);
		return { goalId: snapshot.goalId, status: snapshot.status };
	}

	async resumeGoal(): Promise<RuntimeGoalSnapshot> {
		const snapshot = await this.requireAgent().resumeGoal();
		this.setRuntimeGoalStatus(snapshot.status, true);
		return { goalId: snapshot.goalId, status: snapshot.status };
	}

	async cancelGoal(): Promise<RuntimeGoalSnapshot> {
		const snapshot = await this.requireAgent().cancelGoal();
		this.setRuntimeGoalStatus(undefined, true);
		return { goalId: snapshot.goalId, status: undefined };
	}

	private publishUsage(finishTurn = false): Promise<void> {
		return this.poll('usage', () => this.readUsage(finishTurn));
	}

	private async readUsage(finishTurn: boolean): Promise<void> {
		const agent = this.agent;
		if (!agent) return;
		try {
			const usage = await agent.getUsage();
			if (this.agent !== agent) return;
			const total = usage.total;
			const currentTurn = usage.currentTurn;
			const speed = finishTurn
				? this.outputSpeed.finish(currentTurn?.output ?? 0)
				: this.outputSpeed.snapshot();
			this.cacheTelemetryObserved ||=
				(total?.inputCacheRead ?? 0) + (total?.inputCacheCreation ?? 0) > 0;
			const contextTokens = await agent.getContextTokenCount();
			const modelOptions = await this.getModelOptions();
			if (this.agent !== agent) return;
			const cost = calculateUsageCost(usage.byModel, modelOptions);
			const snapshot: UsageSnapshot = {
				...DEFAULT_USAGE,
				contextTokens,
				inputTokens: total?.inputOther ?? 0,
				outputTokens: total?.output ?? 0,
				cacheReadTokens: this.cacheTelemetryObserved
					? (total?.inputCacheRead ?? 0)
					: null,
				cacheWriteTokens: this.cacheTelemetryObserved
					? (total?.inputCacheCreation ?? 0)
					: null,
				recentCacheHitPercent: this.cacheTelemetryObserved
					? calculateCacheHitPercent(currentTurn)
					: null,
				sessionCacheHitPercent: this.cacheTelemetryObserved
					? calculateCacheHitPercent(total)
					: null,
				throughputNow: speed.now,
				throughputAverage: speed.average,
				costUsd: cost.costUsd,
				costEstimateKind: cost.kind,
				contextWindow:
					modelOptions.find(
						(item) =>
							item.provider === this.currentProvider &&
							item.id === this.currentModel,
					)?.contextWindow ?? 0,
				source: "VSP Runtime usage · base-price estimate",
			};
			snapshot.contextPercent =
				snapshot.contextWindow > 0
					? Math.round(
							((snapshot.contextTokens ?? 0) / snapshot.contextWindow) * 100,
						)
					: 0;
			this.lastUsageSnapshot = snapshot;
			this.events?.onUsage(snapshot);
		} catch {}
	}

	private publishSpeed(speed: {
		now: number | null;
		average: number | null;
	}): void {
		if (this.lastUsageSnapshot === undefined) return;
		const snapshot = {
			...this.lastUsageSnapshot,
			throughputNow: speed.now,
			throughputAverage: speed.average,
		};
		this.lastUsageSnapshot = snapshot;
		this.events?.onUsage(snapshot);
	}

	private setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		this.events?.onBusy(busy);
	}

	private publishQueueState(): void {
		let steering = 0;
		let followUp = 0;
		for (const queued of this.queuedPrompts.values()) {
			if (queued.delivery === "followUp") followUp += 1;
			else steering += 1;
		}
		this.events?.onQueueUpdate?.({ steering, followUp });
	}

	private setPromptPhase(promptId: string, phase: PromptLifecyclePhase): void {
		const current = this.promptPhases.get(promptId);
		if (current === phase) return;
		if (current !== undefined) {
			const currentIndex = PROMPT_LIFECYCLE_ORDER.indexOf(current);
			const nextIndex = PROMPT_LIFECYCLE_ORDER.indexOf(phase);
			if (
				currentIndex >= 0 &&
				nextIndex >= 0 &&
				nextIndex < currentIndex
			)
				return;
			if (current === "completed" || current === "failed" || current === "cancelled")
				return;
		}
		this.promptPhases.set(promptId, phase);
		if (this.promptPhases.size > 512) for (const [id, value] of this.promptPhases) {
			if (['completed', 'failed', 'cancelled'].includes(value)) this.promptPhases.delete(id);
			if (this.promptPhases.size <= 512) break;
		}
		this.events?.onPromptLifecycle?.(promptId, phase);
	}

	private setPromptPhaseForTurn(
		turnId: number,
		phase: "started" | "responding",
	): void {
		for (const promptId of this.promptTurns.get(turnId) ?? [])
			this.setPromptPhase(promptId, phase);
	}

	private consumeQueuedPrompt(promptId: string): void {
		const queued = this.queuedPrompts.get(promptId);
		if (queued === undefined) return;
		this.advanceTurnSegment();
		this.queuedPrompts.delete(promptId);
		queued.phase = "consuming";
		this.setPromptPhase(promptId, "consuming");
		this.publishQueueState();
	}

	private removeQueuedPrompt(promptId: string): void {
		if (!this.queuedPrompts.delete(promptId)) return;
		this.publishQueueState();
	}

	private waitForTurnEnd(turnId: number): Promise<void> {
		return new Promise((resolve) => {
			const waiters = this.turnEndWaiters.get(turnId) ?? new Set<() => void>();
			waiters.add(resolve);
			this.turnEndWaiters.set(turnId, waiters);
			const timer = setTimeout(() => {
				waiters.delete(resolve);
				if (waiters.size === 0) this.turnEndWaiters.delete(turnId);
				resolve();
			}, 2_000);
			timer.unref();
		});
	}

	private resolveTurnEnd(turnId: number): void {
		const waiters = this.turnEndWaiters.get(turnId);
		if (waiters === undefined) return;
		this.turnEndWaiters.delete(turnId);
		for (const resolve of waiters) resolve();
	}

	private applyModel(
		provider: string,
		model: string,
		capabilities: readonly string[],
		displayName?: string,
	): void {
		this.currentProvider = provider;
		this.currentModel = model;
		this.currentModelLabel = formatModelDisplayName(
			provider,
			model,
			displayName,
		);
		this.supportsVision = capabilities.includes("image_in");
	}

	private async normalizeCurrentEffort(
		model: Pick<RuntimeModelOption, "efforts" | "defaultEffort">,
		requested: string | undefined = this.effort,
	): Promise<void> {
		const resolved = resolveCatalogEffort(requested, {
			options: model.efforts,
			defaultEffort: model.defaultEffort ?? model.efforts[0] ?? "off",
		});
		if (requested !== undefined && requested !== resolved) this.events?.onNotice(`原 Effort ${requested} 不受当前模型支持，已采用 ${resolved}；可通过 /effort 重新选择`, "warning");
		if (!this.agent) { this.effort = resolved; return; }
		await this.requireAgent().setThinking(resolved);
		this.effort = normalizeEffortLevel(await this.requireAgent().getThinking(), resolved);
	}

	private clearBindings(): void {
		this.lastRetryKey = undefined;
		this.hydrating = false;
		this.historyRevision = 0;
		this.historyBefore = undefined;
		this.historyEvents = [];
		this.historyEventBytes = 0;
		this.activityRevision++;
		this.modelRevision++;
		for (const controller of this.pendingInteractions.values()) controller.abort();
		this.pendingInteractions.clear();
		if (this.taskPoll !== undefined) clearInterval(this.taskPoll);
		if (this.towerPoll !== undefined) clearInterval(this.towerPoll);
		this.taskPoll = undefined;
		this.towerPoll = undefined;
		for (const subscription of this.subscriptions) subscription.dispose();
		this.subscriptions = [];
		this.childConversationSubscription?.dispose();
		this.childConversationSubscription = undefined;
		for (const pending of this.pendingPrompts.values())
			pending.reject(new Error("Session changed"));
		this.pendingPrompts.clear();
		this.queuedPrompts.clear();
		this.promptPhases.clear();
		this.promptTurns.clear();
		for (const waiters of this.turnEndWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.turnEndWaiters.clear();
		this.streamMessages.clear();
		this.parentTaskSummaries.clear();
		this.taskOutputs.clear();
		this.pendingTodoUpdates.clear();
		this.lastTodoItems = [];
		this.towerPlanActive = false;
		this.toolNames.clear();
		this.cronTasks = [];
		this.runtimeGoalRevision += 1;
		this.outputSpeed.reset();
		this.lastUsageSnapshot = undefined;
		this.cacheTelemetryObserved = false;
		this.tasks.clear();
		this.turn = undefined;
		this.busy = false;
	}

	private requireSession(): SessionHandle {
		if (this.session === undefined) throw new Error("Session is not ready");
		return this.session;
	}

	private requireAgent(): AgentHandle {
		if (this.agent === undefined) throw new Error("Agent is not ready");
		return this.agent;
	}

	private requireChildAgent(
		runId: string,
	): Extract<AgentTaskInfo, { kind: "agent" }> {
		const task = this.tasks.get(runId);
		if (task?.kind !== "agent")
			throw new Error(`Unknown child agent run: ${runId}`);
		return task;
	}
}

function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
	if (seconds < 60) return "刚刚";
	if (seconds < 3_600) return `${String(Math.floor(seconds / 60))} 分钟前`;
	if (seconds < 86_400) return `${String(Math.floor(seconds / 3_600))} 小时前`;
	return `${String(Math.floor(seconds / 86_400))} 天前`;
}

function resolveModelAlias(
	models: readonly { provider: string; model: string }[],
	provider: string,
	id: string,
): string {
	const alias = `${provider}/${id}`;
	if (
		models.some((model) => model.provider === provider && model.model === alias)
	) {
		return alias;
	}
	if (models.some((model) => model.provider === provider && model.model === id))
		return id;
	throw new Error(`模型 ${alias} 不存在`);
}

function displayModelId(provider: string, alias: string): string {
	const prefix = `${provider}/`;
	return alias.startsWith(prefix) ? alias.slice(prefix.length) : alias;
}

function providerModelAvailable(
	availability: ReadonlySet<string>,
	provider: string,
	modelId: string,
): boolean {
	const alias = `${provider}/${modelId}`;
	return (
		availability.has(alias) ||
		(!modelId.includes("/") && availability.has(modelId))
	);
}

const MODEL_WORDS: Readonly<Record<string, string>> = {
	ai: "AI",
	api: "API",
	claude: "Claude",
	codex: "Codex",
	deepseek: "DeepSeek",
	gemini: "Gemini",
	glm: "GLM",
	gpt: "GPT",
	kimi: "Kimi",
	minimax: "MiniMax",
	moonshot: "Moonshot",
	openai: "OpenAI",
	qwen: "Qwen",
};

interface UsageByModelEntry {
	readonly inputOther: number;
	readonly output: number;
	readonly inputCacheRead: number;
	readonly inputCacheCreation: number;
}

export interface UsageCostEstimate {
	readonly costUsd: number | null;
	readonly kind: "complete" | "partial" | "unknown";
}

function usageTokens(usage: UsageByModelEntry): number {
	return (
		usage.inputOther +
		usage.output +
		usage.inputCacheRead +
		usage.inputCacheCreation
	);
}

export function calculateUsageCost(
	byModel: Readonly<Record<string, UsageByModelEntry>> | undefined,
	models: readonly RuntimeModelOption[],
): UsageCostEstimate {
	if (byModel === undefined) return { costUsd: null, kind: "unknown" };
	const entries = Object.entries(byModel);
	if (entries.length === 0) return { costUsd: null, kind: "unknown" };
	const prices = new Map(models.map((model) => [model.alias, model.price]));
	const hasPositiveUsage = entries.some(([, usage]) => usageTokens(usage) > 0);
	let costUsd = 0;
	let pricedModels = 0;
	let missingModels = 0;
	for (const [alias, usage] of entries) {
		if (hasPositiveUsage && usageTokens(usage) <= 0) continue;
		const price = prices.get(alias);
		if (
			price?.inputUsdPerMillion === undefined ||
			price.outputUsdPerMillion === undefined
		) {
			missingModels += 1;
			continue;
		}
		pricedModels += 1;
		costUsd +=
			(usage.inputOther * price.inputUsdPerMillion +
				usage.output * price.outputUsdPerMillion +
				usage.inputCacheRead *
					(price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion) +
				usage.inputCacheCreation *
					(price.cacheWriteUsdPerMillion ?? price.inputUsdPerMillion)) /
			1_000_000;
	}
	if (pricedModels === 0) return { costUsd: null, kind: "unknown" };
	if (missingModels > 0) return { costUsd: null, kind: "partial" };
	return { costUsd, kind: "complete" };
}






function hiddenLegacyProvider(providerId: string): boolean {
	return /^custom-gemini-via-[a-z0-9-]+-[a-f0-9]{8}$/u.test(
		providerId.toLowerCase(),
	);
}



export function formatModelDisplayName(
	provider: string,
	modelId: string,
	displayName?: string,
): string {
	const source = (displayName?.trim() || modelId).replaceAll("_", "-");
	const words = source.split(/[\s-]+/u).filter(Boolean);
	const formatted = words
		.map((word, index) => formatModelWord(word, index))
		.join(" ");
	const kimiK3 =
		/^k3(?:[-_.]|$)/iu.test(modelId) &&
		/(?:^|[-_.])(kimi|moonshot)(?:[-_.]|$)/iu.test(provider);
	return kimiK3 && !/^Kimi\s/iu.test(formatted)
		? `Kimi ${formatted}`
		: formatted;
}

export function formatProviderDisplayName(providerId: string): string {
	const normalized = providerId.toLowerCase();
	const known: Readonly<Record<string, string>> = {
		anthropic: "Anthropic",
		deepseek: "DeepSeek",
		"kimi-coding": "Kimi Coding",
		"minimax-cn": "MiniMax CN",
		moonshotai: "Moonshot AI",
		"moonshotai-cn": "Moonshot AI CN",
		"opencode-go": "OpenCode Go",
		openai: "OpenAI",
		vsplab: "VSPLab",
		"xiaomi-token-plan-cn": "Xiaomi Token Plan CN",
		"zai-coding-cn": "ZAI Coding CN",
	};
	const exact = known[normalized];
	if (exact !== undefined) return exact;
	const clean = normalized
		.replace(/^custom-/u, "")
		.replace(/-[a-f0-9]{8}$/u, "");
	return clean
		.split(/[-_.]+/u)
		.filter(Boolean)
		.map((word, index) => formatModelWord(word, index))
		.join(" ");
}

function formatModelWord(word: string, index: number): string {
	const canonical = MODEL_WORDS[word.toLowerCase()];
	if (canonical !== undefined) return canonical;
	if (/^[a-z]\.[a-z](?:\.[a-z])*$/u.test(word)) return word;
	if (/^k\d+(?:\.\d+)?$/iu.test(word)) return word.toUpperCase();
	if (/^v\d+(?:\.\d+)?$/iu.test(word)) return `V${word.slice(1)}`;
	if (/^\d+k$/iu.test(word)) return `${word.slice(0, -1)}K`;
	if (index === 0 && /^[a-z]{2,4}$/u.test(word)) return word.toUpperCase();
	return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function summarizeArgs(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	)
		return String(value);
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	for (const key of ["description", "command", "path", "query", "prompt"]) {
		if (typeof record[key] === "string") return record[key];
	}
	return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

const MAX_CRON_FIELD_LENGTH = 512;
const MAX_CRON_PROMPT_LENGTH = 8_192;

export function projectCronSessionMessage(
	id: string,
	text: string,
	origin?: Record<string, unknown>,
): SessionMarkerMessage | undefined {
	const xml = parseCronEnvelope(text);
	const isCronOrigin = origin?.["kind"] === "cron_job";
	if (origin !== undefined && !isCronOrigin) return undefined;
	if (!isCronOrigin && xml === undefined) return undefined;
	const source = { ...xml?.attributes, ...origin };
	const jobId = boundedString(source["jobId"] ?? source["job_id"]);
	if (jobId === undefined) return undefined;
	const prompt = xml?.prompt ?? boundedPrompt(text);
	if (prompt.length === 0) return undefined;
	const cron = boundedString(source["cron"]);
	const runAt = boundedString(source["runAt"] ?? source["run_at"]);
	const recurring = booleanValue(source["recurring"]);
	const coalescedCount = positiveInteger(source["coalescedCount"] ?? source["coalesced_count"]);
	const stale = booleanValue(source["stale"]);
	const presentation: CronSessionPresentation = {
		kind: "cron",
		jobId,
		cron,
		runAt,
		recurring,
		coalescedCount,
		stale,
		prompt,
	};
	return { id, role: "assistant", kind: "session", text: prompt, presentation };
}

function parseCronEnvelope(
	text: string,
): { attributes: Record<string, string>; prompt: string } | undefined {
	const match = /^\s*<cron-fire\s+([^>]*?)>\n<prompt>\n([\s\S]*)\n<\/prompt>\n<\/cron-fire>\s*$/u.exec(text);
	if (match === null) return undefined;
	const attributes: Record<string, string> = {};
	for (const item of match[1]?.matchAll(/([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/gu) ?? []) {
		const key = item[1];
		const value = item[2];
		if (key !== undefined && value !== undefined)
			attributes[key] = decodeXmlEntities(value).slice(0, MAX_CRON_FIELD_LENGTH);
	}
	const prompt = boundedPrompt(match[2] ?? "");
	return prompt.length === 0 ? undefined : { attributes, prompt };
}

function decodeXmlEntities(value: string): string {
	return value.replaceAll(
		/&(?:amp|quot|apos|lt|gt|#x[0-9a-f]+|#\d+);/giu,
		(entity) => {
			if (entity === "&amp;") return "&";
			if (entity === "&quot;") return '"';
			if (entity === "&apos;") return "'";
			if (entity === "&lt;") return "<";
			if (entity === "&gt;") return ">";
			const code = entity.startsWith("&#x")
				? Number.parseInt(entity.slice(3, -1), 16)
				: Number.parseInt(entity.slice(2, -1), 10);
			return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: entity;
		},
	);
}

function boundedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = decodeXmlEntities(value).trim();
	return result.length === 0 ? undefined : result.slice(0, MAX_CRON_FIELD_LENGTH);
}

function boundedPrompt(value: string): string {
	return value.length <= MAX_CRON_PROMPT_LENGTH
		? value
		: `${value.slice(0, MAX_CRON_PROMPT_LENGTH - 1)}…`;
}

function booleanValue(value: unknown): boolean {
	return value === true || value === "true";
}

function positiveInteger(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function contentText(content: readonly unknown[]): string {
	return content
		.map(record)
		.filter(
			(part) => part["type"] === "text" && typeof part["text"] === "string",
		)
		.map((part) => part["text"] as string)
		.join("\n\n")
		.trim();
}

function contentThinking(content: readonly unknown[]): string {
	return content
		.map(record)
		.filter(
			(part) => part["type"] === "think" && typeof part["think"] === "string",
		)
		.map((part) => part["think"] as string)
		.join("\n\n")
		.trim();
}

function summarizeOutput(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function projectAgentConversation(
	runId: string,
	agentId: string,
	history: readonly unknown[],
	tokenCount: number,
	options: { cursor?: string; limit?: number; active?: boolean } = {},
): AgentConversationPage {
	const rawBlocks = history.flatMap((message, index) =>
		projectConversationMessage(message, index, !options.active && index === history.length - 1),
	);
	const toolCalls = new Map(
		rawBlocks.flatMap((block) =>
			block.kind === "tool" && block.toolCallId !== undefined
				? [[block.toolCallId, block] as const]
				: [],
		),
	);
	const blocks = rawBlocks.flatMap((block) =>
		projectCompactConversationBlock(block, toolCalls),
	);
	const limit = Math.min(200, Math.max(1, options.limit ?? 100));
	const requestedEnd = parseConversationCursor(options.cursor);
	const end = Math.min(blocks.length, requestedEnd ?? blocks.length);
	const start = Math.max(0, end - limit);
	return {
		runId,
		agentId,
		blocks: blocks.slice(start, end),
		nextCursor: start > 0 ? String(start) : undefined,
		tokenCount,
		totalBlocks: blocks.length,
	};
}

function projectConversationMessage(
	value: unknown,
	index: number,
	terminal: boolean,
): AgentConversationBlock[] {
	const message = record(value);
	const role = conversationRole(message["role"]);
	if (role === undefined) return [];
	const originRecord = record(message["origin"]);
	const origin =
		typeof originRecord["kind"] === "string" ? originRecord["kind"] : undefined;
	const injected = role === "system" || (role === "user" && origin !== "user");
	const baseId =
		typeof message["id"] === "string"
			? message["id"]
			: `context:${String(index)}`;
	const content = Array.isArray(message["content"]) ? message["content"] : [];
	const toolCalls = Array.isArray(message["toolCalls"])
		? message["toolCalls"]
		: [];
	const partial =
		message["partial"] === true ||
		message["isPartial"] === true ||
		message["status"] === "streaming";
	const result: AgentConversationBlock[] = [];
	for (const [partIndex, rawPart] of content.entries()) {
		const part = record(rawPart);
		if (part["type"] === "think" && typeof part["think"] === "string") {
			result.push({
				id: `${baseId}:thinking:${String(partIndex)}`,
				kind: "thinking",
				sourceRole: role,
				text: part["think"],
				injected,
				origin,
			});
		} else if (part["type"] === "text" && typeof part["text"] === "string") {
			result.push({
				id: `${baseId}:text:${String(partIndex)}`,
				kind:
					message["isError"] === true
						? "error"
						: role === "tool"
							? "tool"
							: role === "assistant" && terminal && !partial && toolCalls.length === 0
								? "final"
								: "commentary",
				sourceRole: role,
				text: part["text"],
				injected,
				origin,
				toolCallId:
					typeof message["toolCallId"] === "string"
						? message["toolCallId"]
						: undefined,
				isError: message["isError"] === true,
			});
		}
	}
	for (const [toolIndex, rawTool] of toolCalls.entries()) {
		const tool = record(rawTool);
		if (typeof tool["id"] !== "string") continue;
		result.push({
			id: `${baseId}:tool:${String(toolIndex)}`,
			kind: "tool",
			sourceRole: role,
			text: typeof tool["name"] === "string" ? tool["name"] : "Tool call",
			injected,
			origin,
			toolCallId: tool["id"],
			toolName: typeof tool["name"] === "string" ? tool["name"] : undefined,
			toolArguments:
				typeof tool["arguments"] === "string" || tool["arguments"] === null
					? tool["arguments"]
					: undefined,
		});
	}
	return result;
}

function isMutationTool(toolName: string | undefined): boolean {
	if (toolName === undefined) return false;
	const normalized = toolName.toLowerCase().replaceAll(/[^a-z]/g, "");
	return (
		normalized === "edit" ||
		normalized === "write" ||
		normalized === "patch" ||
		normalized === "applypatch"
	);
}

function projectCompactConversationBlock(
	block: AgentConversationBlock,
	toolCalls: ReadonlyMap<string, AgentConversationBlock>,
): AgentConversationBlock[] {
	const text = block.text.trim();
	if (block.isError === true) {
		const toolCall =
			block.toolCallId === undefined ? undefined : toolCalls.get(block.toolCallId);
		return text.length === 0
			? []
			: [
					{
						...block,
						kind: "error",
						toolName: toolCall?.toolName,
						text: compactConversationText(text),
						presentation: "error",
					},
				];
	}
	if (block.sourceRole === "tool") return [];
	if (block.kind === "tool" && isMutationTool(block.toolName)) {
		const path = mutationPath(block.toolArguments);
		return [
			{
				...block,
				text: path === undefined ? "Modified files" : `Modified ${path}`,
				presentation: "change",
			},
		];
	}
	if (block.kind === "tool") {
		return [{ ...block, text: compactConversationText(text), presentation: "message" }];
	}
	if (block.injected || text.length === 0) return [];
	return [{ ...block, text, presentation: "message" }];
}

function mutationPath(
	argumentsJson: string | null | undefined,
): string | undefined {
	if (typeof argumentsJson !== "string") return undefined;
	const args = parseJsonRecord(argumentsJson);
	for (const key of ["path", "file_path", "filePath"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0)
			return value.trim();
	}
	return undefined;
}

function compactConversationText(text: string): string {
	const limit = 400;
	return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function conversationRole(
	value: unknown,
): AgentConversationBlock["sourceRole"] | undefined {
	return value === "system" ||
		value === "user" ||
		value === "assistant" ||
		value === "tool"
		? value
		: undefined;
}

function parseConversationCursor(
	cursor: string | undefined,
): number | undefined {
	if (cursor === undefined) return undefined;
	const parsed = Number(cursor);
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new Error("Invalid conversation cursor");
	return parsed;
}

export function projectTodoPlanItems(value: unknown): PlanItem[] | undefined {
	const args =
		typeof value === "string" ? parseJsonRecord(value) : record(value);
	if (!Array.isArray(args["todos"])) return undefined;
	return args["todos"].flatMap((rawTodo, rootIndex): PlanItem[] => {
		const todo = record(rawTodo);
		const title = typeof todo["title"] === "string" ? todo["title"].trim() : "";
		if (title.length === 0) return [];
		if (!Array.isArray(todo["children"])) {
			const status = todoStatus(todo["status"]);
			if (status === undefined) return [];
			return [
				{
					id: `todo:${String(rootIndex)}`,
					label: title,
					status,
					depth: 0,
					focused: status === "in_progress",
				},
			];
		}
		const children = todo["children"].flatMap(
			(rawChild, childIndex): PlanItem[] => {
				const child = record(rawChild);
				const childTitle =
					typeof child["title"] === "string" ? child["title"].trim() : "";
				const status = todoStatus(child["status"]);
				if (childTitle.length === 0 || status === undefined) return [];
				return [
					{
						id: `todo:${String(rootIndex)}:${String(childIndex)}`,
						label: childTitle,
						status,
						depth: 1,
						focused: status === "in_progress",
					},
				];
			},
		);
		if (children.length === 0) return [];
		return [
			{
				id: `todo:${String(rootIndex)}`,
				label: title,
				status: derivedTodoGroupStatus(children),
				depth: 0,
				group: true,
			},
			...children,
		];
	});
}

export function projectTowerMissionPlanItems(
	missions: readonly TowerMissionProjection[],
): PlanItem[] {
	const missionStatus = (status: TowerMissionProjection["status"]): PlanItem["status"] =>
		status === "completed" || status === "merged" || status === "abandoned"
			? "done"
			: status === "blocked"
				? "blocked"
				: status === "active"
					? "in_progress"
					: "pending";
	return missions.flatMap((mission) => {
		const towerStatus = mission.status;
		const status = missionStatus(towerStatus);
		const worker = mission.workers.map((item) => item.name).join(", ");
		const detail = [
			mission.kind === "survey" ? "survey" : undefined,
			mission.owner === undefined ? undefined : `owner: ${mission.owner}`,
			worker.length === 0 ? undefined : `worker: ${worker}`,
			mission.scope.length === 0 ? undefined : `scope: ${mission.scope.join(", ")}`,
			mission.deps.length === 0 ? undefined : `deps: ${mission.deps.join(", ")}`,
		].filter((item): item is string => item !== undefined).join(" · ");
		const label = detail.length === 0 ? `${mission.id} ${mission.title}` : `${mission.id} ${mission.title} · ${detail}`;
		const taskItems = mission.tasks.map((task, index) => ({
			id: `tower:${mission.id}:task:${String(index)}`,
			label: task.text,
			status: task.done ? "done" : towerStatus === "blocked" ? "blocked" : towerStatus === "active" ? "in_progress" : "pending",
			depth: 1,
			focused: !task.done && towerStatus === "active",
			...(towerStatus === "blocked" && mission.blockers[0] !== undefined ? { blocker: mission.blockers[0] } : {}),
		} satisfies PlanItem));
		return [{
			id: `tower:${mission.id}`,
			label,
			status,
			depth: 0,
			group: taskItems.length > 0,
			focused: status === "in_progress",
			...(status === "blocked" && mission.blockers[0] !== undefined ? { blocker: mission.blockers.join("; ") } : {}),
		}, ...taskItems];
	});
}

export function serializeQuestionAnswer(
	options: readonly { label: string }[],
	answer: string | string[] | undefined,
): string | undefined {
	const labels = new Map(
		options.map((option, index) => [String(index), option.label]),
	);
	if (Array.isArray(answer))
		return answer.map((value) => labels.get(value) ?? value).join(", ");
	return typeof answer === "string"
		? (labels.get(answer) ?? answer)
		: undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> {
	try {
		return record(JSON.parse(value));
	} catch {
		return {};
	}
}

function todoStatus(value: unknown): PlanItem["status"] | undefined {
	return value === "pending" || value === "in_progress" || value === "done"
		? value
		: undefined;
}

function derivedTodoGroupStatus(
	children: readonly PlanItem[],
): PlanItem["status"] {
	if (children.every((child) => child.status === "done")) return "done";
	if (children.every((child) => child.status === "pending")) return "pending";
	return "in_progress";
}

export function calculateCacheHitPercent(
	usage:
		| {
				inputOther: number;
				inputCacheRead: number;
				inputCacheCreation: number;
		  }
		| undefined,
): number | null {
	if (usage === undefined) return null;
	const promptTokens =
		usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
	return promptTokens > 0
		? Math.round((usage.inputCacheRead / promptTokens) * 100)
		: null;
}

export function reconcileTaskSnapshot(
	previous: ReadonlyMap<string, AgentTaskInfo>,
	tasks: readonly AgentTaskInfo[],
	now: number,
): Map<string, AgentTaskInfo> {
	const current = new Map(tasks.map((task) => [task.taskId, task]));
	for (const task of previous.values()) {
		if (current.has(task.taskId)) continue;
		if (task.status !== "running") {
			current.set(task.taskId, task);
		} else if (task.kind === "agent") {
			current.set(task.taskId, { ...task, status: "lost", endedAt: now });
		}
	}
	const finished = [...current.values()].filter(task => task.status !== 'running')
		.toSorted((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	for (const task of finished.slice(100)) current.delete(task.taskId);
	return current;
}

function taskStatus(
	status: AgentTaskInfo["status"],
): AgentSnapshot["active"][number]["status"] {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	return status;
}

export function turnState(turnId: number, segment: number): TurnState {
	const suffix = segment === 0 ? "" : `:${String(segment)}`;
	return {
		id: turnId,
		segment,
		assistantId: `assistant:${String(turnId)}${suffix}`,
		thinkingId: `thinking:${String(turnId)}${suffix}`,
	};
}

function cronExpressionFor(runAt: number): string {
	const date = new Date(runAt);
	return `${String(date.getMinutes())} ${String(date.getHours())} ${String(date.getDate())} ${String(date.getMonth() + 1)} *`;
}

function toCronTask(task: AgentCronTask): CronTask {
	return {
		id: task.id,
		cron: task.cron,
		prompt: task.prompt,
		recurring: task.recurring !== false,
		createdAt: task.createdAt,
		lastFiredAt: task.lastFiredAt,
	};
}

function toTaskDashboardItem(
	task: AgentTaskInfo,
	outputPreview?: string,
): TaskDashboardItem {
	const base = {
		taskId: task.taskId,
		description: task.description,
		status: task.status,
		detached: task.detached,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		stopReason: task.stopReason,
		timeoutMs: task.timeoutMs,
	};
	if (task.kind === "agent") {
		return {
			...base,
			kind: "agent",
			agentId: task.agentId,
			subagentType: task.subagentType,
			parentToolCallId: task.parentToolCallId,
			model: task.model,
			thinkingEffort: task.thinkingEffort,
			codename: task.codename,
			taskTitle: task.taskTitle,
			outputPreview,
		};
	}
	if (task.kind === "process") {
		return {
			...base,
			kind: "process",
			command: task.command,
			pid: task.pid,
			exitCode: task.exitCode,
		};
	}
	return {
		...base,
		kind: "question",
		questionCount: task.questionCount,
		toolCallId: task.toolCallId,
	};
}

function parentTaskSummary(
	tasks: readonly Extract<AgentTaskInfo, { kind: "agent" }>[],
): string {
	const completed = tasks.filter((task) => task.status === "completed").length;
	const running = tasks.filter((task) => task.status === "running").length;
	const interrupted = tasks.length - completed - running;
	const parts = [`${String(completed)}/${String(tasks.length)} completed`];
	if (running > 0) parts.push(`${String(running)} running`);
	if (interrupted > 0) parts.push(`${String(interrupted)} interrupted`);
	return `Agents · ${parts.join(" · ")}`;
}

function toAgentRunSnapshot(
	task: Extract<AgentTaskInfo, { kind: "agent" }>,
	outputPreview?: string,
) {
	const status = taskStatus(task.status);
	return {
		id: task.taskId,
		agentId: task.agentId ?? task.taskId,
		parentToolCallId: task.parentToolCallId,
		treeId: task.taskId,
		kind: "task" as const,
		depth: 1,
		model: task.model ?? "inherit",
		provider: "",
		role: "worker" as const,
		profile: task.subagentType ?? "coder",
		codename: task.codename,
		taskTitle: task.taskTitle,
		modelReason: "Subagent model pool",
		effort: normalizeEffortLevel(task.thinkingEffort),
		contextMode: "isolated" as const,
		contextChars: 0,
		task: task.description,
		outputPreview,
		summary: task.status === "completed" ? outputPreview : undefined,
		error: task.status === "failed" ? task.stopReason : undefined,
		tools: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		},
		budget: {
			runTokensUsed: 0,
			maxRunTokens: 0,
			treeTokensUsed: 0,
			maxTreeTokens: 0,
			treeCostUsd: 0,
			maxTreeCostUsd: 0,
			maxRunSeconds: (task.timeoutMs ?? 0) / 1000,
			warnRunTokens: false,
			warnTreeTokens: false,
			warnTreeCost: false,
			warnElapsed: false,
		},
		timeline: [],
		status,
		background: task.detached ?? false,
		resumed: false,
		startedAt: new Date(task.startedAt).toISOString(),
		finishedAt:
			task.endedAt === null ? undefined : new Date(task.endedAt).toISOString(),
	};
}

function toApprovalRequest(toolName: string, action: string): ApprovalRequest {
	const kind =
		toolName === "Bash"
			? "process"
			: toolName === "Write" || toolName === "Edit"
				? "file-write"
				: "shared";
	const category =
		kind === "process"
			? "process"
			: kind === "file-write"
				? "file-write"
				: "shared";
	return {
		action: { kind, target: action, operation: toolName },
		category,
		policy: "Standard",
	};
}

function fromApprovalResponse(response: ApprovalResponse) {
	if (response.type === "allow-session")
		return { decision: "approved" as const, scope: "session" as const };
	if (response.type === "allow-once" || response.type === "elevate")
		return { decision: "approved" as const };
	return { decision: "rejected" as const, feedback: response.reason };
}
