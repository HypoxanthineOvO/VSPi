/**
 * Scenario: Kimi Core wire values are projected into the VSPi product surface.
 * Responsibilities: Plan, Agent task, Runtime Goal, usage, and model-price projection.
 * Wiring: edge translators and focused Klient-shaped backend fixtures.
 * Run: pnpm -C apps/vspi test
 */
import type { AgentTaskInfo } from "@moonshot-ai/klient";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConnection } from "@vsp/vsp-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	calculateCacheHitPercent,
	calculateUsageCost,
	formatModelDisplayName,
	formatProviderDisplayName,
	KlientChatBackend,
	projectAgentConversation,
	projectCronSessionMessage,
	projectTodoPlanItems,
	projectTowerMissionPlanItems,
	reconcileTaskSnapshot,
	resolveSessionStartupMode,
	sessionDisplayLabel,
	serializeQuestionAnswer,
	turnState,
} from "../src/v1/backend/klient-backend.js";
import type { RuntimeModelOption } from "../src/v1/backend/types.js";
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

const pricedModel = (
	alias: string,
	price: RuntimeModelOption["price"],
): RuntimeModelOption => ({
	id: alias.includes("/") ? (alias.split("/").at(-1) ?? alias) : alias,
	provider: alias.split("/", 1)[0] ?? "example",
	alias,
	brand: "Example",
	label: alias,
	vision: false,
	efforts: ["off"],
	price,
	contextWindow: 128_000,
});

const provider = (id: string) => ({
	id,
	type: "openai",
	base_url: "https://api.example.test/v1",
	has_api_key: true,
	status: "connected" as const,
	models: [],
});

function draftBackendFixture(
	reconnectRuntime?: () => Promise<RuntimeConnection>,
	recoveryDelays: readonly number[] = [10, 10, 10, 10, 10],
) {
	const listeners = new Map<string, (event: Record<string, unknown>) => void>();
	let connectionError: ((error: Error) => void) | undefined;
	const events = { on: vi.fn((name: string, handler: (event: Record<string, unknown>) => void) => { listeners.set(name, handler); return { dispose: vi.fn() }; }), onError: vi.fn((handler: (error: Error) => void) => { connectionError = handler; return { dispose: vi.fn() }; }) };
	const models = [model("example", "code")];
	let thinking = "off";
	const agent = {
		events, setModel: vi.fn(async () => undefined), getModel: vi.fn(async () => "example/code"),
		setThinking: vi.fn(async (value: string) => { thinking = value; }), getThinking: vi.fn(async () => thinking),
		getGoal: vi.fn(async () => ({})), getTasks: vi.fn(async () => []), getCronTasks: vi.fn(async () => []),
		getUsage: vi.fn(async () => { throw new Error("no usage"); }), getContext: vi.fn(async () => ({ history: [], tokenCount: 0 })),
		prompt: vi.fn(async ({ promptId }: { promptId: string }) => { listeners.get("prompt.completed")?.({ promptId, reason: "completed" }); }),
	};
	const create = vi.fn(async () => ({ id: "new-session" }));
	const remove = vi.fn(async () => undefined);
	const getConfig = vi.fn(async (section: string): Promise<unknown> => section === "defaultModel" ? "example/code" : undefined);
	const connection = { close: vi.fn(async () => undefined), klient: { events, session: () => ({ agent: () => agent, events, delete: remove, restore: async () => true, get: async () => ({ id: "old-session" }) }), global: {
		workspaces: { createOrTouch: vi.fn(async () => ({ id: "workspace" })) }, sessions: { create },
		config: { get: getConfig },
		kosong: { listModels: vi.fn(async () => models), listProviders: vi.fn(async () => [provider("example")]), getProvider: vi.fn(async () => provider("example")), queryAvailableModels: vi.fn(async () => ({ modelIds: ["example/code"] })), setDefaultModel: vi.fn(async () => ({ model: models[0] })) },
	} } } as unknown as RuntimeConnection;
	const backend = new KlientChatBackend(connection, "/workspace", "new", reconnectRuntime, recoveryDelays);
	const reset = vi.fn();
	const connectionStates: Array<{ state: string; attempt: number }> = [];
	const start = () => backend.start({ onMessage: vi.fn(), onMessageUpdate: vi.fn(), onBusy: vi.fn(), onUsage: vi.fn(), onNotice: vi.fn(), onSessionReset: reset, onRuntimeConnectionState: (state, attempt) => { connectionStates.push({ state, attempt }); } });
	return { backend, connection, create, remove, agent, reset, start, listeners, getConfig, connectionStates, disconnect: () => connectionError?.(new Error("ipc closed")) };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Klient backend projection (Core wire to VSPi UI)", () => {
	it("creates no session for opening, model settings, empty submission or /new", async () => {
		const fixture = draftBackendFixture();
		try {
			await fixture.start();
			await fixture.backend.selectModel("example", "code");
			await fixture.backend.setEffort("off");
			await fixture.backend.send(" ", { attachments: [], effort: "off", behavior: "prompt" });
			await fixture.backend.newSession();
			expect(fixture.create).not.toHaveBeenCalled();
			expect(fixture.agent.setModel).not.toHaveBeenCalled();
			expect(fixture.backend.isSessionReady()).toBe(false);
		} finally { await fixture.backend.dispose(); }
	});

	it("creates exactly one session for concurrent first submissions", async () => {
		const fixture = draftBackendFixture();
		try {
			await fixture.start();
			await Promise.all(["first", "second"].map((text) => fixture.backend.send(text, { attachments: [], effort: "off", behavior: "prompt" })));
			expect(fixture.create).toHaveBeenCalledOnce();
			expect(fixture.agent.prompt).toHaveBeenCalledTimes(2);
			expect(fixture.reset).toHaveBeenLastCalledWith(expect.objectContaining({ id: "new-session", reason: "created" }));
		} finally { await fixture.backend.dispose(); }
	});

	it("settles a disconnect before prompt acknowledgement without an orphan rejection", async () => {
		const fixture = draftBackendFixture();
		try {
			await fixture.start();
			fixture.agent.prompt.mockImplementationOnce(async () => {
				fixture.disconnect();
				throw new Error("ipc closed");
			});
			await expect(fixture.backend.send("first", { attachments: [], effort: "off", behavior: "prompt" })).rejects.toThrow("ipc closed");
		} finally { await fixture.backend.dispose(); }
	});

	it("recovers automatically when the runtime ipc connection closes", async () => {
		const replacement = draftBackendFixture();
		const fixture = draftBackendFixture(() => Promise.resolve(replacement.connection));
		try {
			await fixture.start();
			fixture.disconnect();
			await vi.waitFor(() => {
				expect(fixture.connectionStates).toContainEqual({ state: "reconnected", attempt: 1 });
			}, { timeout: 4_000 });
			expect(fixture.connectionStates[0]).toEqual({ state: "reconnecting", attempt: 1 });
			expect(fixture.backend.runtimeConnection).toBe(replacement.connection);
			expect(fixture.backend.isSessionReady()).toBe(false);
			await expect(fixture.backend.send("after recovery", { attachments: [], effort: "off", behavior: "prompt" })).resolves.toEqual({ status: "completed" });
			expect(replacement.create).toHaveBeenCalledOnce();
		} finally {
			await fixture.backend.dispose();
			await replacement.backend.dispose();
		}
	});

	it("reports failed recovery after exhausting reconnect attempts", async () => {
		let attempts = 0;
		const fixture = draftBackendFixture(async () => {
			attempts += 1;
			throw new Error("runtime unreachable");
		});
		try {
			await fixture.start();
			fixture.disconnect();
			await vi.waitFor(() => {
				expect(fixture.connectionStates.at(-1)?.state).toBe("failed");
			}, { timeout: 4_000 });
			expect(attempts).toBe(5);
			expect(fixture.connectionStates[0]).toEqual({ state: "reconnecting", attempt: 1 });
		} finally { await fixture.backend.dispose(); }
	});

	it("cancels a pending initial creation without submitting or retaining an empty session", async () => {
		const fixture = draftBackendFixture();
		let release!: (meta: { id: string }) => void;
		fixture.create.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		try {
			await fixture.start();
			const submitted = fixture.backend.send("first", { attachments: [], effort: "off", behavior: "prompt" });
			await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledOnce());
			await fixture.backend.cancel();
			release({ id: "cancelled-session" });
			expect(await submitted).toEqual({ status: "cancelled" });
			expect(fixture.remove).toHaveBeenCalledOnce();
			expect(fixture.agent.prompt).not.toHaveBeenCalled();
		} finally { await fixture.backend.dispose(); }
	});

	it("keeps the restored session model instead of replacing it with the global default", async () => {
		const fixture = draftBackendFixture();
		try {
			await fixture.start();
			fixture.getConfig.mockImplementation(async (section: string) => section === "defaultModel" ? "example/other" : undefined);
			await fixture.backend.switchSession("old-session");
			expect(fixture.agent.getModel).toHaveBeenCalledOnce();
			expect(fixture.agent.setModel).not.toHaveBeenCalled();
			expect(fixture.create).not.toHaveBeenCalled();
		} finally { await fixture.backend.dispose(); }
	});

	it("starts a new output segment before consuming steer so later deltas cannot rewrite earlier output", async () => {
		const fixture = draftBackendFixture();
		try {
			await fixture.start();
			await fixture.backend.send("first", { attachments: [], effort: "off", behavior: "prompt" });
			const state = fixture.backend as unknown as { queuedPrompts: Map<string, unknown>; turn: ReturnType<typeof turnState>; consumeQueuedPrompt(id: string): void };
			state.turn = turnState(1, 0);
			state.queuedPrompts.set("steer", { text: "change", delivery: "steer", phase: "queued" });
			state.consumeQueuedPrompt("steer");
			expect(state.turn.assistantId).toBe("assistant:1:1");
			expect(state.queuedPrompts.size).toBe(0);
		} finally { await fixture.backend.dispose(); }
	});
	it("sends image bytes with queued input instead of silently dropping attachments", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vspi-image-"));
		try {
			const path = join(dir, "image.png");
			await writeFile(path, Buffer.from([1, 2, 3]));
			const steer = vi.fn().mockResolvedValue(undefined);
			const backend = new KlientChatBackend({} as RuntimeConnection, dir, "new");
			Object.assign(backend, { agent: { steer }, busy: true });
			await backend.send("image", {
				effort: "off", behavior: "prompt", clientMessageId: "image-prompt",
				attachments: [{ id: "image", alias: "image", mimeType: "image/png", width: 1, height: 1, size: 3, path, status: "ready" }],
			});
			expect(steer).toHaveBeenCalledWith({ promptId: "image-prompt", input: [
				{ type: "text", text: "image" },
				{ type: "image_url", imageUrl: { url: "data:image/png;base64,AQID" } },
			] });
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
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
				events: { on: vi.fn(() => ({ dispose: vi.fn() })), onError: vi.fn(() => ({ dispose: vi.fn() })) },
				global: {
					workspaces: { createOrTouch },
					sessions: { create, list },
					config: { get: vi.fn(async () => undefined) },
					kosong: { listModels: vi.fn(async () => []), listProviders: vi.fn(async () => []) },
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
					onError: vi.fn(() => ({ dispose: vi.fn() })),
					on: vi.fn((name: string, listener: () => void) => {
						listeners.set(name, listener);
						return { dispose: vi.fn() };
					}),
				},
				global: {
					workspaces: {
						createOrTouch: vi.fn().mockResolvedValue({ id: "workspace-1" }),
					},
					config: { get: vi.fn(async () => undefined) },
					kosong: { listModels: vi.fn(async () => []), listProviders: vi.fn(async () => []) },
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "resume");
		const internals = backend as unknown as {
			providerAvailability: Map<string, unknown>;
			modelOptionsPromise: Promise<unknown[]> | undefined;
		};
		internals.providerAvailability.set("vsplab", {});
		internals.modelOptionsPromise = Promise.resolve([]);

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
		expect(internals.modelOptionsPromise).toBeUndefined();
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
					acme: ["minimal", "max"],
					openai: ["eco", "turbo"],
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

	it("uses the Core provider type rather than an alias when effort maps conflict", () => {
		const thinking = {
			availability: "always" as const,
			can_disable: false,
			controls: ["effort" as const],
			efforts: ["medium"],
			provider_efforts: { alias: ["low"], openai: ["high"] },
			default_effort: "high",
		};
		expect(catalogEffortCapability(thinking, { identity: "alias", type: "openai" })).toMatchObject({
			options: ["high"], defaultEffort: "high", mutable: false,
		});
		expect(catalogEffortCapability(thinking, { identity: "alias", type: "unknown" }).options).toEqual(["medium"]);
		expect(catalogEffortCapability(thinking, { identity: "alias" }).options).toEqual(["low"]);
	});

	it("falls back to an available model from the default provider and persists it", async () => {
		const models = [model("acme", "unavailable"), model("acme", "available")];
		const queryAvailableModels = vi.fn().mockResolvedValue({
			providerId: "acme",
			modelIds: ["acme/available"],
		});
		const setDefaultModel = vi.fn(async (alias: string) => ({
			default_model: alias,
			model: models.find((item) => item.model === alias) ?? models[1],
		}));
		const setModel = vi.fn().mockResolvedValue(undefined);
		const getGoal = vi.fn().mockResolvedValue({ goal: { status: "active" } });
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
			getGoal,
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
		const onRuntimeGoalStatus = vi.fn();
		Object.assign(backend, {
			events: { onRuntimeGoalStatus, onNotice: vi.fn() },
		});
		const bind = backend as unknown as {
			bindSession(meta: { id: string }, reason: "startup"): Promise<void>;
		};

		try {
			await bind.bindSession({ id: "session-1" }, "startup");
			expect(queryAvailableModels).toHaveBeenCalledWith("acme");
			expect(setDefaultModel).toHaveBeenCalledWith("acme/available");
			expect(setModel).toHaveBeenCalledWith("acme/available");
			expect(getGoal).toHaveBeenCalledOnce();
			expect(onRuntimeGoalStatus).toHaveBeenCalledWith("active");
		} finally {
			await backend.dispose();
		}
	});

	it("drives runtime Goal pause, resume, and cancel through the Klient agent", async () => {
		const pauseGoal = vi.fn().mockResolvedValue({ goalId: "goal-1", status: "paused" });
		const resumeGoal = vi.fn().mockResolvedValue({ goalId: "goal-1", status: "active" });
		const cancelGoal = vi.fn().mockResolvedValue({ goalId: "goal-1", status: "active" });
		const onRuntimeGoalStatus = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { pauseGoal, resumeGoal, cancelGoal },
			events: { onRuntimeGoalStatus },
		});

		await expect(backend.pauseGoal()).resolves.toEqual({
			goalId: "goal-1",
			status: "paused",
		});
		await expect(backend.resumeGoal()).resolves.toEqual({
			goalId: "goal-1",
			status: "active",
		});
		await expect(backend.cancelGoal()).resolves.toEqual({
			goalId: "goal-1",
			status: undefined,
		});

		expect(pauseGoal).toHaveBeenCalledWith();
		expect(resumeGoal).toHaveBeenCalledWith();
		expect(cancelGoal).toHaveBeenCalledWith();
		expect(onRuntimeGoalStatus.mock.calls.map(([status]) => status)).toEqual([
			"paused",
			"active",
			undefined,
		]);
	});

	it("keeps locally configured models selectable when availability omits them", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
		);
		const omitted = model("acme", "omitted");
		const models = [
			model("acme", "available"),
			omitted,
			model("other", "untouched"),
			model("custom-gemini-via-legacybridge-32efcb06", "gemini-3.6-flash"),
		];
		const providers = [
			provider("acme"),
			{
				...provider("other"),
				status: "unconfigured" as const,
				has_api_key: false,
			},
			provider("custom-gemini-via-legacybridge-32efcb06"),
		];
		const queryAvailableModels = vi.fn().mockResolvedValue({
			providerId: "acme",
			modelIds: ["acme/available"],
		});
		const setDefaultModel = vi.fn().mockResolvedValue({
			default_model: omitted.model,
			model: omitted,
		});
		const setModel = vi.fn().mockResolvedValue(undefined);
		const connection = {
			klient: {
				global: {
					kosong: {
						listModels: vi.fn().mockResolvedValue(models),
						listProviders: vi.fn().mockResolvedValue(providers),
						queryAvailableModels,
						setDefaultModel,
					},
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "new");
		Object.assign(backend, {
			agent: {
				setModel,
				setThinking: vi.fn().mockResolvedValue(undefined),
				getThinking: vi.fn().mockResolvedValue("off"),
			},
		});

		await expect(backend.getModelOptions()).resolves.toMatchObject([
			{ provider: "acme", id: "available" },
			{ provider: "acme", id: "omitted" },
		]);
		await expect(backend.selectModel("acme", "omitted")).resolves.toMatchObject({
			modelId: "omitted",
		});
		await expect(
			backend.selectModel("other", "untouched"),
		).rejects.toThrow("Provider other 当前不可用");
		expect(queryAvailableModels).toHaveBeenCalledTimes(1);
		expect(queryAvailableModels).toHaveBeenCalledWith("acme");
		expect(setDefaultModel).toHaveBeenCalledWith("acme/omitted");
		expect(setModel).toHaveBeenCalledWith("acme/omitted");
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
				alias: "vsplab/glm-5.3-flash",
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

	it("recovers a completed agent when the task list temporarily omits it", async () => {
		const running = {
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
		const completed = {
			...running,
			status: "completed" as const,
			endedAt: 2_000,
		} satisfies AgentTaskInfo;
		const getTasks = vi
			.fn()
			.mockResolvedValueOnce([running])
			.mockResolvedValueOnce([]);
		const getTask = vi.fn().mockResolvedValue(completed);
		const getTaskOutput = vi.fn().mockResolvedValue("child final");
		const onAgentSnapshot = vi.fn();
		const onTaskSnapshot = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { getTasks, getTask, getTaskOutput },
			events: { onAgentSnapshot, onTaskSnapshot, onMessageUpdate: vi.fn() },
		});
		const refresh = backend as unknown as { refreshTasks(): Promise<void> };

		await refresh.refreshTasks();
		await refresh.refreshTasks();

		expect(getTask).toHaveBeenCalledWith("agent-running");
		expect(getTaskOutput).toHaveBeenCalledWith({
			taskId: "agent-running",
			tail: 200,
		});
		expect(onAgentSnapshot).toHaveBeenLastCalledWith(
			expect.objectContaining({
				active: [],
				recent: [
					expect.objectContaining({
						id: "agent-running",
						status: "success",
						outputPreview: "child final",
						summary: "child final",
					}),
				],
			}),
		);
		expect(onTaskSnapshot).toHaveBeenLastCalledWith(
			expect.objectContaining({
				agents: [
					expect.objectContaining({
						taskId: "agent-running",
						status: "completed",
						outputPreview: "child final",
					}),
				],
			}),
		);
	});

	it("marks an omitted running agent lost when getTask confirms it is gone", async () => {
		const running = {
			taskId: "agent-gone",
			description: "Inspect repository",
			kind: "agent",
			status: "running",
			detached: false,
			startedAt: 1_000,
			endedAt: null,
		} satisfies AgentTaskInfo;
		const getTasks = vi
			.fn()
			.mockResolvedValueOnce([running])
			.mockResolvedValueOnce([]);
		const getTask = vi.fn().mockResolvedValue(undefined);
		const onAgentSnapshot = vi.fn();
		const onTaskSnapshot = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { getTasks, getTask },
			events: { onAgentSnapshot, onTaskSnapshot },
		});
		const refresh = backend as unknown as { refreshTasks(): Promise<void> };

		await refresh.refreshTasks();
		await refresh.refreshTasks();

		expect(getTask).toHaveBeenCalledWith("agent-gone");
		expect(onAgentSnapshot).toHaveBeenLastCalledWith(
			expect.objectContaining({
				recent: [expect.objectContaining({ id: "agent-gone", status: "lost" })],
			}),
		);
		expect(onTaskSnapshot).toHaveBeenLastCalledWith(
			expect.objectContaining({
				agents: [expect.objectContaining({ taskId: "agent-gone", status: "lost" })],
			}),
		);
	});

	it("keeps a running agent when getTask cannot confirm its state", async () => {
		const running = {
			taskId: "agent-unknown",
			description: "Inspect repository",
			kind: "agent",
			status: "running",
			detached: false,
			startedAt: 1_000,
			endedAt: null,
		} satisfies AgentTaskInfo;
		const getTasks = vi
			.fn()
			.mockResolvedValueOnce([running])
			.mockResolvedValueOnce([]);
		const getTask = vi.fn().mockRejectedValue(new Error("temporarily unavailable"));
		const onAgentSnapshot = vi.fn();
		const onTaskSnapshot = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { getTasks, getTask },
			events: { onAgentSnapshot, onTaskSnapshot },
		});
		const refresh = backend as unknown as { refreshTasks(): Promise<void> };

		await refresh.refreshTasks();
		await refresh.refreshTasks();

		expect(onAgentSnapshot).toHaveBeenLastCalledWith(
			expect.objectContaining({
				active: [expect.objectContaining({ id: "agent-unknown", status: "running" })],
				recent: [],
			}),
		);
		expect(onTaskSnapshot).toHaveBeenLastCalledWith(
			expect.objectContaining({
				agents: [expect.objectContaining({ taskId: "agent-unknown", status: "running" })],
			}),
		);
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

		const latest = projectAgentConversation("run-0", "agent-0", history, 321, {
			limit: 4,
		});
		expect(latest).toMatchObject({
			runId: "run-0",
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

		const older = projectAgentConversation("run-0", "agent-0", history, 321, {
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

	it("projects Cron envelopes into a bounded local session marker", () => {
		const xml =
			'<cron-fire jobId="job&amp;1" cron="*/5 * * * *" recurring="true" coalescedCount="3" stale="true">\n<prompt>\nCheck <tag> literally &amp; safely\n</prompt>\n</cron-fire>';
		const origin = {
			kind: "cron_job",
			jobId: "job&1",
			cron: "*/5 * * * *",
			recurring: true,
			coalescedCount: 3,
			stale: true,
		};
		const fromOrigin = projectCronSessionMessage("history:1", xml, origin);
		const fromXml = projectCronSessionMessage("live:1", xml);

		expect(fromOrigin).toMatchObject({
			id: "history:1",
			kind: "session",
			text: "Check <tag> literally &amp; safely",
			presentation: {
				kind: "cron",
				jobId: "job&1",
				cron: "*/5 * * * *",
				recurring: true,
				coalescedCount: 3,
				stale: true,
				prompt: "Check <tag> literally &amp; safely",
			},
		});
		expect(fromXml?.presentation).toEqual(fromOrigin?.presentation);
		expect(projectCronSessionMessage("user:1", "<cron-fire>fake</cron-fire>", { kind: "user" })).toBeUndefined();
	});

	it("uses the same Cron projection for live prompt events", () => {
		const listeners = new Map<string, (event: any) => void>();
		const eventSource = {
			on: vi.fn((name: string, listener: (event: any) => void) => {
				listeners.set(name, listener);
				return { dispose: vi.fn() };
			}),
			onError: vi.fn(() => ({ dispose: vi.fn() })),
		};
		const onMessage = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { events: eventSource },
			session: { events: eventSource },
			events: { onMessage },
		});
		(backend as unknown as { subscribe(): void }).subscribe();
		listeners.get("prompt.submitted")?.({
			promptId: "prompt-1",
			userMessageId: "message-1",
			status: "running",
			content: [
				{
					type: "text",
					text: '<cron-fire jobId="deadbeef" cron="0 9 * * *" recurring="false" coalescedCount="2" stale="false">\n<prompt>\nRun smoke tests\n</prompt>\n</cron-fire>',
				},
			],
		});

		expect(onMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "message-1",
				kind: "session",
				text: "Run smoke tests",
				presentation: expect.objectContaining({
					kind: "cron",
					jobId: "deadbeef",
					coalescedCount: 2,
					stale: false,
				}),
			}),
		);
		onMessage.mockClear();
		listeners.get("prompt.submitted")?.({
			promptId: "prompt-2",
			userMessageId: "message-2",
			status: "running",
			content: [{ type: "text", text: "ordinary user prompt" }],
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("projects steer lifecycle from Core facts without faking a reply", () => {
			const phases: string[] = [];
			const backend = new KlientChatBackend(
				{} as RuntimeConnection,
				"/workspace",
				"new",
			);
			Object.assign(backend, {
				events: { onPromptLifecycle: (_id: string, phase: string) => phases.push(phase) },
			});
			const setPromptPhase = (
				backend as unknown as { setPromptPhase(id: string, phase: string): void }
			).setPromptPhase.bind(backend);
			setPromptPhase("steer-1", "queued");
			setPromptPhase("steer-1", "consuming");
			setPromptPhase("steer-1", "started");
			expect(phases).toEqual(["queued", "consuming", "started"]);
			setPromptPhase("steer-1", "responding");
			setPromptPhase("steer-1", "completed");
			setPromptPhase("steer-1", "failed");
			expect(phases).toEqual(["queued", "consuming", "started", "responding", "completed"]);
		});

		it("keeps failed and cancelled steer outcomes distinct", () => {
			const phases: string[] = [];
			const backend = new KlientChatBackend(
				{} as RuntimeConnection,
				"/workspace",
				"new",
			);
			Object.assign(backend, {
				events: { onPromptLifecycle: (_id: string, phase: string) => phases.push(phase) },
			});
			const setPromptPhase = (
				backend as unknown as { setPromptPhase(id: string, phase: string): void }
			).setPromptPhase.bind(backend);
			setPromptPhase("failed", "queued");
			setPromptPhase("failed", "failed");
			setPromptPhase("cancelled", "queued");
			setPromptPhase("cancelled", "cancelled");
			expect(phases).toEqual(["queued", "failed", "queued", "cancelled"]);
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

	it("projects Tower missions with parallel statuses and worker details", () => {
		expect(
			projectTowerMissionPlanItems([
				{
					id: "M1",
					title: "engine",
					kind: "build",
					status: "active",
					scope: ["src/engine/**"],
					deps: [],
					tasks: [{ text: "Implement engine", done: false }],
					blockers: [],
					workers: [{ name: "builder", agentId: "agent-1", kind: "worker" }],
				},
				{
					id: "M2",
					title: "tests",
					kind: "build",
					status: "blocked",
					scope: ["test/**"],
					deps: ["M1"],
					tasks: [{ text: "Add tests", done: false }],
					blockers: ["waiting for M1"],
					workers: [],
				},
			]),
		).toEqual([
			{
				id: "tower:M1",
				label: "M1 engine · worker: builder · scope: src/engine/**",
				status: "in_progress",
				depth: 0,
				group: true,
				focused: true,
			},
			{
				id: "tower:M1:task:0",
				label: "Implement engine",
				status: "in_progress",
				depth: 1,
				focused: true,
			},
			{
				id: "tower:M2",
				label: "M2 tests · scope: test/** · deps: M1",
				status: "blocked",
				depth: 0,
				group: true,
				focused: false,
				blocker: "waiting for M1",
			},
			{
				id: "tower:M2:task:0",
				label: "Add tests",
				status: "blocked",
				depth: 1,
				focused: false,
				blocker: "waiting for M1",
			},
		]);
	});

	it("hydrates the Runtime Goal status without projecting a legacy StoredGoal", async () => {
		const onRuntimeGoalStatus = vi.fn();
		const onGoalChange = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: {
				getGoal: vi.fn().mockResolvedValue({
					goal: { status: "paused" },
				}),
			},
			events: { onRuntimeGoalStatus, onGoalChange },
		});

		await (
			backend as unknown as { publishRuntimeGoalStatus(): Promise<void> }
		).publishRuntimeGoalStatus();

		expect(onRuntimeGoalStatus).toHaveBeenCalledWith("paused");
		expect(onGoalChange).not.toHaveBeenCalled();
	});

	it("projects goal.updated status changes and clears the Runtime Goal", () => {
		const listeners = new Map<string, (event: any) => void>();
		const eventSource = {
			on: vi.fn((name: string, listener: (event: any) => void) => {
				listeners.set(name, listener);
				return { dispose: vi.fn() };
			}),
			onError: vi.fn(() => ({ dispose: vi.fn() })),
		};
		const onRuntimeGoalStatus = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { events: eventSource },
			session: { events: eventSource },
			events: { onRuntimeGoalStatus },
		});

		(backend as unknown as { subscribe(): void }).subscribe();
		listeners.get("goal.updated")?.({ snapshot: { status: "blocked" } });
		listeners.get("goal.updated")?.({ snapshot: null });

		expect(onRuntimeGoalStatus.mock.calls).toEqual([["blocked"], [undefined]]);
	});

	it("does not let delayed Goal hydration overwrite a newer goal.updated event", async () => {
		let resolveGoal!: (value: { goal: { status: "paused" } }) => void;
		const getGoal = vi.fn(
			() =>
				new Promise<{ goal: { status: "paused" } }>((resolve) => {
					resolveGoal = resolve;
				}),
		);
		const onRuntimeGoalStatus = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: { getGoal },
			events: { onRuntimeGoalStatus },
		});
		const internals = backend as unknown as {
			publishRuntimeGoalStatus(): Promise<void>;
			setRuntimeGoalStatus(status: "active", live: boolean): void;
		};

		const hydration = internals.publishRuntimeGoalStatus();
		internals.setRuntimeGoalStatus("active", true);
		resolveGoal({ goal: { status: "paused" } });
		await hydration;

		expect(onRuntimeGoalStatus.mock.calls).toEqual([["active"]]);
	});

	it("caches normalized model options across repeated reads", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
		);
		const listModels = vi.fn().mockResolvedValue([model("example", "model-1")]);
		const listProviders = vi.fn().mockResolvedValue([provider("example")]);
		const connection = {
			klient: {
				global: {
					kosong: {
						listModels,
						listProviders,
						queryAvailableModels: vi.fn().mockResolvedValue({
							providerId: "example",
							modelIds: ["example/model-1"],
						}),
					},
				},
			},
		} as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, "/workspace", "new");

		await backend.getModelOptions();
		await backend.getModelOptions();

		expect(listModels).toHaveBeenCalledOnce();
		expect(listProviders).toHaveBeenCalledOnce();
	});

	it("publishes by-model cost while reusing cached model options", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
		);
		const usage = {
			byModel: {
				"example/model-1": {
					inputOther: 1_000_000,
					output: 500_000,
					inputCacheRead: 0,
					inputCacheCreation: 0,
				},
			},
			total: {
				inputOther: 1_000_000,
				output: 500_000,
				inputCacheRead: 0,
				inputCacheCreation: 0,
			},
		};
		const listModels = vi.fn().mockResolvedValue([model("example", "model-1")]);
		const listProviders = vi.fn().mockResolvedValue([provider("example")]);
		const connection = {
			klient: {
				global: {
					kosong: {
						listModels,
						listProviders,
						queryAvailableModels: vi.fn().mockResolvedValue({
							providerId: "example",
							modelIds: ["example/model-1"],
						}),
					},
				},
			},
		} as unknown as RuntimeConnection;
		const onUsage = vi.fn();
		const backend = new KlientChatBackend(connection, "/workspace", "new");
		Object.assign(backend, {
			agent: {
				getUsage: vi.fn().mockResolvedValue(usage),
				getContext: vi.fn().mockResolvedValue({ history: [], tokenCount: 100 }),
			},
			events: { onUsage },
			currentProvider: "example",
			currentModel: "model-1",
		});
		const publish = backend as unknown as { publishUsage(): Promise<void> };

		await publish.publishUsage();
		await publish.publishUsage();

		expect(onUsage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				costUsd: 2,
				costEstimateKind: "complete",
			}),
		);
		expect(listModels).toHaveBeenCalledOnce();
		expect(listProviders).toHaveBeenCalledOnce();
	});

	it("matches the full VSPLab alias to its exact official price during usage projection", async () => {
		const alias = "vsplab/gpt-5.6-sol";
		const price: RuntimeModelOption["price"] = { inputUsdPerMillion: 2, outputUsdPerMillion: 4, source: "official" };
		const onUsage = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, {
			agent: {
				getUsage: vi.fn().mockResolvedValue({
					byModel: {
						[alias]: {
							inputOther: 1_000_000,
							output: 500_000,
							inputCacheRead: 0,
							inputCacheCreation: 0,
						},
					},
					total: {
						inputOther: 1_000_000,
						output: 500_000,
						inputCacheRead: 0,
						inputCacheCreation: 0,
					},
				}),
				getContext: vi.fn().mockResolvedValue({ history: [], tokenCount: 100 }),
			},
			events: { onUsage },
			currentProvider: "vsplab",
			currentModel: "gpt-5.6-sol",
			modelOptionsPromise: Promise.resolve([pricedModel(alias, price)]),
		});

		await (
			backend as unknown as { publishUsage(): Promise<void> }
		).publishUsage();

		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				costUsd: 4,
				costEstimateKind: "complete",
			}),
		);
	});

	it("calculates one model cost with explicit cache prices", () => {
		const estimate = calculateUsageCost(
			{
				"openai/gpt-5": {
					inputOther: 1_000_000,
					output: 500_000,
					inputCacheRead: 250_000,
					inputCacheCreation: 100_000,
				},
			},
			[
				pricedModel("openai/gpt-5", {
					inputUsdPerMillion: 2,
					outputUsdPerMillion: 6,
					cacheReadUsdPerMillion: 0.5,
					cacheWriteUsdPerMillion: 2.5,
				}),
			],
		);

		expect(estimate).toEqual({ costUsd: 5.375, kind: "complete" });
	});

	it("accumulates each model alias separately across model switches", () => {
		const estimate = calculateUsageCost(
			{
				"openai/gpt-5": {
					inputOther: 1_000_000,
					output: 500_000,
					inputCacheRead: 0,
					inputCacheCreation: 0,
				},
				"anthropic/claude-sonnet-4": {
					inputOther: 1_000_000,
					output: 1_000_000,
					inputCacheRead: 0,
					inputCacheCreation: 0,
				},
			},
			[
				pricedModel("openai/gpt-5", {
					inputUsdPerMillion: 2,
					outputUsdPerMillion: 6,
				}),
				pricedModel("anthropic/claude-sonnet-4", {
					inputUsdPerMillion: 1,
					outputUsdPerMillion: 1,
				}),
			],
		);

		expect(estimate).toEqual({ costUsd: 7, kind: "complete" });
	});

	it("calculates Kimi official pricing for USD and CNY conversion", () => {
			const estimate = calculateUsageCost(
				{
					"vsplab/kimi-k2.7-code": {
						inputOther: 1_000_000,
						output: 500_000,
						inputCacheRead: 1_000_000,
						inputCacheCreation: 0,
					},
				},
				[
					pricedModel("vsplab/kimi-k2.7-code", {
						inputUsdPerMillion: 0.95,
						outputUsdPerMillion: 4,
						cacheReadUsdPerMillion: 0.19,
					}),
				],
			);

			expect(estimate).toEqual({ costUsd: 3.14, kind: "complete" });
			expect(estimate.costUsd === null ? null : estimate.costUsd * 7.2).toBe(
				22.608,
			);
		});

	it("uses input price when cache prices are absent", () => {
		const estimate = calculateUsageCost(
			{
				"google/gemini-3-pro": {
					inputOther: 0,
					output: 0,
					inputCacheRead: 500_000,
					inputCacheCreation: 250_000,
				},
			},
			[
				pricedModel("google/gemini-3-pro", {
					inputUsdPerMillion: 4,
					outputUsdPerMillion: 8,
				}),
			],
		);

		expect(estimate).toEqual({ costUsd: 3, kind: "complete" });
	});

	it("uses base pricing when cumulative usage cannot identify a context tier", () => {
		const estimate = calculateUsageCost(
			{
				"anthropic/claude-sonnet-4": {
					inputOther: 2_000_000,
					output: 0,
					inputCacheRead: 0,
					inputCacheCreation: 0,
				},
			},
			[
				pricedModel("anthropic/claude-sonnet-4", {
					inputUsdPerMillion: 3,
					outputUsdPerMillion: 15,
					contextTiers: [
						{
							contextTokensAbove: 200_000,
							inputUsdPerMillion: 6,
							outputUsdPerMillion: 22.5,
						},
					],
				}),
			],
		);

		expect(estimate).toEqual({ costUsd: 6, kind: "complete" });
	});

	it("marks a mixed priced and unpriced model set as partial without a false total", () => {
		const estimate = calculateUsageCost(
			{
				"openai/gpt-5": {
					inputOther: 1_000_000,
					output: 0,
					inputCacheRead: 0,
					inputCacheCreation: 0,
				},
				"vsplab/luna": {
					inputOther: 1_000_000,
					output: 0,
					inputCacheRead: 0,
					inputCacheCreation: 0,
				},
			},
			[
				pricedModel("openai/gpt-5", {
					inputUsdPerMillion: 2,
					outputUsdPerMillion: 6,
				}),
				pricedModel("vsplab/luna", {}),
			],
		);

		expect(estimate).toEqual({ costUsd: null, kind: "partial" });
	});

	it("distinguishes explicit free pricing from missing pricing", () => {
		const usage = {
			inputOther: 1_000_000,
			output: 1_000_000,
			inputCacheRead: 0,
			inputCacheCreation: 0,
		};

		expect(
			calculateUsageCost(
				{ "example/free": usage },
				[
					pricedModel("example/free", {
						inputUsdPerMillion: 0,
						outputUsdPerMillion: 0,
					}),
				],
			),
		).toEqual({ costUsd: 0, kind: "complete" });
		expect(
			calculateUsageCost(
				{ "example/unknown": usage },
				[pricedModel("example/unknown", {})],
			),
		).toEqual({ costUsd: null, kind: "unknown" });
	});

	it("calculates zero-token usage as zero only when the model price is known", () => {
		const usage = {
			inputOther: 0,
			output: 0,
			inputCacheRead: 0,
			inputCacheCreation: 0,
		};

		expect(
			calculateUsageCost(
				{ "example/free": usage },
				[
					pricedModel("example/free", {
						inputUsdPerMillion: 0,
						outputUsdPerMillion: 0,
					}),
				],
			),
		).toEqual({ costUsd: 0, kind: "complete" });
		expect(
			calculateUsageCost(
				{ "example/unknown": usage },
				[pricedModel("example/unknown", {})],
			),
		).toEqual({ costUsd: null, kind: "unknown" });
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

	it("detaches every live foreground task from a real task query", async () => {
		const getTasks = vi.fn().mockResolvedValueOnce([
			{
				kind: "agent",
				taskId: "agent-1",
				description: "foreground agent",
				status: "running",
				detached: false,
				startedAt: 1,
				endedAt: null,
			},
			{
				kind: "process",
				taskId: "process-detached",
				description: "background process",
				status: "running",
				detached: true,
				startedAt: 2,
				endedAt: null,
				command: "sleep 1",
				pid: 1,
				exitCode: null,
			},
			{
				kind: "question",
				taskId: "question-done",
				description: "done question",
				status: "completed",
				detached: false,
				startedAt: 3,
				endedAt: 4,
				questionCount: 1,
			},
		]).mockResolvedValueOnce([]);
		const detachTask = vi.fn(async () => undefined);
		const stopTask = vi.fn();
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, { agent: { getTasks, detachTask, stopTask } });

		await expect(backend.detachForegroundTasks()).resolves.toBe(1);

		expect(getTasks).toHaveBeenNthCalledWith(1, {
			activeOnly: true,
			limit: 100,
		});
		expect(getTasks).toHaveBeenNthCalledWith(2, {
			activeOnly: false,
			limit: 100,
		});
		expect(detachTask).toHaveBeenCalledOnce();
		expect(detachTask).toHaveBeenCalledWith({ taskId: "agent-1" });
		expect(stopTask).not.toHaveBeenCalled();
	});

	it("does not report a detach after a task operation fails", async () => {
		const error = new Error("detach failed");
		const getTasks = vi.fn().mockResolvedValue([
			{
				kind: "agent",
				taskId: "agent-1",
				description: "foreground agent",
				status: "running",
				detached: false,
				startedAt: 1,
				endedAt: null,
			},
		]);
		const detachTask = vi.fn().mockRejectedValue(error);
		const backend = new KlientChatBackend(
			{} as RuntimeConnection,
			"/workspace",
			"new",
		);
		Object.assign(backend, { agent: { getTasks, detachTask } });

		await expect(backend.detachForegroundTasks()).rejects.toBe(error);
		expect(detachTask).toHaveBeenCalledWith({ taskId: "agent-1" });
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

	it("uses the effective Core price and capability projection without a second catalog", async () => {
	 const listed = { ...model("example", "reasoner"), pricing_source: "official", capabilities: ["image_in"] };
	 const connection = { klient: { global: { kosong: {
	 listModels: async () => [listed], listProviders: async () => [provider("example")],
	 getProvider: async () => provider("example"), queryAvailableModels: async () => ({ modelIds: [listed.model] }),
	 } } } } as unknown as RuntimeConnection;
	 const backend = new KlientChatBackend(connection, "/workspace", "new");
	 expect(await backend.getModelOptions()).toMatchObject([{ alias: "example/reasoner", vision: true, price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: "official" } }]);
	});
});
