/**
 * Scenario: the daemon-backed build preserves the accepted VSPi presentation primitives.
 * Responsibilities: splash identity, user surface width, assistant markdown, status chrome.
 * Wiring: original VSPi renderers with literal messages and no runtime stubs.
 * Run: pnpm -C apps/vspi test
 */
import { stripTerminalSequences, visibleWidth } from "@moonshot-ai/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentRunSnapshot,
	AgentSnapshot,
} from "../src/v1/agents/types.js";
import {
	reduceCompactionActivity,
	VspiApp,
} from "../src/v1/app/vspi-app.js";
import { resolveCommand } from "../src/v1/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/v1/domain/defaults.js";
import type { TranscriptMessage } from "../src/v1/domain/types.js";
import { AgentsDock } from "../src/v1/ui/agents-dock.js";
import {
	renderActivityRail,
	renderQueuedMessage,
} from "../src/v1/ui/activity.js";
import { detectTerminalCapabilities } from "../src/v1/ui/capabilities.js";
import { Composer } from "../src/v1/ui/composer.js";
import { renderMarkdown, VspiMarkdown } from "../src/v1/ui/markdown.js";
import {
	PanelController,
	sessionsSurfaceRowLimit,
} from "../src/v1/ui/panels.js";
import { renderSplash } from "../src/v1/ui/splash.js";
import {
	appendRuntimeStatus,
	renderRuntimeStatus,
	renderStatusLines,
} from "../src/v1/ui/status.js";
import { TerminalFrameOptimizer } from "../src/v1/ui/terminal-frame-optimizer.js";
import { createTheme } from "../src/v1/ui/theme.js";
import { renderTranscript } from "../src/v1/ui/transcript.js";

function panelsAgentSnapshot(run: AgentRunSnapshot): AgentSnapshot {
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
		active: [run],
		recent: [],
		teammates: [],
		authority: {
			pendingRequired: [],
			turnOverrides: [],
			sessionOverrides: [],
			taskEpoch: 0,
		},
	};
}

describe("VSPi TUI presentation (preserved frontend identity)", () => {
	const capabilities = detectTerminalCapabilities({
		TERM: "xterm-256color",
		LANG: "zh_CN.UTF-8",
	});
	const theme = createTheme(capabilities, "VSPi Dark");

	it("renders the original VSPi splash without exposing the backend implementation brand", () => {
		const output = renderSplash(80, theme, 1, {
			model: "GLM-4.7",
			backend: "VSP Runtime",
			policy: "Auto",
			boundary: "Host",
			version: "2.0.0",
		})
			.map(stripTerminalSequences)
			.join("\n");

		expect(output).toContain("VSPi");
		expect(output).not.toContain("Kimi");
		expect(output).not.toContain("Backend");
		expect(output).not.toContain("VSP Runtime");
	});

	it("caps the Sessions surface at 80 percent of the available height", () => {
		expect(sessionsSurfaceRowLimit(40)).toBe(32);
		expect(sessionsSurfaceRowLimit(23)).toBe(18);
		expect(sessionsSurfaceRowLimit(3)).toBe(3);
	});

	it("offers exit title summarization as an opt-in setting", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.open("settings");
		const panelState = panels as unknown as { state: { selected: number } };
		let output = panels
			.render(80, 30, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");

		expect(output).toContain("退出时 AI 总结标题  关");
		panelState.state.selected = 7;
		panels.handleInput(" ");
		output = panels
			.render(80, 30, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(output).toContain("退出时 AI 总结标题  开");
	});

	it("shows provider-specific and fixed effort values safely", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.openEffort("provider-ultra", ["provider-ultra"]);
		const output = panels
			.render(80, 20, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");

		expect(output).toContain("provider-ultra");
		expect(output).toContain("当前模型固定使用此 Effort");
	});

	it("labels queued activity and respects queued-message motion phases", () => {
		const rail = stripTerminalSequences(
			renderActivityRail(
				{
					indicator: "●",
					label: "Working",
					elapsedSeconds: 4,
					steering: 2,
					followUp: 1,
				},
				80,
				theme,
			),
		);
		expect(rail).toContain("Working");
		expect(rail).toContain("Steer 2");
		expect(rail).toContain("Follow-up 1");

		const steer = {
			id: "queued-steer",
			role: "user",
			kind: "text",
			text: "Inspect changes",
			delivery: "steer",
		} satisfies TranscriptMessage;
		const entering0 = stripTerminalSequences(
			renderQueuedMessage(steer, 80, theme, {
				phase: "entering",
				frame: 0,
				reducedMotion: false,
			}),
		);
		const entering1 = stripTerminalSequences(
			renderQueuedMessage(steer, 80, theme, {
				phase: "entering",
				frame: 1,
				reducedMotion: false,
			}),
		);
		expect(entering0).toContain("Steer");
		expect(entering1).toContain("Steer");
		expect(entering0).not.toBe(entering1);
		expect(
			stripTerminalSequences(
				renderQueuedMessage(steer, 80, theme, {
					phase: "settling",
					frame: 0,
					reducedMotion: false,
				}),
			),
		).toContain("✓");

		const reduced0 = renderQueuedMessage(steer, 80, theme, {
			phase: "entering",
			frame: 0,
			reducedMotion: true,
		});
		const reduced1 = renderQueuedMessage(steer, 80, theme, {
			phase: "entering",
			frame: 1,
			reducedMotion: true,
		});
		expect(reduced0).toBe(reduced1);
		expect(
			stripTerminalSequences(
				renderQueuedMessage(
					{ ...steer, id: "queued-follow-up", delivery: "followUp" },
					80,
					theme,
					{ phase: "stable", frame: 0, reducedMotion: false },
				),
			),
		).toContain("Follow-up");
	});

	it("projects compaction state only from trusted lifecycle events", () => {
		const started = reduceCompactionActivity(undefined, {
			type: "started",
			trigger: "manual",
			startedAt: 1_000,
		});
		expect(started).toEqual({
			status: "active",
			trigger: "manual",
			startedAt: 1_000,
		});
		expect(
			reduceCompactionActivity(undefined, { type: "blocked", turnId: 9 }),
		).toBeUndefined();
		expect(
			reduceCompactionActivity(started, { type: "blocked", turnId: 9 }),
		).toEqual({
			status: "blocked",
			trigger: "manual",
			startedAt: 1_000,
			turnId: 9,
		});
		const result = {
			summary: "summary",
			compactedCount: 5,
			tokensBefore: 8_000,
			tokensAfter: 900,
		};
		expect(
			reduceCompactionActivity(started, { type: "completed", result }),
		).toEqual({ status: "completed", result });
		expect(
			reduceCompactionActivity(started, { type: "cancelled" }),
		).toEqual({ status: "cancelled" });
	});

	it("renders Compacting context with elapsed in activity styles 1, 2, and 3", () => {
		const rail = stripTerminalSequences(
			renderActivityRail(
				{
					indicator: "■",
					label: "Compacting context",
					elapsedSeconds: 65,
					steering: 0,
					followUp: 0,
				},
				80,
				theme,
			),
		);
		expect(rail).toContain("Compacting context");
		expect(rail).toContain("01:05");

		const composer = Object.assign(Object.create(Composer.prototype), { theme }) as {
			workingLabel(activity: {
				style: 2 | 3;
				frame: number;
				label: string;
				elapsedSeconds: number;
				reducedMotion: boolean;
			}): string;
		};
		for (const style of [2, 3] as const) {
			const label = stripTerminalSequences(
				composer.workingLabel({
					style,
					frame: 0,
					label: "Compacting context",
					elapsedSeconds: 65,
					reducedMotion: true,
				}),
			);
			expect(label).toContain("Compacting context");
			expect(label).toContain("01:05");
		}
	});

	it("prioritizes compaction and restores Working after overlap ends", () => {
		const app = Object.assign(Object.create(VspiApp.prototype), {
			compaction: {
				status: "active",
				trigger: "auto",
				startedAt: 1_000,
			},
			workingStartedAt: 500,
		}) as {
			compaction: unknown;
			activityLabel(): string;
			activityElapsedSeconds(): number;
		};
		expect(app.activityLabel()).toBe("Compacting context");
		app.compaction = {
			status: "completed",
			result: {
				summary: "summary",
				compactedCount: 1,
				tokensBefore: 100,
				tokensAfter: 20,
			},
		};
		expect(app.activityLabel()).toBe("Working");
	});

	it("refreshes reduced-motion elapsed without deltas and stops after completion", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const app = Object.assign(Object.create(VspiApp.prototype), {
				compaction: {
					status: "active",
					trigger: "auto",
					startedAt: Date.now(),
				},
				runActive: false,
				busy: false,
				queueState: { steering: 0, followUp: 0 },
				queuedPresentations: new Map(),
				activityPresentationActive: false,
				workingStartedAt: undefined,
				workingTimer: undefined,
				workingTimerInterval: undefined,
				workingFrame: 0,
				queuedAnimationTick: 0,
				options: { settings: { reducedMotion: true, workingStyle: 1 } },
				renderReady: false,
				requestRender,
				scheduleStableTranscriptCommit: vi.fn(),
			}) as {
				compaction: unknown;
				workingTimer: NodeJS.Timeout | undefined;
				workingTimerInterval: number | undefined;
				syncActivityPresentation(): void;
			};

			app.syncActivityPresentation();
			expect(app.workingTimerInterval).toBe(1_000);
			const before = requestRender.mock.calls.length;
			vi.advanceTimersByTime(1_000);
			expect(requestRender.mock.calls.length).toBeGreaterThan(before);
			app.compaction = { status: "cancelled" };
			app.syncActivityPresentation();
			expect(app.workingTimer).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears compaction state during session reset", () => {
		const app = Object.assign(Object.create(VspiApp.prototype), {
			sessionEpoch: 0,
			compaction: {
				status: "blocked",
				trigger: "manual",
				startedAt: 1_000,
			},
			cancelPendingQuestion: vi.fn(),
			cancelPendingApproval: vi.fn(),
			activeSubmission: undefined,
			committedMessageCount: 1,
			activityPresentationActive: true,
			waterfallSettling: false,
			stableCommitTimer: undefined,
			messages: [],
			thinkingTranslationRevision: 0,
			thinkingTranslationAbort: undefined,
			translatedThinkingSources: new Map(),
			transcriptRenderCache: { clear: vi.fn() },
			usage: DEFAULT_USAGE,
			panels: { setGoalSnapshot: vi.fn() },
			backend: { modelLabel: "Example" },
			queueState: { steering: 0, followUp: 0 },
			queuedPresentations: new Map(),
			queuedAnimationTick: 0,
			runActive: false,
			setBusy: vi.fn(),
			composer: { restoreDraft: vi.fn() },
			renderReady: false,
			requestRender: vi.fn(),
		}) as {
			compaction: unknown;
			resetSessionState(): number;
		};

		expect(app.resetSessionState()).toBe(1);
		expect(app.compaction).toBeUndefined();
	});

	it("closes the Agent conversation without cancelling the run or task", async () => {
		const disposeAgentConversation = vi.fn();
		const cancel = vi.fn();
		const stopAgentTask = vi.fn();
		const app = Object.assign(Object.create(VspiApp.prototype), {
			disposeAgentConversation,
			backend: { cancel, stopAgentTask },
		}) as {
			applyPanelEvent(event: { type: "agentConversationClose" }): Promise<void>;
		};

		await app.applyPanelEvent({ type: "agentConversationClose" });

		expect(disposeAgentConversation).toHaveBeenCalledOnce();
		expect(cancel).not.toHaveBeenCalled();
		expect(stopAgentTask).not.toHaveBeenCalled();
	});

	it("handles Ctrl+B before the active surface consumes editor input", () => {
		const detachForegroundTask = vi.fn();
		const app = Object.assign(Object.create(VspiApp.prototype), {
			fullscreenRenderRevision: 0,
			detachForegroundTask,
		}) as { handleInput(data: string): void };

		app.handleInput("\u0002");

		expect(detachForegroundTask).toHaveBeenCalledOnce();
	});

	it("prefers live foreground detach and reports the detached count", async () => {
		const detachForegroundTasks = vi.fn(async () => 2);
		const detachAgentTask = vi.fn();
		const cancel = vi.fn();
		const showNotice = vi.fn();
		const app = Object.assign(Object.create(VspiApp.prototype), {
			backend: { cancel, detachForegroundTasks, detachAgentTask },
			showNotice,
		}) as { detachForegroundTask(): Promise<void> };

		await app.detachForegroundTask();

		expect(detachForegroundTasks).toHaveBeenCalledOnce();
		expect(detachAgentTask).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
		expect(showNotice).toHaveBeenCalledWith("已转入后台 2 个任务", "success");
	});

	it("keeps queued steer in the dock until consuming", () => {
		const queued = {
			id: "queued-steer",
			role: "user",
			kind: "text",
			text: "Inspect changes",
			delivery: "steer",
		} satisfies TranscriptMessage;
		const app = Object.assign(Object.create(VspiApp.prototype), {
			queuedMessages: new Map([[queued.id, queued]]),
			queuedPresentations: new Map(),
			messages: [
				{ id: "user-1", role: "user", kind: "text", text: "Earlier" },
			],
			options: { settings: { reducedMotion: false } },
			queuedAnimationTick: 0,
			syncActivityPresentation: vi.fn(),
			requestRender: vi.fn(),
		}) as {
			queuedMessages: Map<string, TranscriptMessage>;
			queuedPresentations: Map<string, { phase: string; startedTick: number }>;
			messages: TranscriptMessage[];
			queueMessagePresentation(id: string): void;
			settleQueuedMessage(id: string): void;
		};

		app.queueMessagePresentation(queued.id);
		expect(app.messages.map((message) => message.id)).toEqual(["user-1"]);
		expect(app.queuedPresentations.get(queued.id)?.phase).toBe("stable");

		app.settleQueuedMessage(queued.id);
		expect(app.messages.map((message) => message.id)).toEqual([
			"user-1",
			"queued-steer",
		]);
		expect(app.queuedMessages.has(queued.id)).toBe(false);
		expect(app.queuedPresentations.get(queued.id)?.phase).toBe("settling");
	});

	it("detaches the newest foreground task without cancelling it", async () => {
		const detachAgentTask = vi.fn(async () => undefined);
		const cancel = vi.fn();
		const showNotice = vi.fn();
		const app = Object.assign(Object.create(VspiApp.prototype), {
			backend: { cancel, detachAgentTask },
			showNotice,
			taskSnapshot: {
				agents: [
					{
						kind: "agent",
						taskId: "agent-older",
						description: "agent",
						status: "running",
						detached: false,
						startedAt: 100,
						endedAt: null,
					},
				],
				processes: [
					{
						kind: "process",
						taskId: "process-newer",
						description: "process",
						status: "running",
						detached: false,
						startedAt: 200,
						endedAt: null,
						command: "pnpm test",
						pid: 42,
						exitCode: null,
					},
				],
				questions: [],
			},
		}) as { detachForegroundTask(): Promise<void> };

		await app.detachForegroundTask();

		expect(detachAgentTask).toHaveBeenCalledWith("process-newer");
		expect(cancel).not.toHaveBeenCalled();
		expect(showNotice).toHaveBeenCalledWith("已转入后台", "success");
	});

	it("fills the available width when a user message is rendered", () => {
		const messages: TranscriptMessage[] = [
			{ id: "user-1", role: "user", kind: "text", text: "检查当前改动" },
		];

		const rows = renderTranscript(messages, 80, theme);

		expect(rows).toHaveLength(3);
		expect(rows.map((row) => visibleWidth(row))).toEqual([80, 80, 80]);
		expect(rows.map(stripTerminalSequences).join("\n")).toContain(
			"检查当前改动",
		);
	});

	it("keeps live subagent updates out of the chronological transcript", () => {
		const messages: TranscriptMessage[] = [
			{
				id: "subagent:1",
				role: "assistant",
				kind: "subagent",
				model: "example-model",
				effort: "medium",
				contextMode: "isolated",
				task: "Inspect the repository",
				status: "success",
				agentKind: "task",
				outputPreview: "first line\n5. escaped line\n6. another line",
			},
		];

		const rows = renderTranscript(messages, 60, theme);
		expect(rows).toEqual([]);
	});

	it("renders Cron markers as literal readable prompt blocks", () => {
		const messages: TranscriptMessage[] = [
			{
				id: "cron-1",
				role: "assistant",
				kind: "session",
				text: "check the deploy",
				presentation: {
					kind: "cron",
					jobId: "deadbeef",
					cron: "*/5 * * * *",
					recurring: true,
					coalescedCount: 3,
					stale: true,
					prompt: "check the deploy",
				},
			},
		];
		const output = renderTranscript(messages, 80, theme)
			.map(stripTerminalSequences)
			.join("\n");

		expect(output).toContain("◇ Cron · deadbeef · cron */5 * * * *");
		expect(output).toContain("coalesced 3 · stale");
		expect(output).toContain("check the deploy");
		expect(output).not.toContain("<cron-fire>");
		expect(output).not.toContain("<prompt>");
	});

	it("keeps ordinary user XML-like text in the user surface", () => {
		const output = renderTranscript(
			[{ id: "user-xml", role: "user", kind: "text", text: "<prompt>keep</prompt>" }],
			80,
			theme,
		)
			.map(stripTerminalSequences)
			.join("\n");
		expect(output).toContain("<prompt>keep</prompt>");
	});

	it("renders assistant markdown through the original transcript renderer", () => {
		const messages: TranscriptMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				kind: "text",
				text: "## 结果\n\n已完成。",
			},
		];

		const output = renderTranscript(messages, 80, theme)
			.map(stripTerminalSequences)
			.join("\n");

		expect(output).toContain("结果");
		expect(output).toContain("已完成。");
	});

	it("uses spaced section markers and separates thinking from tool calls", () => {
		const messages: TranscriptMessage[] = [
			{
				id: "thinking-1",
				role: "assistant",
				kind: "thinking",
				effort: "low",
				text: "分析",
				collapsed: true,
			},
			{
				id: "tool-1",
				role: "assistant",
				kind: "tool",
				name: "ReadFile",
				summary: "读取",
				status: "success",
				expanded: false,
			},
		];

		const output = renderTranscript(messages, 80, theme, {
			thinkingDisplay: "collapsed",
		}).map(stripTerminalSequences);
		expect(output[0]).toContain("◇  思考 · Effort Low");
		expect(output[1]?.trimEnd()).toBe("   分析");
		expect(output).toContain("");
		expect(output.find((line) => line.includes("工具调用"))).toContain(
			"◇  工具调用",
		);
	});

	it("renders collapsed thinking preview as dimmed markdown with three-column indentation", () => {
		const messages: TranscriptMessage[] = [
			{
				id: "thinking-markdown",
				role: "assistant",
				kind: "thinking",
				effort: "high",
				text: "**Clarifying bug fix intent**",
				collapsed: true,
			},
		];

		const rows = renderTranscript(messages, 80, theme, {
			thinkingDisplay: "collapsed",
		});

		expect(stripTerminalSequences(rows[1] ?? "").trimEnd()).toBe(
			"   Clarifying bug fix intent",
		);
		expect(rows[1]).toContain("\u001b[1m");
	});

	it("separates adjacent thinking bold spans without changing code or default markdown", () => {
		const source = "**A****B**\n\\**C****D**\n`**E****F**`\n```md\n**G****H**\n```\nfoo****bar";
		const thinking = renderMarkdown(source, 80, theme, {
			tone: "thinking",
		}).map(stripTerminalSequences);
		const normal = renderMarkdown("**A****B**", 80, theme).map(
			stripTerminalSequences,
		);
		expect(thinking.filter((line) => line.trim() === "A")).toHaveLength(1);
		expect(thinking.filter((line) => line.trim() === "B")).toHaveLength(1);
		expect(thinking.some((line) => line.trim() === "*C*D")).toBe(true);
		expect(thinking.some((line) => line.trim() === "C")).toBe(false);
		expect(thinking.some((line) => line.trim() === "D")).toBe(false);
		expect(thinking.join("\n")).toContain("**E****F**");
		expect(thinking.join("\n")).toContain("**G****H**");
		expect(thinking.join("\n")).toContain("foo****bar");
		expect(normal.some((line) => line.trim() === "A")).toBe(false);
		expect(normal.some((line) => line.trim() === "B")).toBe(false);

		const markdown = new VspiMarkdown("**First****Second**", theme, 0, {
			tone: "thinking",
		});
		expect(markdown.render(80).map(stripTerminalSequences).join("\n")).toContain(
			"Second",
		);
		markdown.setText("**Third****Fourth**");
		const updated = markdown.render(80).map(stripTerminalSequences).join("\n");
		expect(updated).toContain("Third");
		expect(updated).toContain("Fourth");
	});

	it("keeps fullscreen row frames lossless when similar panel rows move", () => {
		const optimizer = new TerminalFrameOptimizer();
		const begin = "\u001b[?2026h";
		const end = "\u001b[?2026l";
		const cursor = "\u001b[10;1H\u001b[?25h";
		const frame = (lines: readonly string[], fullRedraw = false) =>
			`${begin}${fullRedraw ? "\u001b[2J" : ""}${lines
				.map((line, index) => `\u001b[${index + 1};1H\u001b[2K${line}`)
				.join("")}${cursor}${end}`;
		const initial = `${begin}\u001b[?1049h\u001b[2J${Array.from(
			{ length: 10 },
			(_, index) => `\u001b[${index + 1};1H\u001b[2Kpanel-${String(index)}`,
		).join("")}${cursor}${end}`;
		optimizer.optimize(initial, 10, 80);
		const moved = frame([
			...Array.from({ length: 9 }, (_, index) => `panel-${String(index + 1)}`),
			"composer",
		]);

		expect(optimizer.optimize(moved, 10, 80)).toBe(moved);
	});

	it("keeps agents and tasks as separate canonical commands", () => {
		expect(resolveCommand("/tasks")?.id).toBe("tasks");
		expect(resolveCommand("/agents")?.id).toBe("agents");
		expect(resolveCommand("/subagents")?.id).toBe("agents");
	});

	it("keeps tool calls between the transcript segments that surround them", () => {
		const messages: TranscriptMessage[] = [
			{ id: "assistant:7", role: "assistant", kind: "text", text: "调用前" },
			{
				id: "tool-7",
				role: "assistant",
				kind: "tool",
				name: "ReadFile",
				summary: "读取",
				status: "success",
				expanded: false,
			},
			{ id: "assistant:7:1", role: "assistant", kind: "text", text: "调用后" },
		];
		const output = renderTranscript(messages, 80, theme)
			.map(stripTerminalSequences)
			.join("\n");

		expect(output.indexOf("调用前")).toBeLessThan(output.indexOf("工具调用"));
		expect(output.indexOf("工具调用")).toBeLessThan(output.indexOf("调用后"));
	});

	it("hides internal plan-mode control tools from the transcript", () => {
		const messages: TranscriptMessage[] = [
			{ id: "before", role: "assistant", kind: "text", text: "准备规划" },
			{
				id: "enter-plan",
				role: "assistant",
				kind: "tool",
				name: "EnterPlanMode",
				summary: "Requesting to enter plan mode",
				status: "success",
				expanded: false,
			},
			{ id: "after", role: "assistant", kind: "text", text: "开始规划" },
		];
		const output = renderTranscript(messages, 80, theme)
			.map(stripTerminalSequences)
			.join("\n");
		expect(output).toContain("准备规划");
		expect(output).toContain("开始规划");
		expect(output).not.toContain("EnterPlanMode");
		expect(output).not.toContain("Requesting to enter plan mode");
	});

	it.each(["glm", "5.3", "flash", "vsplab"])(
		"finds GLM 5.3 Flash by %s",
		(query) => {
			const panels = new PanelController(DEFAULT_SETTINGS);
			panels.setModels([
				{
					id: "glm-5.3-flash",
					provider: "vsplab",
					brand: "VSPLab",
					label: "GLM 5.3 Flash",
					vision: false,
					efforts: ["off"],
					price: {},
				},
			]);
			const internals = panels as unknown as {
				modelSearch: string;
				filteredModelCache: undefined;
				filteredModels(): Array<{ id: string; provider: string }>;
			};
			internals.modelSearch = query;
			internals.filteredModelCache = undefined;

			expect(internals.filteredModels()).toMatchObject([
				{ id: "glm-5.3-flash", provider: "vsplab" },
			]);
		},
	);

	it("does not reset model selection when background snapshots arrive", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels(
			Array.from({ length: 20 }, (_, index) => ({
				id: `model-${String(index)}`,
				provider: "example",
				brand: "Example",
				label: `Model ${String(index)}`,
				vision: false,
				efforts: ["off"],
				price: {},
				contextWindow: 128_000,
			})),
		);
		panels.open("models");
		const panelState = panels as unknown as { state: { selected: number } };
		panelState.state.selected = 12;
		const snapshot: AgentSnapshot = {
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
			active: [],
			recent: [],
			teammates: [],
			authority: {
				pendingRequired: [],
				turnOverrides: [],
				sessionOverrides: [],
				taskEpoch: 0,
			},
		};

		panels.setAgentSnapshot(snapshot);
		panels.setCronTasks([]);

		expect(panelState.state.selected).toBe(12);
	});

	it("renders the agents browser and confirms stop before emitting an action", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const run: AgentRunSnapshot = {
			id: "task-alpha",
			agentId: "agent-0",
			treeId: "tree-0",
			kind: "task",
			depth: 1,
			model: "example/deepseek-v4-flash",
			provider: "example",
			role: "worker",
			profile: "coder",
			modelReason: "requested",
			effort: "high",
			contextMode: "isolated",
			contextChars: 128,
			task: "Inspect the selected task output",
			tools: ["ReadFile"],
			outputPreview: "TASK_OUTPUT_OK",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 1,
			},
			budget: {
				runTokensUsed: 15,
				maxRunTokens: 0,
				treeTokensUsed: 15,
				maxTreeTokens: 0,
				treeCostUsd: 0,
				maxTreeCostUsd: 0,
				maxRunSeconds: 900,
				warnRunTokens: false,
				warnTreeTokens: false,
				warnTreeCost: false,
				warnElapsed: false,
			},
			timeline: [],
			status: "running",
			background: true,
			resumed: false,
			startedAt: new Date().toISOString(),
		};
		panels.setAgentSnapshot({
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
			active: [run],
			recent: [],
			teammates: [],
			authority: {
				pendingRequired: [],
				turnOverrides: [],
				sessionOverrides: [],
				taskEpoch: 0,
			},
		});
		panels.open("agents");

		expect(panels.selectedAgentIdForPreview()).toBe("agent-0");
		panels.setAgentConversation({
			agentId: "agent-0",
			blocks: [
				{
					id: "block-thinking",
					kind: "thinking",
					sourceRole: "assistant",
					text: "HIDDEN_REASONING",
					injected: false,
				},
				{
					id: "block-commentary",
					kind: "commentary",
					sourceRole: "assistant",
					text: "CHILD_CONVERSATION_OK",
					injected: false,
					presentation: "message",
				},
				{
					id: "block-tool",
					kind: "tool",
					sourceRole: "assistant",
					text: "Modified src/example.ts",
					injected: false,
					toolCallId: "write-1",
					toolName: "Write",
					presentation: "change",
				},
				{
					id: "block-error",
					kind: "error",
					sourceRole: "tool",
					text: "Write failed",
					injected: false,
					toolCallId: "write-1",
					toolName: "Write",
					presentation: "error",
				},
				{
					id: "block-final",
					kind: "final",
					sourceRole: "assistant",
					text: "FINAL_RESULT_OK",
					injected: false,
					presentation: "message",
				},
			],
			tokenCount: 12,
			totalBlocks: 4,
		});
		panels.appendAgentActivity({
			kind: "assistant",
			turnId: 1,
			delta: "CHILD_CONVERSATION_OK",
		});
		panels.appendAgentActivity({
			kind: "thinking",
			turnId: 1,
			delta: "LIVE_HIDDEN_REASONING",
		});
		panels.appendAgentActivity({
			kind: "tool",
			state: "completed",
			turnId: 1,
			toolCallId: "write-1",
			toolName: "Write",
			text: "duplicate result",
		});
		const output = panels
			.render(100, 18, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(output).toContain("Agents");
		expect(output).toContain("1 active");
		expect(output).toContain("▶ ● agent-0");
		expect(output).toContain("当前选择 · agent-0");
		expect(output).toContain("● Commentary");
		expect(output.match(/◇ Write/gu)).toHaveLength(1);
		expect(output).toContain("Write failed");
		expect(output).toContain("◆ Final");
		expect(output.match(/CHILD_CONVERSATION_OK/gu)).toHaveLength(1);
		expect(output).not.toContain("Preview Output");
		expect(output).not.toContain("TASK_OUTPUT_OK");
		expect(output).not.toContain("HIDDEN_REASONING");
		expect(output).not.toContain("duplicate result");
		expect(panels.handleInput("S")).toBeUndefined();
		expect(stripTerminalSequences(panels.renderHint(100, theme))).toContain(
			"Y 确认",
		);
		expect(panels.handleInput("Y")).toEqual({
			type: "agentStop",
			taskId: "task-alpha",
		});
		expect(panels.handleInput("\r")).toEqual({
			type: "agentOpen",
			agentId: "agent-0",
		});
		panels.setAgentConversation({
			agentId: "agent-0",
			blocks: Array.from({ length: 12 }, (_, index) => ({
				id: `commentary-${String(index)}`,
				kind: "commentary" as const,
				sourceRole: "assistant" as const,
				text: `PROCESS_LINE_${String(index)}`,
				injected: false,
				presentation: "message" as const,
			})),
			tokenCount: 12,
			totalBlocks: 12,
		});
		const detailState = panels as unknown as {
			agentConversation: unknown;
			agentConversationLoading: boolean;
			agentActivity: unknown[];
			agentDetailFollowTail: boolean;
			state: { selected: number; scroll: number };
		};
		panels.render(42, 10, theme, DEFAULT_USAGE);
		const tailScroll = detailState.state.scroll;
		expect(tailScroll).toBeGreaterThan(0);
		expect(detailState.agentDetailFollowTail).toBe(true);
		panels.handleInput("\u001b[A");
		const lockedScroll = detailState.state.scroll;
		expect(lockedScroll).toBe(tailScroll - 1);
		expect(detailState.agentDetailFollowTail).toBe(false);
		panels.appendAgentActivity({
			kind: "assistant",
			turnId: 2,
			delta: "LIVE_COMMENTARY",
		});
		const locked = panels
			.render(42, 10, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(detailState.state.scroll).toBe(lockedScroll);
		expect(locked).not.toContain("LIVE_COMMENTARY");
		panels.handleInput("\u001b[6~");
		const followed = panels
			.render(42, 10, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(detailState.agentDetailFollowTail).toBe(true);
		expect(followed).toContain("LIVE_COMMENTARY");
		const beforeTab = { ...detailState.state };
		expect(panels.handleInput("\t")).toBeUndefined();
		expect(detailState.state).toEqual(beforeTab);
		const detailHint = stripTerminalSequences(panels.renderHint(42, theme));
		expect(detailHint).toContain("←→ 切换 Agent");
		expect(detailHint).toContain("↑↓/PgUp/PgDn 滚动");
		expect(detailHint).not.toContain("Tab");

		panels.setAgentSnapshot({
			...panelsAgentSnapshot(run),
			active: [
				run,
				{ ...run, id: "task-beta", agentId: "agent-1", task: "Second task" },
			],
		});
		expect(panels.handleInput("\u001b[C")).toEqual({
			type: "agentOpen",
			agentId: "agent-1",
		});
		expect(detailState.agentConversation).toBeUndefined();
		expect(detailState.agentConversationLoading).toBe(true);
		expect(detailState.agentActivity).toEqual([]);
		expect(detailState.agentDetailFollowTail).toBe(true);
		expect(detailState.state).toMatchObject({ selected: 1, scroll: 0 });
		expect(panels.handleInput("\u001b[C")).toBeUndefined();
		expect(panels.handleInput("\u001b[D")).toEqual({
			type: "agentOpen",
			agentId: "agent-0",
		});
		expect(panels.handleInput("\u001b")).toEqual({
			type: "agentConversationClose",
		});
		expect(panels.handleInput("\u001b")).toEqual({ type: "close" });

		const dock = new AgentsDock();
		dock.setSnapshot({
			...panelsAgentSnapshot(run),
			active: Array.from({ length: 5 }, (_, index) => ({
				...run,
				id: `task-${String(index)}`,
				agentId: `agent-${String(index)}`,
				profile: `agent-${String(index)}`,
				codename: index === 0 ? "图灵" : `人物${String(index)}`,
				taskTitle: index === 0 ? "分析任务投影" : `任务${String(index)}`,
				parentToolCallId: "swarm-tool",
			})),
		});
		const dockOutput = stripTerminalSequences(
			dock.render(120, theme).join("\n"),
		);
		expect(dockOutput).toContain("Agents");
		expect(dockOutput).toContain("图灵 · 分析任务投影");
		expect(dockOutput).toContain("+1");
		expect(dockOutput).not.toContain("agent-4");

		const elapsedDock = new AgentsDock();
		const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
		const elapsedRun = {
			...run,
			startedAt: new Date(startedAt).toISOString(),
		};
		elapsedDock.setSnapshot(panelsAgentSnapshot(elapsedRun));
		const atTenSeconds = stripTerminalSequences(
			elapsedDock.render(120, theme, startedAt + 10_000).join("\n"),
		);
		const atElevenSeconds = stripTerminalSequences(
			elapsedDock.render(120, theme, startedAt + 11_000).join("\n"),
		);
		expect(atTenSeconds).toContain("10s");
		expect(atElevenSeconds).toContain("11s");
		elapsedDock.setSnapshot({
			...panelsAgentSnapshot(elapsedRun),
			active: [],
			recent: [
				{
					...elapsedRun,
					status: "success",
					finishedAt: new Date(startedAt + 10_000).toISOString(),
				},
			],
		});
		const finishedLater = stripTerminalSequences(
			elapsedDock.render(120, theme, startedAt + 11_000).join("\n"),
		);
		expect(finishedLater).toContain("10s");
		expect(finishedLater).not.toContain("11s");

		dock.settle("swarm-tool");
		expect(stripTerminalSequences(dock.render(120, theme).join("\n"))).toContain(
			"5 active",
		);
		dock.setSnapshot({
			...panelsAgentSnapshot(run),
			active: [{ ...run, parentToolCallId: "swarm-tool" }],
		});
		expect(stripTerminalSequences(dock.render(120, theme).join("\n"))).toContain(
			"1 active",
		);
		dock.setSnapshot({
			...panelsAgentSnapshot(run),
			active: [],
			recent: Array.from({ length: 5 }, (_, index) => ({
				...run,
				id: `task-${String(index)}`,
				agentId: `agent-${String(index)}`,
				parentToolCallId: "swarm-tool",
				status: "success" as const,
				finishedAt: new Date().toISOString(),
			})),
		});
		dock.settle("swarm-tool");
		expect(dock.render(120, theme)).toEqual([]);
	});

	it("surfaces TodoList items without a stored plan snapshot", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		expect(panels.hasPlanContent()).toBe(false);
		panels.setPlanItems([
			{
				id: "todo:0",
				label: "修复自动绑定",
				status: "in_progress",
				depth: 0,
			},
		]);
		expect(panels.hasPlanContent()).toBe(true);
		const output = panels
			.render(100, 18, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(output).toContain("Plan");
		expect(output).toContain("修复自动绑定");
		expect(output).toContain("0 / 1");
	});

	it("renders tasks in separate agent, process, and question sections", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setTaskSnapshot({
			agents: [
				{
					kind: "agent",
					taskId: "agent-job",
					description: "Inspect UI",
					status: "running",
					startedAt: Date.now(),
					endedAt: null,
				},
			],
			processes: [
				{
					kind: "process",
					taskId: "process-job",
					description: "Build",
					status: "running",
					startedAt: Date.now(),
					endedAt: null,
					command: "pnpm build",
					pid: 42,
					exitCode: null,
				},
			],
			questions: [
				{
					kind: "question",
					taskId: "question-job",
					description: "Choose mode",
					status: "running",
					startedAt: Date.now(),
					endedAt: null,
					questionCount: 1,
				},
			],
		});
		panels.open("tasks");
		const output = panels
			.render(100, 18, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(output).toContain("Agent Jobs");
		expect(output).toContain("Processes");
		expect(output).toContain("Questions");
		expect(panels.handleInput("\r")).toBeUndefined();
	});

	it("shows selected question labels in navigation and review", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.openQuestions([
			{
				id: "question-1",
				title: "下一步",
				prompt: "选择处理方式",
				kind: "singleChoice",
				options: [
					{ id: "0", label: "继续执行", description: "立即继续" },
					{ id: "1", label: "暂停检查", description: "先检查状态" },
					{ id: "2", label: "取消", description: "停止操作" },
				],
			},
		]);
		panels.handleInput("\u001b[B");
		const selected = panels
			.render(90, 18, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(selected).toContain("› (●) 暂停检查");
		expect(panels.handleInput("\r")).toBeUndefined();
		const review = panels
			.render(90, 18, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(review).toContain("✓ 暂停检查");
		expect(review).not.toContain("✓ 1\n");
	});

	it.each([
		["active", "执行中"],
		["paused", "已暂停"],
		["blocked", "阻塞"],
		["complete", "已完成"],
	] as const)("renders Runtime Goal %s as %s when width permits", (goal, label) => {
		const output = stripTerminalSequences(
			renderRuntimeStatus(
				{
					working: false,
					tasks: { agents: [], processes: [], questions: [] },
					pendingQuestions: 0,
					pendingApprovals: 0,
					scheduled: 0,
					goal,
				},
				80,
				theme,
			),
		);

		expect(output.startsWith("Runtime · Idle")).toBe(true);
		expect(output.endsWith(`Goal · ${label}`)).toBe(true);
	});

	it("hides Runtime Goal before the primary state on narrow screens", () => {
		const input = {
			working: false,
			tasks: { agents: [], processes: [], questions: [] },
			pendingQuestions: 0,
			pendingApprovals: 0,
			scheduled: 2,
			goal: "active" as const,
		};
		const wide = stripTerminalSequences(renderRuntimeStatus(input, 80, theme));
		const constrained = stripTerminalSequences(
			renderRuntimeStatus(input, 32, theme),
		);
		const narrow = stripTerminalSequences(
			renderRuntimeStatus(input, 20, theme),
		).trimEnd();
		const withoutGoal = stripTerminalSequences(
			renderRuntimeStatus({ ...input, goal: undefined }, 80, theme),
		).trimEnd();

		expect(wide.startsWith("Runtime · Idle · 2 scheduled")).toBe(true);
		expect(wide.endsWith("Goal · 执行中")).toBe(true);
		expect(constrained.startsWith("Runtime · Idle")).toBe(true);
		expect(constrained).not.toContain("scheduled");
		expect(constrained.endsWith("Goal · 执行中")).toBe(true);
		expect(narrow).toBe("Runtime · Idle");
		expect(withoutGoal).toBe("Runtime · Idle · 2 scheduled");
	});

	it("requests a normal render when the Runtime Goal changes", () => {
		const requestRender = vi.fn();
		const app = Object.assign(Object.create(VspiApp.prototype), {
			runtimeGoalStatus: undefined,
			requestRender,
		}) as {
			runtimeGoalStatus: string | undefined;
			setRuntimeGoalStatus(status: "active" | undefined): void;
		};

		app.setRuntimeGoalStatus("active");

		expect(app.runtimeGoalStatus).toBe("active");
		expect(requestRender).toHaveBeenCalledWith();
	});

	it("always renders Idle and treats cron as an accessory", () => {
		const emptyTasks = { agents: [], processes: [], questions: [] };
		const idle = stripTerminalSequences(
			renderRuntimeStatus(
				{
					working: false,
					tasks: emptyTasks,
					pendingQuestions: 0,
					pendingApprovals: 0,
					scheduled: 0,
				},
				80,
				theme,
			),
		).trimEnd();
		const scheduled = stripTerminalSequences(
			renderRuntimeStatus(
				{
					working: false,
					tasks: emptyTasks,
					pendingQuestions: 0,
					pendingApprovals: 0,
					scheduled: 2,
				},
				80,
				theme,
			),
		).trimEnd();

		expect(idle).toBe("Runtime · Idle");
		expect(scheduled).toBe("Runtime · Idle · 2 scheduled");
		expect(scheduled).not.toContain("Waiting");
	});

	it("distinguishes Working and detached background Waiting", () => {
		const tasks = {
			agents: [
				{
					kind: "agent" as const,
					taskId: "agent-1",
					description: "Inspect",
					status: "running" as const,
					detached: true,
					startedAt: 1,
					endedAt: null,
				},
				{
					kind: "agent" as const,
					taskId: "foreground-agent",
					description: "Foreground",
					status: "running" as const,
					detached: false,
					startedAt: 1,
					endedAt: null,
				},
			],
			processes: [
				{
					kind: "process" as const,
					taskId: "process-1",
					description: "Build",
					status: "running" as const,
					startedAt: 1,
					endedAt: null,
					command: "pnpm test",
					pid: 123,
					exitCode: null,
				},
			],
			questions: [],
		};
		const waiting = stripTerminalSequences(
			renderRuntimeStatus(
				{
					working: false,
					tasks,
					pendingQuestions: 0,
					pendingApprovals: 0,
					scheduled: 0,
				},
				100,
				theme,
			),
		).trimEnd();
		const working = stripTerminalSequences(
			renderRuntimeStatus(
				{
					working: true,
					tasks,
					pendingQuestions: 0,
					pendingApprovals: 0,
					scheduled: 0,
				},
				100,
				theme,
			),
		).trimEnd();

		expect(waiting).toBe(
			"Runtime · Waiting · 1 Agent · 1 Process · 完成后自动继续",
		);
		expect(working).toBe("Runtime · Working · 1 Agent · 1 Process");
	});

	it("prioritizes input needs and preserves the primary state on narrow screens", () => {
		const tasks = {
			agents: [
				{
					kind: "agent" as const,
					taskId: "agent-1",
					description: "Inspect",
					status: "running" as const,
					startedAt: 1,
					endedAt: null,
				},
			],
			processes: [],
			questions: [
				{
					kind: "question" as const,
					taskId: "question-1",
					description: "Choose",
					status: "running" as const,
					startedAt: 1,
					endedAt: null,
					questionCount: 2,
				},
			],
		};
		const wide = stripTerminalSequences(
			renderRuntimeStatus(
				{
					working: true,
					tasks,
					pendingQuestions: 1,
					pendingApprovals: 1,
					scheduled: 3,
				},
				100,
				theme,
			),
		).trimEnd();
		const narrow = stripTerminalSequences(
			renderRuntimeStatus(
				{
					working: true,
					tasks,
					pendingQuestions: 1,
					pendingApprovals: 1,
					scheduled: 3,
				},
				21,
				theme,
			),
		).trimEnd();

		expect(wide).toBe(
			"Runtime · Needs input · 2 Questions · 1 Approval · 1 Agent · 3 scheduled",
		);
		expect(narrow).toBe("Runtime · Needs input");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(21);
	});

	it("keeps Runtime last when notice or Question owns the visible surface", () => {
		const idle = renderRuntimeStatus(
			{
				working: false,
				tasks: { agents: [], processes: [], questions: [] },
				pendingQuestions: 0,
				pendingApprovals: 0,
				scheduled: 0,
			},
			80,
			theme,
		);
		const needsInput = renderRuntimeStatus(
			{
				working: false,
				tasks: { agents: [], processes: [], questions: [] },
				pendingQuestions: 1,
				pendingApprovals: 0,
				scheduled: 0,
			},
			80,
			theme,
		);
		const notice = appendRuntimeStatus(["Notice"], idle).map(
			stripTerminalSequences,
		);
		const question = appendRuntimeStatus(
			["Question surface"],
			needsInput,
		).map(stripTerminalSequences);

		expect(notice.at(-2)).toContain("Notice");
		expect(notice.at(-1)?.trimEnd()).toBe("Runtime · Idle");
		expect(question).toContain("Question surface");
		expect(question.at(-1)?.trimEnd()).toBe(
			"Runtime · Needs input · 1 Question",
		);
	});

	it("keeps the original model, policy, path, and usage status rows", () => {
		const output = renderStatusLines(
			{
				cwd: "/workspace/example",
				usage: {
					...DEFAULT_USAGE,
					contextTokens: 1024,
					contextWindow: 8192,
					contextPercent: 12.5,
				},
				modelLabel: "GLM-4.7",
				effort: "high",
				busy: false,
				backend: "VSP Runtime",
				policy: "Auto",
				boundary: "Host",
			},
			100,
			theme,
		)
			.map(stripTerminalSequences)
			.join("\n");

		expect(output).toContain("GLM-4.7");
		expect(output).toContain("Auto");
		expect(output).toContain("/workspace/example");
	});

	it("renders unknown, partial, and free costs without conflating them", () => {
		const renderUsage = (usage: typeof DEFAULT_USAGE) => {
			const panels = new PanelController(DEFAULT_SETTINGS);
			panels.open("usage");
			return panels
				.render(80, 20, theme, usage)
				.map(stripTerminalSequences)
				.join("\n");
		};
		const unknown = renderUsage(DEFAULT_USAGE);
		const partial = renderUsage({
			...DEFAULT_USAGE,
			costEstimateKind: "partial",
		});
		const free = renderUsage({
			...DEFAULT_USAGE,
			costUsd: 0,
			costEstimateKind: "complete",
		});

		expect(unknown).toContain("价格未提供");
		expect(partial).toContain("部分价格未提供");
		expect(free).toContain("$0.0000 · ¥0.00");
	});

	it("renders unknown and free costs differently in the footer", () => {
		const input = {
			cwd: "~/Workspace/VSPi",
			modelLabel: "Example",
			effort: "off",
			busy: false,
		};
		const unknown = renderStatusLines(
			{ ...input, usage: DEFAULT_USAGE },
			80,
			theme,
		).map(stripTerminalSequences);
		const free = renderStatusLines(
			{
				...input,
				usage: {
					...DEFAULT_USAGE,
					costUsd: 0,
					costEstimateKind: "complete",
				},
			},
			80,
			theme,
		).map(stripTerminalSequences);

		expect(unknown[1]?.endsWith("—")).toBe(true);
		expect(free[1]?.endsWith("¥0.00")).toBe(true);
	});

	it("aligns the confirmed footer fields without model, effort, or host labels", () => {
		const lines = renderStatusLines(
			{
				cwd: "~/Workspace/VSPi",
				usage: {
					...DEFAULT_USAGE,
					contextTokens: 61_000,
					contextWindow: 128_000,
					contextPercent: 48,
					inputTokens: 18_400,
					outputTokens: 3_200,
					cacheReadTokens: 12_700,
					recentCacheHitPercent: 39,
					throughputNow: 42.8,
					costUsd: 0.08 / DEFAULT_USAGE.fxRate,
				},
				modelLabel: "GPT-5.6",
				effort: "high",
				busy: false,
				policy: "Auto",
				boundary: "Host",
			},
			120,
			theme,
		).map(stripTerminalSequences);

		expect(lines).toHaveLength(2);
		expect(lines.map(visibleWidth)).toEqual([120, 120]);
		expect(lines[0]).toContain("GPT-5.6 · High");
		expect(lines[0]).toContain("Speed 42.8 tok/s");
		expect(lines[0]).toContain("Context 61K / 128K 48%");
		expect(lines[1]).toContain("~/Workspace/VSPi · Auto");
		expect(lines[1]).toContain("↑ 18.4k  ↓ 3.2k");
		expect(lines[1]).toContain("CacheΣ 12.7k · 39%");
		expect(lines[1]).not.toContain("Cache 12.7k");
		expect(lines[0]?.endsWith("Context 61K / 128K 48%")).toBe(true);
		expect(lines[1]?.endsWith("¥0.08")).toBe(true);
		expect(lines.join("\n")).not.toMatch(/Model|Effort|Host/);
	});

	it("keeps speed units and right-edge alignment at 80 columns", () => {
		const lines = renderStatusLines(
			{
				cwd: "~/Workspace/VSPi",
				usage: {
					...DEFAULT_USAGE,
					contextTokens: 61_000,
					contextWindow: 128_000,
					contextPercent: 48,
					throughputNow: 42.8,
				},
				modelLabel: "GPT-5.6",
				effort: "high",
				busy: false,
				policy: "Auto",
			},
			80,
			theme,
		).map(stripTerminalSequences);

		expect(lines.map(visibleWidth)).toEqual([80, 80]);
		expect(lines[0]).toContain("Speed 42.8 tok/s");
		expect(lines[0]?.endsWith("Context 61K / 128K 48%")).toBe(true);
		expect(lines[1]?.endsWith("—")).toBe(true);
	});
});
