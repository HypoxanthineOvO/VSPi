import { randomUUID } from "node:crypto";
import type {
	AgentCronTask,
	AgentHandle,
	AgentTaskInfo,
	IDisposable,
	QuestionRequest,
	SessionHandle,
	SessionMeta,
} from "@moonshot-ai/klient";
import type { RuntimeConnection } from "@vsp/vsp-runtime";

import type { AgentSnapshot } from "../agents/types.js";
import type { CompactOptions } from "../continuity/compaction-profiles.js";
import type { CronTask } from "../cron/types.js";
import { DEFAULT_USAGE } from "../domain/defaults.js";
import {
	catalogEffortCapability,
	normalizeEffortLevel,
	resolveCatalogEffort,
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

export class KlientChatBackend implements ChatBackend {
	readonly kind = "runtime" as const;
	supportsVision = false;
	private events: ChatBackendEvents | undefined;
	private session: SessionHandle | undefined;
	private agent: AgentHandle | undefined;
	private meta: SessionMeta | undefined;
	private subscriptions: IDisposable[] = [];
	private globalSubscriptions: IDisposable[] = [];
	private childConversationSubscription: BackendSubscription | undefined;
	private turn: TurnState | undefined;
	private pendingPrompts = new Map<string, PendingPrompt>();
	private queuedPrompts = new Map<string, QueuedPrompt>();
	private promptPhases = new Map<string, PromptLifecyclePhase>();
	private promptTurns = new Map<number, Set<string>>();
	private turnEndWaiters = new Map<number, Set<() => void>>();
	private tasks = new Map<string, AgentTaskInfo>();
	private taskOutputs = new Map<string, string>();
	private parentTaskSummaries = new Map<string, string>();
	private pendingTodoUpdates = new Map<string, PlanItem[]>();
	private toolNames = new Map<string, string>();
	private cronTasks: CronTask[] = [];
	private runtimeGoalRevision = 0;
	private taskPoll: NodeJS.Timeout | undefined;
	private busy = false;
	private readonly outputSpeed = new OutputSpeedTracker();
	private lastUsageSnapshot: UsageSnapshot | undefined;
	private cacheTelemetryObserved = false;
	private effort: EffortLevel = "medium";
	private currentModel = "";
	private currentModelLabel = "";
	private currentProvider = "";
	private providerAvailability = new Map<string, ProviderAvailability>();
	private modelOptionsPromise: Promise<RuntimeModelOption[]> | undefined;

	constructor(
		private readonly connection: RuntimeConnection,
		private readonly cwd: string,
		private readonly startupMode: SessionStartupMode,
	) {}

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
		const workspace =
			await this.connection.klient.global.workspaces.createOrTouch({
				root: this.cwd,
			});
		if (this.startupMode === "resume") return;
		let meta: SessionMeta | undefined;
		if (this.startupMode === "continue") {
			const page = await this.connection.klient.global.sessions.list({
				workspaceIds: [workspace.id],
				limit: 1,
			});
			const latest = page.items[0];
			if (latest !== undefined) {
				const existing = this.connection.klient.session(latest.id);
				await existing.restore();
				meta = await existing.get();
			}
		}
		meta ??= await this.connection.klient.global.sessions.create({
			workDir: this.cwd,
		});
		await this.bindSession(meta, "startup");
		events.onSessionReady?.();
	}

	async send(text: string, options: SendOptions): Promise<SendResult> {
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
					await agent.prompt({ input: [{ type: "text", text }], promptId });
				} else {
					await agent.steer({ input: [{ type: "text", text }], promptId });
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
		try {
			await agent.prompt({ input: [{ type: "text", text }], promptId });
		} catch (error) {
			this.pendingPrompts.delete(promptId);
			throw error;
		}
		return completion;
	}

	async cancel(): Promise<CancelResult> {
		const agent = this.agent;
		if (agent === undefined) return { queuedMessages: [] };
		const queuedMessages = [...this.queuedPrompts.values()].map(
			(item) => item.text,
		);
		const turnId = this.turn?.id;
		const ended =
			turnId === undefined ? undefined : this.waitForTurnEnd(turnId);
		await agent.cancelCompaction();
		await agent.cancel({ turnId });
		if (ended !== undefined) await ended;
		this.queuedPrompts.clear();
		this.publishQueueState();
		return { queuedMessages };
	}

	compact(options?: CompactOptions): Promise<boolean> {
		return this.requireAgent().compact({
			instruction: options?.customInstructions,
		});
	}

	async newSession(): Promise<void> {
		const meta = await this.connection.klient.global.sessions.create({
			workDir: this.cwd,
		});
		await this.bindSession(meta, "new");
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
		const [models, providers, pricingCatalog] = await Promise.all([
			this.connection.klient.global.kosong.listModels(),
			this.connection.klient.global.kosong.listProviders(),
			loadModelsDevPricingCatalog(),
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
				provider: model.provider,
				alias: model.model,
				brand: formatProviderDisplayName(model.provider),
				label: formatModelDisplayName(
					model.provider,
					displayModelId(model.provider, model.model),
					model.display_name,
				),
				vision: model.capabilities?.includes("image_in") ?? false,
				efforts: catalogEffortCapability(model.thinking, {
					identity: model.provider,
					type: providerTypes.get(model.provider),
				}).options,
				effortMutable: catalogEffortCapability(model.thinking, {
					identity: model.provider,
					type: providerTypes.get(model.provider),
				}).mutable,
				defaultEffort: catalogEffortCapability(model.thinking, {
					identity: model.provider,
					type: providerTypes.get(model.provider),
				}).defaultEffort,
				price:
					model.provider === "vsplab" || model.pricing === undefined
						? resolveModelsDevPricing(
								pricingCatalog,
								model.provider,
								displayModelId(model.provider, model.model),
							)
						: {
								inputUsdPerMillion: model.pricing.input_usd_per_million,
								outputUsdPerMillion: model.pricing.output_usd_per_million,
								cacheReadUsdPerMillion:
									model.pricing.cache_read_usd_per_million,
								cacheWriteUsdPerMillion:
									model.pricing.cache_write_usd_per_million,
								source: "provider" as const,
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

	async getProviderOptions(): Promise<ProviderOption[]> {
		const providers =
			await this.connection.klient.global.kosong.listProviders();
		return providers
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
				authMethods: [{ type: "api_key", label: "API Key" }],
				storedCredential: provider.has_api_key ? "api_key" : undefined,
			}));
	}

	async selectModel(
		provider: string,
		id: string,
	): Promise<ModelSelectionResult> {
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
		const selected =
			await this.connection.klient.global.kosong.setDefaultModel(alias);
		await this.requireAgent().setModel(alias);
		this.applyModel(
			selected.model.provider,
			displayModelId(selected.model.provider, selected.model.model),
			selected.model.capabilities ?? [],
			selected.model.display_name,
		);
		const effort = catalogEffortCapability(selected.model.thinking, {
			identity: selected.model.provider,
			type: selectedProvider.type,
		});
		await this.normalizeCurrentEffort({
			efforts: effort.options,
			defaultEffort: effort.defaultEffort,
		});
		return {
			modelId: id,
			vision: this.supportsVision,
			contextWindow: selected.model.max_context_size,
			profileModelId: id,
			effort: this.effort,
		};
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
			if (provider === undefined)
				throw new Error(`Provider ${providerId} 不存在`);
			providers[providerId] = { ...provider, apiKey };
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
		const started =
			await this.connection.klient.global.auth.startLogin(providerId);
		if (started.status === "authenticated") {
			interaction.notify({ type: "info", message: "Provider 已登录" });
			return;
		}
		interaction.notify({
			type: "device_code",
			verificationUri: started.verification_uri_complete,
			userCode: started.user_code,
		});
		while (!interaction.signal?.aborted) {
			await delay(Math.max(500, started.interval * 1_000));
			const flow = await this.connection.klient.global.auth.flow(providerId);
			if (flow?.status === "authenticated") return;
			if (flow !== undefined && flow.status !== "pending") {
				throw new Error(flow.error_message ?? `OAuth ${flow.status}`);
			}
		}
		await this.connection.klient.global.auth.cancelLogin(providerId);
		throw new Error("Login cancelled");
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

	async setEffort(level: EffortLevel): Promise<void> {
		await this.requireAgent().setThinking(level);
		this.effort = level;
	}

	async setPolicy(policy: PolicyLevel): Promise<PolicySnapshot> {
		const mode =
			policy === "Auto" ? "auto" : policy === "YOLO" ? "yolo" : "manual";
		await this.requireAgent().setPermission(mode);
		return {
			policy,
			boundary: "Host",
			sandboxed: false,
			recovery: false,
			sessionAllowlist: [],
		};
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
			(task) => task.status === "running" && task.detached !== true,
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
				maxRunSeconds: 7_200,
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
		const context = await this.requireSession().agent(agentId).getContext();
		return projectAgentConversation(
			runId,
			agentId,
			context.history,
			context.tokenCount,
			options,
		);
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
		this.clearBindings();
		for (const subscription of this.globalSubscriptions) subscription.dispose();
		this.globalSubscriptions = [];
	}

	private async bindSession(
		meta: SessionMeta,
		reason: "startup" | "new" | "resume" | "fork",
	): Promise<void> {
		this.clearBindings();
		this.meta = meta;
		this.session = this.connection.klient.session(meta.id);
		this.agent = this.session.agent("main");
		const thinking = await this.connection.klient.global.config.get<
			{ effort?: string } | undefined
		>("thinking");
		const defaultModel = await this.connection.klient.global.config.get<
			string | undefined
		>("defaultModel");
		if (defaultModel !== undefined) {
			const resolvedDefaultModel =
				await this.resolveAvailableDefaultModel(defaultModel);
			const selected =
				await this.connection.klient.global.kosong.setDefaultModel(
					resolvedDefaultModel,
				);
			await this.agent.setModel(resolvedDefaultModel);
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
		this.subscribe();
		this.events?.onSessionReset?.({ id: meta.id, reason, effort: this.effort });
		await this.publishRuntimeGoalStatus();
		await this.publishHistory();
		this.taskPoll = setInterval(() => void this.refreshTasks(), 1_000);
		this.taskPoll.unref();
		await this.refreshTasks();
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
			this.connection.klient.events.on("kosong.providers.changed", changed),
			this.connection.klient.events.on("kosong.models.changed", changed),
		);
	}

	private subscribe(): void {
		const agent = this.requireAgent();
		const session = this.requireSession();
		this.subscriptions.push(
			agent.events.on("turn.started", (event) => {
				this.outputSpeed.reset();
				this.turn = turnState(event.turnId, 0);
				if (event.promptId !== undefined) {
					this.promptTurns.set(event.turnId, new Set([event.promptId]));
					this.setPromptPhase(event.promptId, "started");
				}
				this.setBusy(true);
			}),
			agent.events.on("assistant.delta", (event) => {
				this.setPromptPhaseForTurn(event.turnId, "responding");
				this.publishSpeed(this.outputSpeed.recordDelta(event.delta));
				const id = this.turn?.assistantId ?? `assistant:${event.turnId}`;
				this.appendStream(id, event.delta, "text");
			}),
			agent.events.on("thinking.delta", (event) => {
				this.setPromptPhaseForTurn(event.turnId, "responding");
				const id = this.turn?.thinkingId ?? `thinking:${event.turnId}`;
				this.appendStream(id, event.delta, "thinking");
			}),
			agent.events.on("turn.step.started", (event) => {
				this.setPromptPhaseForTurn(event.turnId, "started");
			}),
			agent.events.on("tool.call.started", (event) => {
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
			agent.events.on("tool.result", (event) => {
				const toolName = this.toolNames.get(event.toolCallId);
				this.toolNames.delete(event.toolCallId);
				const todoItems = this.pendingTodoUpdates.get(event.toolCallId);
				this.pendingTodoUpdates.delete(event.toolCallId);
				if (!event.isError && todoItems !== undefined)
					this.events?.onPlanItems?.(todoItems);
				this.events?.onMessageUpdate(event.toolCallId, {
					status: event.isError ? "error" : "success",
					output: summarizeOutput(event.output),
				});
				if (toolName === "CronCreate" || toolName === "CronDelete")
					void this.publishCronTasks();
				void this.refreshTasks();
			}),
			agent.events.on("turn.ended", (event) => {
				this.finishTurnSegment();
				this.turn = undefined;
				this.setBusy(false);
				this.resolveTurnEnd(event.turnId);
				if (event.reason !== "completed") {
					this.events?.onNotice(
						`Turn ${event.reason}`,
						event.reason === "cancelled" ? "warning" : "error",
					);
				}
				void this.publishUsage(true);
			}),
			agent.events.on("prompt.completed", (event) => {
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
			agent.events.on("prompt.aborted", (event) => {
				this.removeQueuedPrompt(event.promptId);
				this.setPromptPhase(event.promptId, "cancelled");
				const pending = this.pendingPrompts.get(event.promptId);
				this.pendingPrompts.delete(event.promptId);
				pending?.resolve({ status: "cancelled" });
			}),
			agent.events.on("prompt.submitted", (event) => {
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
			}),
			agent.events.on("prompt.queued", (event) => {
				if (this.queuedPrompts.has(event.promptId))
					this.setPromptPhase(event.promptId, "queued");
				this.publishQueueState();
			}),
			agent.events.on("prompt.steered", (event) => {
				const turnPrompts =
					this.promptTurns.get(this.turn?.id ?? -1) ?? new Set<string>();
					for (const promptId of event.promptIds) {
						this.consumeQueuedPrompt(promptId);
						turnPrompts.add(promptId);
					}
					if (this.turn !== undefined)
						this.promptTurns.set(this.turn.id, turnPrompts);
			}),
			agent.events.on("goal.updated", (event) => {
				this.setRuntimeGoalStatus(event.snapshot?.status, true);
			}),
			agent.events.on("compaction.started", (event) => {
				this.events?.onCompactionActivity?.({
					type: "started",
					trigger: event.trigger,
					startedAt: event.time ?? Date.now(),
				});
			}),
			agent.events.on("compaction.blocked", (event) => {
				this.events?.onCompactionActivity?.({
					type: "blocked",
					turnId: event.turnId,
				});
			}),
			agent.events.on("compaction.completed", (event) => {
				this.events?.onCompactionActivity?.({
					type: "completed",
					result: event.result,
				});
				void this.publishUsage();
			}),
			agent.events.on("compaction.cancelled", () => {
				this.events?.onCompactionActivity?.({ type: "cancelled" });
			}),
			agent.events.on("error", (event) => {
				if (event.code === "compaction.failed")
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
			agent.events.onError((error) => this.events?.onSessionError?.(error)),
			session.events.onError((error) => this.events?.onSessionError?.(error)),
		);
	}

	private async publishHistory(): Promise<void> {
		let context: Awaited<ReturnType<AgentHandle["getContext"]>>;
		try {
			context = await this.requireAgent().getContext();
		} catch {
			return;
		}
		const toolNames = new Map<string, string>();
		const todoUpdates = new Map<string, PlanItem[]>();
		let latestTodoItems: PlanItem[] | undefined;
		for (const [index, raw] of context.history.entries()) {
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
					this.events?.onMessage({
						id: messageId,
						role: "user",
						kind: "text",
						text,
					});
				} else if (
					origin["kind"] === "task" &&
					text.length > 0
				) {
					this.events?.onMessage({
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
					this.events?.onMessage({
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
					this.events?.onMessage({
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
					this.events?.onMessage({
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
				this.events?.onMessageUpdate(toolCallId, {
					name: toolNames.get(toolCallId) ?? "Tool",
					status: message["isError"] === true ? "error" : "success",
					output: contentText(content),
				});
			}
		}
		if (latestTodoItems !== undefined)
			this.events?.onPlanItems?.(latestTodoItems);
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
							effort: this.effort,
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
		this.turn = turnState(turn.id, turn.segment + 1);
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
		const questions = await session.questions.list();
		for (const request of questions) await this.answerQuestion(request);
		const approvals = await session.approvals.list();
		for (const request of approvals) {
			if (request.id === undefined) continue;
			const response = await this.events?.onHandoffInteraction?.({
				kind: "approval",
				request: toApprovalRequest(request.toolName, request.action),
			});
			if (response?.kind !== "approval") continue;
			await session.approvals.decide(
				request.id,
				fromApprovalResponse(response.response),
			);
		}
	}

	private refreshInteractions(): void {
		void this.processInteractions().catch((error: unknown) => {
			this.events?.onSessionError?.(
				error instanceof Error ? error : new Error(String(error)),
			);
		});
	}

	private async answerQuestion(request: QuestionRequest): Promise<void> {
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
		const answered = await this.events.onQuestion(questions);
		const result: Record<string, string | true> = {};
		for (const [index, question] of request.questions.entries()) {
			const answer = answered[index]?.answer;
			const serialized = serializeQuestionAnswer(question.options, answer);
			if (serialized !== undefined) result[question.question] = serialized;
		}
		await this.requireSession().questions.answer(request.id, {
			answers: result,
		});
	}

	private async refreshTasks(strict = false): Promise<void> {
		const agent = this.agent;
		if (agent === undefined) return;
		let tasks: readonly AgentTaskInfo[];
		try {
			tasks = await agent.getTasks({ activeOnly: false, limit: 100 });
		} catch (error) {
			if (strict) throw error;
			return;
		}
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
		this.tasks = reconcileTaskSnapshot(previous, mergedTasks, Date.now());
		await Promise.all(
			mergedTasks
				.filter(
					(task) =>
						task.kind === "agent" &&
						task.status !== "running" &&
						previous.get(task.taskId)?.status !== task.status,
				)
				.map(async (task) => {
					try {
						this.taskOutputs.set(
							task.taskId,
							await agent.getTaskOutput({ taskId: task.taskId, tail: 200 }),
						);
					} catch {
						this.taskOutputs.delete(task.taskId);
					}
				}),
		);
		this.publishParentTaskSummaries();
		this.events?.onAgentSnapshot?.(this.getAgentSnapshot());
		this.events?.onTaskSnapshot?.(this.getTaskSnapshot());
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
			this.cronTasks = (await agent.getCronTasks()).map(toCronTask);
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

	private async publishUsage(finishTurn = false): Promise<void> {
		try {
			const usage = await this.requireAgent().getUsage();
			const total = usage.total;
			const currentTurn = usage.currentTurn;
			const speed = finishTurn
				? this.outputSpeed.finish(currentTurn?.output ?? 0)
				: this.outputSpeed.snapshot();
			this.cacheTelemetryObserved ||=
				(total?.inputCacheRead ?? 0) + (total?.inputCacheCreation ?? 0) > 0;
			const context = await this.requireAgent().getContext();
			const modelOptions = await this.getModelOptions();
			const cost = calculateUsageCost(usage.byModel, modelOptions);
			const snapshot: UsageSnapshot = {
				...DEFAULT_USAGE,
				contextTokens: context.tokenCount,
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
		await this.requireAgent().setThinking(resolved);
		this.effort = resolveCatalogEffort(
			normalizeEffortLevel(await this.requireAgent().getThinking(), resolved),
			{
				options: model.efforts,
				defaultEffort: resolved,
			},
		);
	}

	private clearBindings(): void {
		if (this.taskPoll !== undefined) clearInterval(this.taskPoll);
		this.taskPoll = undefined;
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

interface ModelsDevPricingCatalog {
	readonly [provider: string]: {
		readonly models?: Readonly<
			Record<
				string,
				{
					readonly id?: string;
					readonly cost?: {
						readonly input?: number;
						readonly output?: number;
						readonly cache_read?: number;
						readonly cache_write?: number;
						readonly tiers?: readonly {
							readonly input?: number;
							readonly output?: number;
							readonly tier?: {
								readonly type?: string;
								readonly size?: number;
							};
						}[];
					};
				}
			>
		>;
	};
}

let modelsDevPricingCatalogPromise:
	| Promise<ModelsDevPricingCatalog | undefined>
	| undefined;

function loadModelsDevPricingCatalog(): Promise<
	ModelsDevPricingCatalog | undefined
> {
	if (modelsDevPricingCatalogPromise === undefined) {
		const pending = fetch("https://models.dev/api.json", {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(5_000),
		})
			.then(async (response) =>
				response.ok
					? ((await response.json()) as ModelsDevPricingCatalog)
					: undefined,
			)
			.catch(() => undefined);
		modelsDevPricingCatalogPromise = pending;
		void pending.then((catalog) => {
			if (catalog === undefined && modelsDevPricingCatalogPromise === pending)
				modelsDevPricingCatalogPromise = undefined;
		});
	}
	return modelsDevPricingCatalogPromise;
}

export function resolveModelsDevPricing(
	catalog: ModelsDevPricingCatalog | undefined,
	provider: string,
	modelId: string,
): RuntimeModelOption["price"] {
	const direct =
		provider === "vsplab"
			? undefined
			: modelsDevPricingEntry(catalog, provider, modelId);
	const officialProvider =
		provider === "vsplab"
			? vsplabOfficialProvider(modelId)
			: provider === "kimi-coding"
				? "kimi-for-coding"
				: canonicalOfficialProvider(modelId);
	const entry =
		direct ??
		(officialProvider === undefined
			? undefined
			: modelsDevPricingEntry(catalog, officialProvider, modelId));
	const cost = entry?.cost;
	if (cost === undefined || !validPrice(cost.input) || !validPrice(cost.output))
		return {};
	const input = cost.input;
	const output = cost.output;
	const contextTiers = cost.tiers?.flatMap((tier) => {
		const size = tier.tier?.size;
		return tier.tier?.type === "context" &&
			validPositiveInteger(size) &&
			validPrice(tier.input) &&
			validPrice(tier.output)
			? [
					{
						contextTokensAbove: size,
						inputUsdPerMillion: tier.input,
						outputUsdPerMillion: tier.output,
					},
				]
			: [];
	});
	return {
		inputUsdPerMillion: input,
		outputUsdPerMillion: output,
		cacheReadUsdPerMillion: validPrice(cost.cache_read)
			? cost.cache_read
			: undefined,
		cacheWriteUsdPerMillion: validPrice(cost.cache_write)
			? cost.cache_write
			: undefined,
		source: direct === undefined ? "official" : "provider",
		referenceProvider: direct === undefined ? officialProvider : provider,
		contextTiers: contextTiers?.length ? contextTiers : undefined,
	};
}

function modelsDevPricingEntry(
	catalog: ModelsDevPricingCatalog | undefined,
	provider: string,
	modelId: string,
) {
	const models = catalog?.[provider]?.models ?? {};
	return (
		models[modelId] ??
		Object.values(models).find((model) => model.id === modelId)
	);
}

function canonicalOfficialProvider(modelId: string): string | undefined {
	const id = modelId
		.toLowerCase()
		.replace(/^(?:openai|anthropic|google)\//u, "");
	if (/^(?:gpt|codex|o[134])(?:[-_.]|$)/u.test(id)) return "openai";
	if (/^claude(?:[-_.]|$)/u.test(id)) return "anthropic";
	if (/^gemini(?:[-_.]|$)/u.test(id)) return "google";
	if (/^deepseek(?:[-_.]|$)/u.test(id)) return "deepseek";
	if (/^glm(?:[-_.]|$)/u.test(id)) return "zai";
	if (/^kimi(?:[-_.]|$)/u.test(id)) return "moonshotai";
	if (/^minimax(?:[-_.]|$)/u.test(id)) return "minimax";
	if (/^qwen(?:[-_.]|$)/u.test(id)) return "alibaba";
	if (/^mimo(?:[-_.]|$)/u.test(id)) return "xiaomi";
	if (/^grok(?:[-_.]|$)/u.test(id)) return "xai";
	return undefined;
}

function vsplabOfficialProvider(modelId: string): string | undefined {
	const id = modelId.toLowerCase();
	if (/^(?:gpt|codex)(?:[-_.]|$)/u.test(id) || id.startsWith("o")) return "openai";
	if (/^claude(?:[-_.]|$)/u.test(id)) return "anthropic";
	if (/^gemini(?:[-_.]|$)/u.test(id)) return "google";
	if (/^glm(?:[-_.]|$)/u.test(id)) return "zai";
	if (/^deepseek(?:[-_.]|$)/u.test(id)) return "deepseek";
	if (
		id === "k3" ||
		id === "k3-256k" ||
		id === "kimi-for-coding" ||
		id === "kimi-for-coding-highspeed"
	)
		return "kimi-for-coding";
	if (/^kimi(?:[-_.]|$)/u.test(id)) return "moonshotai";
	return undefined;
}

function hiddenLegacyProvider(providerId: string): boolean {
	return /^custom-gemini-via-[a-z0-9-]+-[a-f0-9]{8}$/u.test(
		providerId.toLowerCase(),
	);
}

function validPrice(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0;
}

function validPositiveInteger(value: number | undefined): value is number {
	return value !== undefined && Number.isInteger(value) && value > 0;
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
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
	options: { cursor?: string; limit?: number } = {},
): AgentConversationPage {
	const rawBlocks = history.flatMap((message, index) =>
		projectConversationMessage(message, index, index === history.length - 1),
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
			maxRunSeconds: 7_200,
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
