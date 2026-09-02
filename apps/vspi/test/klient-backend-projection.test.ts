/**
 * Scenario: Kimi Core wire values are projected into the VSPi product surface.
 * Responsibilities: two-level Plan projection and cache-hit calculation.
 * Wiring: pure edge translators with literal Klient-shaped input.
 * Run: pnpm -C apps/vspi test
 */
import type { AgentTaskInfo } from "@moonshot-ai/klient";
import type { RuntimeConnection } from "@vsp/vsp-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	calculateCacheHitPercent,
	formatModelDisplayName,
	formatProviderDisplayName,
	KlientChatBackend,
	projectAgentConversation,
	projectTodoPlanItems,
	reconcileTaskSnapshot,
	resolveModelsDevPricing,
	resolveSessionStartupMode,
	sessionDisplayLabel,
	serializeQuestionAnswer,
	turnState,
} from "../src/v1/backend/klient-backend.js";
import {
	catalogEffortCapability,
	effortLabel,
	resolveCatalogEffort,
} from "../src/v1/domain/effort.js";

const model = (provider: string, id: string) => ({
	provider,
	model: `${provider}/${id}`,
	max_context_size: 128_000,
	capabilities: [],
	thinking: {
		availability: "none" as const,
		can_disable: false,
		controls: [],
	},
	pricing: {
		input_usd_per_million: 1,
		output_usd_per_million: 2,
	},
});

const provider = (id: string) => ({
	id,
	type: "openai",
	base_url: "https://api.example.test/v1",
	has_api_key: true,
	status: "connected" as const,
	models: [],
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Klient backend projection (Core wire to VSPi UI)", () => {
	it("maps resume to the session picker startup mode", () => {
		expect(resolveSessionStartupMode("resume")).toBe("resume");
		expect(resolveSessionStartupMode("continue")).toBe("continue");
		expect(resolveSessionStartupMode(undefined)).toBe("new");
	});

	it("starts resume mode without creating or restoring a session", async () => {
		const createOrTouch = vi.fn().mockResolvedValue({ id: "workspace-1" });
		const create = vi.fn();
		const list = vi.fn();
		const onSessionReady = vi.fn();
		const connection = {
			klient: {
				events: { on: vi.fn(() => ({ dispose: vi.fn() })) },
				global: {
					workspaces: { createOrTouch },
					sessions: { create, list },
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "resume");

		await backend.start({
			onMessage: vi.fn(),
			onMessageUpdate: vi.fn(),
			onBusy: vi.fn(),
			onUsage: vi.fn(),
			onNotice: vi.fn(),
			onSessionReady,
		});

		expect(createOrTouch).toHaveBeenCalledWith({ root: "/workspace" });
		expect(create).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
		expect(onSessionReady).not.toHaveBeenCalled();
		expect(backend.isSessionReady()).toBe(false);
	});

	it("invalidates provider availability when the global catalog changes", async () => {
		const listeners = new Map<string, () => void>();
		const onRuntimeCatalogChanged = vi.fn();
		const connection = {
			klient: {
				events: {
					on: vi.fn((name: string, listener: () => void) => {
						listeners.set(name, listener);
						return { dispose: vi.fn() };
					}),
				},
				global: {
					workspaces: {
						createOrTouch: vi.fn().mockResolvedValue({ id: "workspace-1" }),
					},
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "resume");
		const internals = backend as unknown as {
			providerAvailability: Map<string, unknown>;
		};
		internals.providerAvailability.set("vsplab", {});

		await backend.start({
			onMessage: vi.fn(),
			onMessageUpdate: vi.fn(),
			onBusy: vi.fn(),
			onUsage: vi.fn(),
			onNotice: vi.fn(),
			onRuntimeCatalogChanged,
		});
		listeners.get("kosong.models.changed")?.();

		expect(internals.providerAvailability.size).toBe(0);
		expect(onRuntimeCatalogChanged).toHaveBeenCalledTimes(1);
	});

	it("uses conversation text for session labels without exposing ids", () => {
		expect(
			sessionDisplayLabel({
				title: "  开场需求\n继续说明  ",
				lastPrompt: "最后一条消息",
			}),
		).toBe("开场需求 继续说明");
		expect(
			sessionDisplayLabel({ title: "New Session", lastPrompt: "第一条需求" }),
		).toBe("第一条需求");
		expect(sessionDisplayLabel({})).toBe("空会话");
	});

	it("generates an exit title from the conversation digest", async () => {
		const generateTitle = vi.fn().mockResolvedValue("总结标题");
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, { session: { generateTitle } });

		await expect(backend.generateSessionTitle()).resolves.toBe("总结标题");
		expect(generateTitle).toHaveBeenCalledWith({ source: "digest" });
	});

	it("submits question labels instead of numeric option ids", () => {
		const options = [
			{ label: "继续执行" },
			{ label: "暂停检查" },
			{ label: "取消" },
		];
		expect(serializeQuestionAnswer(options, "1")).toBe("暂停检查");
		expect(serializeQuestionAnswer(options, ["2", "0"])).toBe("取消, 继续执行");
		expect(serializeQuestionAnswer(options, "自定义回答")).toBe("自定义回答");
	});

	it("reports an IPC interaction failure without leaving an unhandled rejection", async () => {
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		const onSessionError = vi.fn();
		const internals = backend as unknown as {
			session: {
				questions: { list(): Promise<never> };
				approvals: { list(): Promise<never[]> };
			};
			events: { onSessionError(error: Error): void };
			refreshInteractions(): void;
		};
		internals.session = {
			questions: { list: () => Promise.reject(new Error("ipc closed")) },
			approvals: { list: () => Promise.resolve([]) },
		};
		internals.events = { onSessionError };
		internals.refreshInteractions();
		await vi.waitFor(() =>
			expect(onSessionError).toHaveBeenCalledWith(
				expect.objectContaining({ message: "ipc closed" }),
			),
		);
	});

	it("derives capability-driven effort choices and fallback", () => {
		const none = catalogEffortCapability({
			availability: "none",
			can_disable: false,
			controls: [],
		});
		expect(none).toMatchObject({ options: ["off"], defaultEffort: "off" });

		const always = catalogEffortCapability({
			availability: "always",
			can_disable: false,
			controls: ["toggle"],
		});
		expect(always).toMatchObject({ options: ["on"], defaultEffort: "on" });

		const toggle = catalogEffortCapability({
			availability: "dynamic",
			can_disable: true,
			controls: ["toggle"],
		});
		expect(toggle.options).toEqual(["off", "on"]);
		expect(
			catalogEffortCapability({
				availability: "dynamic",
				can_disable: false,
				controls: ["toggle"],
			}).options,
		).toEqual(["on"]);
		expect(
			catalogEffortCapability({
				availability: "dynamic",
				can_disable: true,
				controls: ["budget"],
			}).options,
		).toEqual(["off", "on"]);

		const providerSpecific = catalogEffortCapability(
			{
				availability: "dynamic",
				can_disable: true,
				controls: ["effort"],
				efforts: ["low", "high"],
				provider_efforts: {
					acme: ["eco", "turbo"],
					openai: ["minimal", "max"],
					other: ["wrong"],
				},
				default_effort: "turbo",
			},
			{ identity: "acme", type: "openai" },
		);
		expect(providerSpecific).toMatchObject({
			options: ["off", "eco", "turbo"],
			defaultEffort: "turbo",
		});
		expect(resolveCatalogEffort("eco", providerSpecific)).toBe("eco");
		expect(resolveCatalogEffort("中", providerSpecific)).toBe("turbo");
		expect(resolveCatalogEffort("unknown", providerSpecific)).toBe("turbo");
		expect(effortLabel("provider-ultra")).toBe("provider-ultra");

		const invalidDefault = catalogEffortCapability({
			availability: "dynamic",
			can_disable: false,
			controls: ["effort"],
			efforts: ["low", "medium", "high"],
			default_effort: "off",
		});
		expect(invalidDefault).toMatchObject({
			options: ["low", "medium", "high"],
			defaultEffort: "medium",
		});
		expect(resolveCatalogEffort("中", invalidDefault)).toBe("medium");
		expect(catalogEffortCapability(undefined).options).toEqual(["off"]);
	});

	it("falls back to an available model from the default provider and persists it", async () => {
		const models = [model("acme", "unavailable"), model("acme", "available")];
		const queryAvailableModels = vi.fn().mockResolvedValue({
			providerId: "acme",
			modelIds: ["available"],
		});
		const setDefaultModel = vi.fn(async (alias: string) => ({
			default_model: alias,
			model: models.find((item) => item.model === alias) ?? models[1],
		}));
		const setModel = vi.fn().mockResolvedValue(undefined);
		const disposable = { dispose: vi.fn() };
		const eventSource = {
			on: vi.fn(() => disposable),
			onError: vi.fn(() => disposable),
		};
		const agent = {
			events: eventSource,
			setThinking: vi.fn().mockResolvedValue(undefined),
			getThinking: vi.fn().mockResolvedValue("off"),
			setModel,
			getContext: vi.fn().mockRejectedValue(new Error("not loaded")),
			getTasks: vi.fn().mockResolvedValue([]),
			getCronTasks: vi.fn().mockResolvedValue([]),
			getUsage: vi.fn().mockRejectedValue(new Error("not loaded")),
		};
		const session = { agent: vi.fn(() => agent), events: eventSource };
		const connection = {
			klient: {
				global: {
					config: {
						get: vi.fn(async (domain: string) =>
							domain === "defaultModel" ? "acme/unavailable" : undefined,
						),
					},
					kosong: {
						queryAvailableModels,
						listModels: vi.fn().mockResolvedValue(models),
						listProviders: vi.fn().mockResolvedValue([provider("acme")]),
						setDefaultModel,
					},
				},
				session: vi.fn(() => session),
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "new");
		const bind = backend as unknown as {
			bindSession(meta: { id: string }, reason: "startup"): Promise<void>;
		};

		try {
			await bind.bindSession({ id: "session-1" }, "startup");
			expect(queryAvailableModels).toHaveBeenCalledWith("acme");
			expect(setDefaultModel).toHaveBeenCalledWith("acme/available");
			expect(setModel).toHaveBeenCalledWith("acme/available");
		} finally {
			await backend.dispose();
		}
	});

	it("intersects configured models with successful provider availability queries", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
		);
		const models = [
			model("acme", "available"),
			model("acme", "unavailable"),
			model("other", "untouched"),
			model("custom-gemini-via-legacybridge-32efcb06", "gemini-3.6-flash"),
		];
		const queryAvailableModels = vi.fn().mockResolvedValue({
			providerId: "acme",
			modelIds: ["available"],
		});
		const connection = {
			klient: {
				global: {
					kosong: {
						listModels: vi.fn().mockResolvedValue(models),
						listProviders: vi.fn().mockResolvedValue([
							provider("acme"),
							{
								...provider("other"),
								status: "unconfigured",
								has_api_key: false,
							},
							provider("custom-gemini-via-legacybridge-32efcb06"),
						]),
						queryAvailableModels,
					},
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "new");

		await expect(backend.getModelOptions()).resolves.toMatchObject([
			{ provider: "acme", id: "available" },
		]);
		expect(queryAvailableModels).toHaveBeenCalledTimes(1);
		expect(queryAvailableModels).toHaveBeenCalledWith("acme");
	});

	it("shows managed OAuth models without probing API-key availability", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
		);
		const queryAvailableModels = vi.fn();
		const connection = {
			klient: {
				global: {
					kosong: {
						listModels: vi
							.fn()
							.mockResolvedValue([model("vsplab", "glm-5.3-flash")]),
						listProviders: vi.fn().mockResolvedValue([
							{
								...provider("vsplab"),
								has_api_key: false,
							},
						]),
						queryAvailableModels,
					},
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "new");

		await expect(backend.getModelOptions()).resolves.toMatchObject([
			{
				provider: "vsplab",
				id: "glm-5.3-flash",
				brand: "VSPLab",
				label: "GLM 5.3 Flash",
			},
		]);
		expect(queryAvailableModels).not.toHaveBeenCalled();
	});

	it("keeps configured models when provider availability queries fail", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
		);
		const models = [model("acme", "model-a"), model("acme", "model-b")];
		const queryAvailableModels = vi
			.fn()
			.mockRejectedValue(new Error("unavailable"));
		const connection = {
			klient: {
				global: {
					kosong: {
						listModels: vi.fn().mockResolvedValue(models),
						listProviders: vi.fn().mockResolvedValue([provider("acme")]),
						queryAvailableModels,
					},
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "new");

		await expect(backend.getModelOptions()).resolves.toMatchObject([
			{ provider: "acme", id: "model-a" },
			{ provider: "acme", id: "model-b" },
		]);
	});

	it("starts a new transcript stream segment after a tool boundary", () => {
		expect(turnState(7, 0)).toMatchObject({
			assistantId: "assistant:7",
			thinkingId: "thinking:7",
		});
		expect(turnState(7, 1)).toMatchObject({
			assistantId: "assistant:7:1",
			thinkingId: "thinking:7:1",
		});
	});

	it("settles a running subagent that disappears from the task snapshot", () => {
		const startedAt = 1_000;
		const now = 6_000;
		const running = {
			taskId: "agent-running",
			description: "Inspect repository",
			kind: "agent",
			status: "running",
			detached: false,
			startedAt,
			endedAt: null,
		} satisfies AgentTaskInfo;
		const completed = {
			taskId: "agent-completed",
			description: "Check release",
			kind: "agent",
			status: "completed",
			detached: false,
			startedAt: 500,
			endedAt: 900,
		} satisfies AgentTaskInfo;

		const current = reconcileTaskSnapshot(
			new Map<string, AgentTaskInfo>([
				[running.taskId, running],
				[completed.taskId, completed],
			]),
			[],
			now,
		);

		expect(current.get(running.taskId)).toMatchObject({
			status: "lost",
			startedAt,
			endedAt: now,
		});
		expect(current.get(completed.taskId)).toBe(completed);
	});

	it("refreshes task snapshots without creating transcript subagent messages", async () => {
		const task = {
			taskId: "agent-running",
			description: "Inspect repository",
			kind: "agent",
			status: "running",
			detached: false,
			startedAt: 1_000,
			endedAt: null,
			agentId: "agent-0",
			parentToolCallId: "tool-swarm",
		} satisfies AgentTaskInfo;
		const process = {
			taskId: "process-running",
			description: "Run checks",
			kind: "process",
			status: "running",
			detached: true,
			startedAt: 2_000,
			endedAt: null,
			command: "pnpm test",
			pid: 42,
			exitCode: null,
		} satisfies AgentTaskInfo;
		const question = {
			taskId: "question-running",
			description: "Await approval",
			kind: "question",
			status: "running",
			startedAt: 3_000,
			endedAt: null,
			questionCount: 2,
			toolCallId: "question-tool",
		} satisfies AgentTaskInfo;
		const getTasks = vi.fn().mockResolvedValue([task, process, question]);
		const onMessage = vi.fn();
		const onMessageUpdate = vi.fn();
		const onAgentSnapshot = vi.fn();
		const onTaskSnapshot = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { getTasks },
			events: { onMessage, onMessageUpdate, onAgentSnapshot, onTaskSnapshot },
		});
		const refresh = backend as unknown as { refreshTasks(): Promise<void> };

		await refresh.refreshTasks();
		await refresh.refreshTasks();

		expect(onMessage).not.toHaveBeenCalled();
		expect(onAgentSnapshot).toHaveBeenCalledTimes(2);
		expect(onTaskSnapshot).toHaveBeenCalledTimes(2);
		expect(onTaskSnapshot).toHaveBeenLastCalledWith({
			agents: [
				expect.objectContaining({
					taskId: "agent-running",
					agentId: "agent-0",
				}),
			],
			processes: [
				expect.objectContaining({ taskId: "process-running", pid: 42 }),
			],
			questions: [
				expect.objectContaining({
					taskId: "question-running",
					questionCount: 2,
				}),
			],
		});
		expect(onMessageUpdate).toHaveBeenCalledTimes(1);
		expect(onMessageUpdate).toHaveBeenCalledWith("tool-swarm", {
			summary: "Agents · 0/1 completed · 1 running",
		});
	});

	it("projects and pages a compact child conversation", () => {
		const history = [
			{
				id: "user-1",
				role: "user",
				origin: { kind: "user" },
				content: [{ type: "text", text: "Inspect the backend" }],
				toolCalls: [],
			},
			{
				id: "injection-1",
				role: "user",
				origin: { kind: "injection" },
				content: [{ type: "text", text: "Internal instruction" }],
				toolCalls: [],
			},
			{
				id: "assistant-1",
				role: "assistant",
				content: [
					{ type: "think", think: "Reasoning" },
					{ type: "text", text: "I will inspect it" },
				],
				toolCalls: [
					{
						type: "function",
						id: "read-1",
						name: "Read",
						arguments: '{"path":"src/read.ts"}',
					},
					{
						type: "function",
						id: "write-1",
						name: "Write",
						arguments: '{"file_path":"src/changed.ts"}',
					},
					{
						type: "function",
						id: "read-2",
						name: "Read",
						arguments: '{"path":"src/missing.ts"}',
					},
				],
			},
			{
				id: "read-result",
				role: "tool",
				toolCallId: "read-1",
				content: [{ type: "text", text: "file contents" }],
				toolCalls: [],
			},
			{
				id: "write-result",
				role: "tool",
				toolCallId: "write-1",
				content: [{ type: "text", text: "written" }],
				toolCalls: [],
			},
			{
				id: "error-result",
				role: "tool",
				toolCallId: "read-2",
				isError: true,
				content: [{ type: "text", text: "Read failed" }],
				toolCalls: [],
			},
			{
				id: "assistant-2",
				role: "assistant",
				content: [{ type: "text", text: "Finished" }],
				toolCalls: [],
			},
		];

		const latest = projectAgentConversation("agent-0", history, 321, {
			limit: 4,
		});
		expect(latest).toMatchObject({
			agentId: "agent-0",
			nextCursor: "4",
			tokenCount: 321,
			totalBlocks: 8,
		});
		expect(
			latest.blocks.map((block) => [
				block.kind,
				block.toolName,
				block.presentation,
				block.text,
			]),
		).toEqual([
			["tool", "Write", "change", "Modified src/changed.ts"],
			["tool", "Read", "message", "Read"],
			["error", "Read", "error", "Read failed"],
			["final", undefined, "message", "Finished"],
		]);

		const older = projectAgentConversation("agent-0", history, 321, {
			cursor: latest.nextCursor,
			limit: 4,
		});
		expect(older.nextCursor).toBeUndefined();
		expect(older.blocks.map((block) => [block.kind, block.text])).toEqual([
			["commentary", "Inspect the backend"],
			["thinking", "Reasoning"],
			["commentary", "I will inspect it"],
			["tool", "Read"],
		]);
	});

	it("projects a two-level TodoList and derives the parent status", () => {
		expect(
			projectTodoPlanItems({
				todos: [
					{
						title: "Todo integration",
						children: [
							{ title: "Extend schema", status: "done" },
							{ title: "Connect Plan UI", status: "in_progress" },
						],
					},
				],
			}),
		).toEqual([
			{
				id: "todo:0",
				label: "Todo integration",
				status: "in_progress",
				depth: 0,
				group: true,
			},
			{
				id: "todo:0:0",
				label: "Extend schema",
				status: "done",
				depth: 1,
				focused: false,
			},
			{
				id: "todo:0:1",
				label: "Connect Plan UI",
				status: "in_progress",
				depth: 1,
				focused: true,
			},
		]);
	});

	it("calculates cache hit rate from uncached, read, and write input", () => {
		expect(
			calculateCacheHitPercent({
				inputOther: 4_000,
				inputCacheRead: 5_000,
				inputCacheCreation: 1_000,
			}),
		).toBe(50);
	});

	it("returns no cache hit rate when the prompt has no tokens", () => {
		expect(
			calculateCacheHitPercent({
				inputOther: 0,
				inputCacheRead: 0,
				inputCacheCreation: 0,
			}),
		).toBeNull();
	});

	it("forwards task detach without stopping the task", async () => {
		const detachTask = vi.fn(async () => undefined);
		const stopTask = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, { agent: { detachTask, stopTask } });

		await backend.detachAgentTask("task-1");

		expect(detachTask).toHaveBeenCalledWith({ taskId: "task-1" });
		expect(stopTask).not.toHaveBeenCalled();
	});

	it("preserves compact boolean semantics and forwards custom instructions", async () => {
		const compact = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, { agent: { compact } });

		await expect(
			backend.compact({ profile: "custom", customInstructions: "keep decisions" }),
		).resolves.toBe(true);
		await expect(backend.compact({ profile: "pi-native" })).resolves.toBe(false);
		expect(compact).toHaveBeenNthCalledWith(1, {
			instruction: "keep decisions",
		});
		expect(compact).toHaveBeenNthCalledWith(2, { instruction: undefined });
	});

	it("projects trusted compaction events and refreshes usage after completion", () => {
		const listeners = new Map<string, (event: Record<string, unknown>) => void>();
		const disposable = { dispose: vi.fn() };
		const eventSource = {
			on: vi.fn(
				(name: string, listener: (event: Record<string, unknown>) => void) => {
					listeners.set(name, listener);
					return disposable;
				},
			),
			onError: vi.fn(() => disposable),
		};
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		const onCompactionActivity = vi.fn();
		const onMessage = vi.fn();
		const publishUsage = vi.fn().mockResolvedValue(undefined);
		Object.assign(backend, {
			agent: { events: eventSource },
			session: { events: eventSource },
			events: {
				onMessage,
				onMessageUpdate: vi.fn(),
				onBusy: vi.fn(),
				onUsage: vi.fn(),
				onNotice: vi.fn(),
				onCompactionActivity,
			},
			publishUsage,
		});
		(backend as unknown as { subscribe(): void }).subscribe();

		listeners.get("compaction.started")?.({
			trigger: "auto",
			time: 1_234,
		});
		listeners.get("compaction.blocked")?.({ turnId: 7 });
		listeners.get("compaction.completed")?.({
			result: {
				summary: "summary",
				compactedCount: 6,
				tokensBefore: 9_000,
				tokensAfter: 1_200,
				droppedCount: 4,
			},
		});
		listeners.get("compaction.cancelled")?.({});
		listeners.get("error")?.({
			code: "compaction.failed",
			message: "compaction failed",
		});

		expect(onCompactionActivity.mock.calls).toEqual([
			[{ type: "started", trigger: "auto", startedAt: 1_234 }],
			[{ type: "blocked", turnId: 7 }],
			[
				{
					type: "completed",
					result: {
						summary: "summary",
						compactedCount: 6,
						tokensBefore: 9_000,
						tokensAfter: 1_200,
						droppedCount: 4,
					},
				},
			],
			[{ type: "cancelled" }],
			[{ type: "failed" }],
		]);
		expect(publishUsage).toHaveBeenCalledOnce();
		expect(onMessage).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "error", summary: "compaction failed" }),
		);
	});

	it("formats provider and model identities without changing their ids", () => {
		expect(formatModelDisplayName("example", "aaa-x.y-bbb")).toBe(
			"AAA x.y Bbb",
		);
		expect(formatModelDisplayName("opencode-go", "glm-5.3-flash")).toBe(
			"GLM 5.3 Flash",
		);
		expect(formatModelDisplayName("kimi-coding", "k3", "K3")).toBe("Kimi K3");
		expect(formatModelDisplayName("kimi-coding", "k3-256k")).toBe(
			"Kimi K3 256K",
		);
		expect(formatProviderDisplayName("opencode-go")).toBe("OpenCode Go");
	});

	it("uses channel prices first and deterministic official reference prices second", () => {
		const catalog = {
			deepseek: {
				models: {
					"deepseek-v4-flash": {
						id: "deepseek-v4-flash",
						cost: { input: 0.14, output: 0.28 },
					},
				},
			},
			"opencode-go": {
				models: {
					"deepseek-v4-flash": {
						id: "deepseek-v4-flash",
						cost: { input: 0.22, output: 0.66 },
					},
				},
			},
		};

		expect(
			resolveModelsDevPricing(catalog, "opencode-go", "deepseek-v4-flash"),
		).toEqual({
			inputUsdPerMillion: 0.22,
			outputUsdPerMillion: 0.66,
			source: "provider",
			referenceProvider: "opencode-go",
			contextTiers: undefined,
		});
		expect(
			resolveModelsDevPricing(catalog, "vsplab", "deepseek-v4-flash"),
		).toEqual({
			inputUsdPerMillion: 0.14,
			outputUsdPerMillion: 0.28,
			source: "official",
			referenceProvider: "deepseek",
			contextTiers: undefined,
		});
		expect(
			resolveModelsDevPricing(catalog, "vsplab", "deepseek-v4-pro"),
		).toEqual({});
	});
});
