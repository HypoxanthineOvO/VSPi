/**
 * Scenario: the daemon-backed build preserves the accepted VSPi presentation primitives.
 * Responsibilities: splash identity, surface width, markdown, status, composer anchoring, recovery notices.
 * Wiring: real VSPi renderers and xterm terminal emulation; a backend boundary fixture for runtime events.
 * Run: pnpm -C apps/vspi test
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CombinedAutocompleteProvider,
  stripTerminalSequences,
  visibleWidth,
} from "@moonshot-ai/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/pi-tui/test/virtual-terminal.js";
import { AttachmentService } from "../src/v1/attachments/service.js";
import type { AgentConversationActivity, ChatBackend, ChatBackendEvents, TaskDashboardSnapshot } from "../src/v1/backend/types.js";
import { ScrollbackTUI, adaptInteractiveTerminalOutput } from "../src/v1/ui/scrollback-terminal.js";
import type { PolicyLevel, PolicySnapshot } from "../src/v1/policy/execution-policy.js";
import type {
	AgentRunSnapshot,
	AgentSnapshot,
} from "../src/v1/agents/types.js";
import {
	reduceCompactionActivity,
	VspiApp,
} from "../src/v1/app/vspi-app.js";
import { modelPicksPath } from "../src/v1/config/settings.js";
import { resolveCommand } from "../src/v1/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/v1/domain/defaults.js";
import { editSubagentModels } from "../src/v1/domain/subagent-models.js";
import { isOfficialRecommendedModel } from "../src/v1/domain/recommended-models.js";
import type { ModelOption, TranscriptMessage } from "../src/v1/domain/types.js";
import { AgentsDock } from "../src/v1/ui/agents-dock.js";
import {
	renderActivityRail,
	renderQueuedMessage,
} from "../src/v1/ui/activity.js";
import { detectTerminalCapabilities } from "../src/v1/ui/capabilities.js";
import {
  Composer,
  GOAL_SLASH_COMMAND,
  goalInlineHint,
} from "../src/v1/ui/composer.js";
import { renderMarkdown, VspiMarkdown } from "../src/v1/ui/markdown.js";
import {
	PanelController,
	sessionsSurfaceRowLimit,
} from "../src/v1/ui/panels.js";
import { renderSplash } from "../src/v1/ui/splash.js";
import { shutdownInteractiveSession } from "../src/v1/app/startup.js";
import {
	appendRuntimeStatus,
	renderRuntimeStatus,
	renderStatusLines,
} from "../src/v1/ui/status.js";
import { TuiFramePacer } from "../src/v1/ui/tui-frame-pacer.js";
import { TerminalFrameOptimizer } from "../src/v1/ui/terminal-frame-optimizer.js";
import { createTheme } from "../src/v1/ui/theme.js";
import {
	formatSubagentModel,
	formatSubagentProfile,
	formatSubagentProviderModel,
} from "../src/v1/ui/subagent-display.js";
import {
	renderTranscript,
	retainTranscript,
	renderTranscriptMessage,
} from "../src/v1/ui/transcript.js";

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

function panelsFailedAgentRun(): AgentRunSnapshot {
	return {
		id: "task-example", agentId: "child-example", treeId: "tree-example", kind: "task", depth: 1,
		model: "example/model", provider: "example", role: "worker", profile: "coder", modelReason: "requested",
		effort: "high", contextMode: "isolated", contextChars: 0, task: "Example work", tools: [],
		error: "PROVIDER_FAILURE_DIAGNOSTIC",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		budget: { runTokensUsed: 0, maxRunTokens: 0, treeTokensUsed: 0, maxTreeTokens: 0, treeCostUsd: 0, maxTreeCostUsd: 0, maxRunSeconds: 7_200, warnRunTokens: false, warnTreeTokens: false, warnTreeCost: false, warnElapsed: false },
		timeline: [], status: "error", background: true, resumed: false,
		startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:30:00.000Z",
	};
}

describe("VSPi TUI presentation (preserved frontend identity)", () => {
	it('bounds a long live transcript while preserving running work and chronological order', () => {
		let messages: TranscriptMessage[] = [{ id: 'running', role: 'assistant', kind: 'tool', name: 'Task', summary: 'active', status: 'running', expanded: false }];
		for (let index = 0; index < 20000; index++) {
			messages.push({ id: `m${index}`, role: 'assistant', kind: 'text', text: 'x'.repeat(100) });
			messages = retainTranscript(messages, 0, { messages: 100, characters: 20000 }).messages;
		}
		expect(messages).toHaveLength(100);
		expect(messages[0]?.id).toBe('running');
		expect(messages[1]?.id).toBe('m19901');
		expect(messages.at(-1)?.id).toBe('m19999');
	});
	const capabilities = detectTerminalCapabilities({
		TERM: "xterm-256color",
		LANG: "zh_CN.UTF-8",
	});
	const theme = createTheme(capabilities, "VSPi Dark");

	it("anchors a short regular-mode composer near the bottom of the terminal", async () => {
		const { terminal, tui, app } = renderFixture();
		app.composer.setText("COMPOSER_ANCHOR");
		tui.start();
		try {
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getCursorPosition().y).toBeGreaterThanOrEqual(18);
				expect(terminal.getViewport()[terminal.getCursorPosition().y]).toContain("COMPOSER_ANCHOR");
			});
		} finally {
			tui.stop();
			await app.dispose();
		}
	});

	it("keeps the composer anchored when the terminal grows", async () => {
		const { terminal, tui, app } = renderFixture();
		app.composer.setText("RESIZED_COMPOSER");
		tui.start();
		try {
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("RESIZED_COMPOSER");
			});
			terminal.resize(100, 40);
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getCursorPosition().y).toBeGreaterThanOrEqual(34);
				expect(terminal.getViewport()[terminal.getCursorPosition().y]).toContain("RESIZED_COMPOSER");
			});
		} finally {
			tui.stop();
			await app.dispose();
		}
	});

	it("returns a shortened multiline composer to the bottom", async () => {
		const { terminal, tui, app } = renderFixture();
		app.composer.setText(Array.from({ length: 12 }, (_, index) => `INPUT_${index}`).join("\n"));
		tui.start();
		try {
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("INPUT_11");
			});
			app.composer.setText("SHORT_INPUT");
			tui.requestRender();
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getCursorPosition().y).toBeGreaterThanOrEqual(18);
				expect(terminal.getViewport()[terminal.getCursorPosition().y]).toContain("SHORT_INPUT");
				expect(terminal.getViewport().join("\n")).not.toContain("INPUT_11");
			});
		} finally {
			tui.stop();
			await app.dispose();
		}
	});

	it.each([
		{ state: "reconnecting" as const, expected: "正在自动恢复" },
		{ state: "reconnected" as const, expected: "运行时连接已恢复" },
		{ state: "failed" as const, expected: "自动恢复失败" },
	])("preserves the $state notice when a stale IPC request rejects", async ({ state, expected }) => {
		const home = await mkdtemp(join(tmpdir(), "vspi-notice-test-"));
		const { app, events } = renderFixture(home);
		try {
			await app.start();
			events().onRuntimeConnectionState?.(state, 1);
			events().onSessionError?.(new Error("ipc closed"));
			const output = app.render(160).map(stripTerminalSequences).join("\n");
			expect(output).toContain(expected);
			if (state !== "failed") expect(output).not.toContain("请退出并重新启动");
		} finally {
			await app.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});

	function renderFixture(home?: string, terminal = new VirtualTerminal(80, 24)) {
		const tui = new ScrollbackTUI(terminal);
		let events: ChatBackendEvents;
		const setPolicy = vi.fn(async (policy: PolicyLevel): Promise<PolicySnapshot> => ({
			policy, boundary: "Host" as const, sandboxed: false as const, recovery: false, sessionAllowlist: [],
		}));
		const backend: ChatBackend = {
			kind: "runtime",
			modelId: "example/code",
			supportsVision: false,
			modelLabel: "Example",
			start: async (listener: ChatBackendEvents) => { events = listener; },
			dispose: async () => {},
			setPolicy,
			send: async () => {},
			cancel: async () => {},
			compact: async () => false,
			newSession: async () => {},
			listSessions: async () => [],
			switchSession: async () => {},
		};
		const app = new VspiApp(tui, theme, backend, {
			cwd: "/workspace",
			settings: { ...DEFAULT_SETTINGS, summarizeSessionTitleOnExit: false },
			attachments: new AttachmentService("layout-test", theme, { home }),
			home,
			onExit: () => {},
		});
		tui.addChild(app);
		tui.setFocus(app);
		return { terminal, tui, app, backend, events: () => events, setPolicy };
	}

	it("coalesces resize bursts and pending ordinary renders", () => {
		vi.useFakeTimers();
		try {
			const pacer = new TuiFramePacer(33);
			const render = vi.fn();
			for (let i = 0; i < 10; i++) {
				pacer.requestResize(render);
				pacer.request(false, render);
				vi.advanceTimersByTime(20);
			}
			expect(render).not.toHaveBeenCalled();
			vi.advanceTimersByTime(100);
			expect(render).toHaveBeenCalledOnce();
			pacer.cancel();
		} finally { vi.useRealTimers(); }
	});

	it("preserves atomic frame markers by default with an explicit compatibility opt-out", () => {
		const frame = "\u001b[?2026h\u001b[3Jcontent\u001b[?2026l";
		expect(adaptInteractiveTerminalOutput(frame, {})).toBe("\u001b[?2026hcontent\u001b[?2026l");
		expect(adaptInteractiveTerminalOutput(frame, { VSPI_TUI_SYNC_OUTPUT: "0" })).toBe("content");
	});

	it("drops a pending resize offset before starting a restored session epoch", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new ScrollbackTUI(terminal);
		let blocked = false;
		Object.assign(terminal, { deferRender() { return blocked; } });
		const component = { lines: ["BEFORE_SESSION_EPOCH"], render() { return this.lines; }, invalidate() {} };
		tui.addChild(component);
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			blocked = true;
			tui.reflowViewport(16);
			component.lines = Array.from({ length: 10 }, (_, index) => `RESTORED_EPOCH_${index}`);
			tui.beginSurfaceEpoch();
			blocked = false;
			tui.renderNow();
			await terminal.flush();
			const buffer = terminal.getScrollBuffer();
			for (const marker of component.lines) expect(buffer.filter(line => line.includes(marker))).toHaveLength(1);
		} finally { tui.stop(); }
	});

	it("settles again when geometry changes before an opaque resize epoch's first frame", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new ScrollbackTUI(terminal);
		let blocked = false;
		let prefix = 0;
		const tail = ["OPAQUE_FIRST_CONTENT", "OPAQUE_SECOND_CONTENT", "OPAQUE_COMPOSER", "OPAQUE_FOOTER"];
		Object.assign(terminal, { deferRender() { return blocked; } });
		const write = vi.spyOn(terminal, "write");
		tui.addChild({ render: () => [...Array.from({ length: prefix }, () => ""), ...tail], invalidate() {} });
		tui.onRebuildSettled = () => {
			prefix = Math.max(0, terminal.rows - tail.length);
			tui.reflowViewport(prefix);
		};
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			blocked = true;
			prefix = 16;
			tui.reflowViewport(prefix);
			terminal.resize(50, 12);
			write.mockClear();
			blocked = false;
			tui.renderNow();
			expect(write.mock.calls.map(([chunk]) => chunk).join("")).not.toContain("OPAQUE_FIRST_CONTENT");
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport()[8]).toContain("OPAQUE_FIRST_CONTENT");
				expect(terminal.getViewport()[11]).toContain("OPAQUE_FOOTER");
			});
			expect(write.mock.calls.map(([chunk]) => chunk).join("")).not.toMatch(/\u001B\[(?:2|3)J/u);
		} finally { tui.stop(); }
	});

	it("coalesces continuous terminal input without dropping characters", async () => {
		const { app, tui, terminal } = renderFixture();
		const render = vi.spyOn(app, "render");
		tui.start();
		try {
			tui.renderNow();
			render.mockClear();
			for (let i = 0; i < 100; i++) {
				terminal.sendInput("中");
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			await new Promise((resolve) => setTimeout(resolve, 80));
			await terminal.flush();
			expect(app.composer.getText()).toBe("中".repeat(100));
			expect(render.mock.calls.length).toBeLessThan(50);
			expect(terminal.getViewport().some((line) => line.startsWith("╰") && line.endsWith("╯"))).toBe(true);
		} finally { tui.stop(); await app.dispose(); }
	});

	it("waits for output capacity before rendering the latest draft", async () => {
		const { app, tui, terminal } = renderFixture();
		let resume: (() => void) | undefined;
		let blocked = false;
		Object.assign(terminal, { deferRender(callback: () => void) { if (!blocked) return false; resume = callback; return true; } });
		const render = vi.spyOn(app, "render");
		tui.start();
		try {
			tui.renderNow();
			render.mockClear();
			blocked = true;
			for (let i = 0; i < 20; i++) terminal.sendInput("中");
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(render).not.toHaveBeenCalled();
			expect(resume).toBeDefined();
			blocked = false;
			resume?.();
			await new Promise((resolve) => setTimeout(resolve, 80));
			await terminal.flush();
			expect(app.composer.getText()).toBe("中".repeat(20));
			expect(render).toHaveBeenCalled();
		} finally { tui.stop(); await app.dispose(); }
	});

	it("keeps completion rows outside the composer bottom border", async () => {
		const { app } = renderFixture();
		try {
			app.composer.handleInput("/");
			await vi.waitFor(() => {
				const lines = app.composer.render(80).map(stripTerminalSequences);
				const border = lines.findIndex((line) => line.startsWith("╰"));
				expect(border).toBe(2);
				expect(lines.slice(border + 1).join("\n")).toContain("goal");
				expect(lines[1]).not.toContain("────");
			});
		} finally { await app.dispose(); }
	});

	it("keeps the complete latest turn in scrollback when a long reply is revised offscreen", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-turn-scrollback-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			events().onMessage({ id: "current-input", role: "user", kind: "text", text: "CURRENT_INPUT" });
			events().onBusy(true);
			events().onMessage({ id: "long-answer", role: "assistant", kind: "text", streaming: true,
				text: "DRAFT_HEADER\n\n" + Array.from({ length: 30 }, (_, index) => `DRAFT_${index}`).join("\n\n") });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("DRAFT_29");
			});
			const paragraphs = Array.from({ length: 120 }, (_, index) => `FINAL_${String(index).padStart(3, "0")}`);
			events().onMessageUpdate("long-answer", { text: "FINAL_HEADER\n\n" + paragraphs.join("\n\n"), streaming: false });
			await vi.waitFor(async () => {
				await terminal.flush();
				const buffer = terminal.getScrollBuffer().join("\n");
				expect(buffer).toContain("CURRENT_INPUT");
				for (const paragraph of paragraphs) expect(buffer).toContain(paragraph);
			});
			events().onBusy(false);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await terminal.flush();
			expect(terminal.getScrollBuffer().join("\n")).toContain("CURRENT_INPUT");
			write.mockClear();
			terminal.sendInput("next draft");
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("next draft");
			});
			const update = write.mock.calls.map(([data]) => data).join("");
			expect(update).not.toContain("FINAL_000");
			expect(update).not.toContain("\u001b[2J");
			terminal.resize(60, 30);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.flush();
			const resized = terminal.getScrollBuffer();
			for (const paragraph of paragraphs) {
				expect(resized.filter((line) => line.includes(paragraph))).toHaveLength(1);
			}
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("commits previous turns without archiving the latest user input", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-turn-boundary-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			events().onBusy(true);
			for (let index = 0; index < 20; index++) {
				events().onMessage({ id: `question-${index}`, role: "user", kind: "text", text: `QUESTION_${index}` });
				events().onMessage({ id: `answer-${index}`, role: "assistant", kind: "text", text: `ANSWER_${index}` });
			}
			events().onMessage({ id: "latest-input", role: "user", kind: "text", text: "LATEST_INPUT" });
			events().onMessage({ id: "latest-answer", role: "assistant", kind: "text", text: "Latest paragraph\n\n".repeat(100), streaming: true });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("QUESTION_0");
			});
			const buffer = terminal.getScrollBuffer();
			expect(buffer.filter((line) => line.includes("LATEST_INPUT"))).toHaveLength(1);
			expect(buffer.filter((line) => line.includes("QUESTION_0"))).toHaveLength(1);
			expect(write.mock.calls.map(([data]) => data).join("")).not.toContain("\u001b[2J");
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("rebases completed output while busy and keeps small updates out of history", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-live-rebase-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			events().onBusy(true);
			for (let index = 0; index < 100; index++) {
				events().onMessage({ id: `completed-${index}`, role: "assistant", kind: "text", text: `HISTORY_LINE_${index}` });
			}
			await vi.waitFor(() => {
				expect((app as unknown as { committedMessageCount: number }).committedMessageCount).toBeGreaterThan(50);
			});
			await terminal.flush();
			write.mockClear();
			app.composer.setText("SMALL_EDIT");
			events().onUsage({ ...DEFAULT_USAGE, recentCacheHitPercent: 100 });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("SMALL_EDIT");
			});
			const output = write.mock.calls.map(([chunk]) => chunk).join("");
			expect(output).not.toContain("HISTORY_LINE_0");
			expect(output).not.toContain("\u001b[2J");
		} finally {
			tui.stop();
			await app.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});

	it("ignores hidden child thinking without scheduling layout and still refreshes terminal history", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-hidden-child-thinking-"));
		const { app, backend, events } = renderFixture(home);
		const run: AgentRunSnapshot = { ...panelsFailedAgentRun(), status: "running", error: undefined, finishedAt: undefined };
		let receive!: (activity: AgentConversationActivity) => void;
		const getConversation = vi.fn(async () => ({ runId: run.id, agentId: run.agentId, blocks: [], tokenCount: 0 }));
		Object.assign(backend, { getAgentConversation: getConversation, subscribeAgentConversation: (_runId: string, listener: (activity: AgentConversationActivity) => void) => { receive = listener; return { dispose() {} }; } });
		const state = app as unknown as { panels: PanelController; openAgentConversation(runId: string): Promise<void>; requestRender(force?: boolean, scope?: "all" | "dock"): void };
		try {
			await app.start();
			events().onAgentSnapshot?.(panelsAgentSnapshot(run));
			state.panels.open("agents");
			await state.openAgentConversation(run.id);
			const render = vi.spyOn(state, "requestRender");
			const activity = vi.spyOn(state.panels, "appendAgentActivity");
			for (let index = 0; index < 1_000; index++) receive({ kind: "thinking", turnId: 7, delta: "HIDDEN_CHILD_THINKING" });
			expect(render).not.toHaveBeenCalled();
			expect(activity).not.toHaveBeenCalled();
			expect(getConversation).toHaveBeenCalledOnce();
			receive({ kind: "assistant", turnId: 7, delta: "VISIBLE_CHILD_UPDATE" });
			expect(render).toHaveBeenCalledOnce();
			expect(activity).toHaveBeenCalledWith({ kind: "assistant", turnId: 7, delta: "VISIBLE_CHILD_UPDATE" });
			receive({ kind: "turn", turnId: 7, state: "completed" });
			await vi.waitFor(() => { expect(getConversation).toHaveBeenCalledTimes(2); });
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("reconciles new history objects without replaying frozen rows or resetting tool preferences", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-native-history-reconcile-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const state = app as unknown as { committedMessageCount: number; messages: TranscriptMessage[] };
		const write = vi.spyOn(terminal, "write");
		const expanded: Extract<TranscriptMessage, { kind: "tool" }> = { id: "history-expanded", groupId: "shared-history-group", role: "assistant", kind: "tool", name: "Shell", summary: "Expanded choice", status: "success", expanded: true, output: "RECONCILE_ORIGINAL_TOOL", durationMs: 1_200 };
		const collapsed: Extract<TranscriptMessage, { kind: "tool" }> = { id: "history-collapsed", groupId: "shared-history-group", role: "assistant", kind: "tool", name: "Read", summary: "Collapsed choice", status: "success", expanded: false, durationMs: 875 };
		const agent: Extract<TranscriptMessage, { kind: "tool" }> = { id: "history-agent", groupId: "shared-history-group", role: "assistant", kind: "tool", name: "Agent", summary: "Completed child", status: "success", expanded: false, durationMs: 4_250, agentRuns: [{ name: "Worker", task: "Reconciled child", status: "success", result: "RECONCILE_AGENT_EXISTING_RESULT" }] };
		const thinking: Extract<TranscriptMessage, { kind: "thinking" }> = { id: "history-thinking", role: "assistant", kind: "thinking", effort: "medium", text: "完整思考内容应保留，历史快照只包含较短前缀时不能覆盖。", collapsed: true, durationMs: 900, translatedText: "PRESERVED_THINKING_TRANSLATION", translationStatus: "translated" };
		const rows = Array.from({ length: 160 }, (_, index) => `RECONCILE_BODY_${String(index).padStart(3, "0")}`);
		const body: Extract<TranscriptMessage, { kind: "text" }> = { id: "history-current-answer", role: "assistant", kind: "text", text: rows.join("\n\n"), streaming: true };
		try {
			await app.start();
			tui.start();
			for (const message of [expanded, collapsed, agent, thinking, body]) events().onMessage(message);
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("RECONCILE_BODY_159");
				expect(state.committedMessageCount).toBeGreaterThanOrEqual(4);
			});
			write.mockClear();
			const history: TranscriptMessage[] = [
				{ id: expanded.id, role: "assistant", kind: "tool", name: expanded.name, summary: expanded.summary, status: "success", expanded: false, output: `${expanded.output}\nRECONCILE_EXPANDED_LATE` },
				{ id: collapsed.id, role: "assistant", kind: "tool", name: collapsed.name, summary: collapsed.summary, status: "success", expanded: true, output: "RECONCILE_COLLAPSED_LATE" },
				{ id: agent.id, role: "assistant", kind: "tool", name: agent.name, summary: agent.summary, status: "success", expanded: false },
				{ id: thinking.id, role: "assistant", kind: "thinking", effort: "medium", text: thinking.text, collapsed: false },
				{ ...body, streaming: false, text: `${body.text}\n\nRECONCILE_BODY_COMPLETED` },
				{ id: "history-new-answer", role: "assistant", kind: "text", text: "RECONCILE_NEW_MESSAGE" },
			];
			events().onHistoryReconcile?.(structuredClone(history));
			await vi.waitFor(async () => {
				await terminal.flush();
				const buffer = terminal.getScrollBuffer().join("\n");
				for (const marker of ["RECONCILE_EXPANDED_LATE", "RECONCILE_COLLAPSED_LATE", "RECONCILE_BODY_COMPLETED", "RECONCILE_NEW_MESSAGE"]) expect(buffer).toContain(marker);
			});
			const truncated = structuredClone(history).map(message => {
				if (message.id === expanded.id && message.kind === "tool") return { ...message, output: "RECONCILE_ORIGINAL[display truncated]" };
				if (message.id === collapsed.id && message.kind === "tool") return { ...message, output: undefined };
				if (message.id === body.id && message.kind === "text") return { ...message, text: `${body.text.slice(0, 240)}[display truncated]` };
				if (message.id === thinking.id && message.kind === "thinking") return { ...message, text: "完整思考内容" };
				return message;
			});
			events().onHistoryReconcile?.(truncated, { truncated: true });
			expect(state.messages.find(message => message.id === body.id)).toMatchObject({ text: `${body.text}\n\nRECONCILE_BODY_COMPLETED` });
			expect(state.messages.find(message => message.id === thinking.id)).toMatchObject({ text: thinking.text, collapsed: true, durationMs: 900, translatedText: thinking.translatedText, translationStatus: "translated" });
			for (let index = 0; index < 5; index++) events().onHistoryReconcile?.(structuredClone(history));
			events().onMessageUpdate(agent.id, { agentRuns: structuredClone(agent.agentRuns) });
			tui.renderNow();
			await terminal.flush();
			const buffer = terminal.getScrollBuffer();
			for (const marker of [...rows, "RECONCILE_ORIGINAL_TOOL", "RECONCILE_AGENT_EXISTING_RESULT", "RECONCILE_EXPANDED_LATE", "RECONCILE_COLLAPSED_LATE", "RECONCILE_BODY_COMPLETED", "RECONCILE_NEW_MESSAGE"]) expect(buffer.filter(line => line.includes(marker)), marker).toHaveLength(1);
			expect(state.messages.find(message => message.id === expanded.id)).toMatchObject({ expanded: true, groupId: expanded.groupId, durationMs: expanded.durationMs, output: `${expanded.output}\nRECONCILE_EXPANDED_LATE` });
			expect(state.messages.find(message => message.id === collapsed.id)).toMatchObject({ expanded: false, groupId: collapsed.groupId, durationMs: collapsed.durationMs, output: "RECONCILE_COLLAPSED_LATE" });
			expect(state.messages.find(message => message.id === agent.id)).toMatchObject({ groupId: agent.groupId, agentRuns: agent.agentRuns, durationMs: agent.durationMs });
			const appended = write.mock.calls.map(([chunk]) => chunk).join("");
			expect(appended).not.toContain("RECONCILE_BODY_000");
			expect(appended).not.toContain("RECONCILE_ORIGINAL_TOOL");
			expect(appended).not.toMatch(/\u001B\[(?:2|3)J/u);
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("prints only new suffixes and one replacement when an archived final answer is reconciled", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-archived-text-reconcile-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const state = app as unknown as { committedMessageCount: number; messages: TranscriptMessage[] };
		const rows = Array.from({ length: 160 }, (_, index) => `ARCHIVED_TEXT_${String(index).padStart(3, "0")}`);
		const original: Extract<TranscriptMessage, { kind: "text" }> = { id: "archived-final-answer", role: "assistant", kind: "text", text: rows.join("\n\n"), streaming: false };
		const padding: TranscriptMessage = { id: "archived-text-padding", role: "assistant", kind: "text", text: Array.from({ length: 60 }, (_, index) => `TEXT_ARCHIVE_PADDING_${index}`).join("\n\n") };
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			events().onMessage(original);
			events().onMessage(padding);
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("TEXT_ARCHIVE_PADDING_59");
				expect(state.committedMessageCount).toBeGreaterThan(0);
			});
			write.mockClear();
			const first = `${original.text}\n\nARCHIVED_FIRST_SUFFIX`;
			const history: TranscriptMessage[] = [{ ...original, text: first }, padding];
			events().onHistoryReconcile?.(structuredClone(history));
			await vi.waitFor(async () => { await terminal.flush(); expect(terminal.getScrollBuffer().join("\n")).toContain("ARCHIVED_FIRST_SUFFIX"); });
			for (let index = 0; index < 5; index++) events().onHistoryReconcile?.(structuredClone(history));
			const second = `${first}\n\nARCHIVED_SECOND_SUFFIX`;
			events().onMessageUpdate(original.id, { text: second });
			await vi.waitFor(async () => { await terminal.flush(); expect(terminal.getScrollBuffer().join("\n")).toContain("ARCHIVED_SECOND_SUFFIX"); });
			const replacement = "ARCHIVED_TEXT_REPLACEMENT\n\nREPLACEMENT_COMPLETE_BODY";
			events().onHistoryReconcile?.([{ ...original, text: replacement }, structuredClone(padding)]);
			await vi.waitFor(async () => { await terminal.flush(); expect(terminal.getScrollBuffer().join("\n")).toContain("REPLACEMENT_COMPLETE_BODY"); });
			for (let index = 0; index < 5; index++) events().onHistoryReconcile?.([{ ...original, text: replacement }, structuredClone(padding)]);
			tui.renderNow();
			await terminal.flush();
			const buffer = terminal.getScrollBuffer();
			for (const marker of [...rows, "ARCHIVED_FIRST_SUFFIX", "ARCHIVED_SECOND_SUFFIX", "ARCHIVED_TEXT_REPLACEMENT", "REPLACEMENT_COMPLETE_BODY", "TEXT_ARCHIVE_PADDING_59"]) expect(buffer.filter(line => line.includes(marker)), marker).toHaveLength(1);
			expect(state.messages.find(message => message.id === original.id)).toMatchObject({ text: replacement });
			const appended = write.mock.calls.map(([chunk]) => chunk).join("");
			expect(appended).not.toContain("ARCHIVED_TEXT_000");
			expect(appended).not.toMatch(/\u001B\[(?:2|3)J/u);
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("does not replay retained-out history records while reconciling genuinely new content", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-history-retention-reconcile-"));
		const { app, tui, terminal, events } = renderFixture(home, new VirtualTerminal(80, 24, 10_000));
		const state = app as unknown as { messages: TranscriptMessage[]; pendingLiveOutput: boolean; archivedMessageIds: Set<string> };
		const history: TranscriptMessage[] = Array.from({ length: 1_100 }, (_, index) => ({ id: `retained-history-${index}`, role: "assistant", kind: "text", text: `RETENTION_TEXT_${String(index).padStart(4, "0")}` }));
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			for (const message of history) events().onMessage(message);
			await vi.waitFor(async () => {
				tui.renderNow();
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("RETENTION_TEXT_1099");
				expect(state.pendingLiveOutput).toBe(false);
				expect(state.messages.length).toBeLessThanOrEqual(1_000);
				expect(state.messages.some(message => message.id === history[0]!.id)).toBe(false);
			}, { timeout: 10_000 });
			write.mockClear();
			const updated: TranscriptMessage[] = [...history, { id: "retention-new-content", role: "assistant", kind: "text", text: "RETENTION_NEW_CONTENT" }];
			events().onHistoryReconcile?.(structuredClone(updated));
			await vi.waitFor(async () => { await terminal.flush(); expect(terminal.getScrollBuffer().join("\n")).toContain("RETENTION_NEW_CONTENT"); });
			for (let index = 0; index < 5; index++) events().onHistoryReconcile?.(structuredClone(updated));
			tui.renderNow();
			await terminal.flush();
			const buffer = terminal.getScrollBuffer();
			for (const message of updated) if (message.kind === "text") expect(buffer.filter(line => line.includes(message.text)), message.id).toHaveLength(1);
			expect(write.mock.calls.map(([chunk]) => chunk).join("")).not.toContain("RETENTION_TEXT_0000");
			expect(state.messages.length).toBeLessThanOrEqual(1_000);
			expect(state.archivedMessageIds.size).toBeGreaterThan(0);
			events().onSessionReset?.({ id: "layout-test", reason: "new", effort: "high" });
			expect(state.archivedMessageIds.size).toBe(0);
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	}, 15_000);

	it("restores identical Agent and Tasks snapshots after reconnecting the same session", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-reconnect-snapshots-"));
		const { app, backend, events } = renderFixture(home);
		const run: AgentRunSnapshot = { ...panelsFailedAgentRun(), codename: "RESTORED_WORKER", status: "running", error: undefined, finishedAt: undefined };
		const agents = panelsAgentSnapshot(run);
		const tasks: TaskDashboardSnapshot = { agents: [{ taskId: run.id, kind: "agent", description: "Restored task", status: "running", startedAt: 1_000, endedAt: null }], processes: [], questions: [] };
		Object.assign(backend, { getAgentSnapshot: () => ({ ...agents, active: [], recent: [] }), getTaskSnapshot: () => ({ agents: [], processes: [], questions: [] }) });
		try {
			await app.start();
			events().onAgentSnapshot?.(agents);
			events().onTaskSnapshot?.(tasks);
			expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("RESTORED_WORKER");
			events().onSessionReset?.({ id: "layout-test", reason: "resume", effort: "high" });
			events().onAgentSnapshot?.(structuredClone(agents));
			events().onTaskSnapshot?.(structuredClone(tasks));
			const state = app as unknown as { agentsDock: AgentsDock; taskSnapshot: TaskDashboardSnapshot };
			expect(state.agentsDock.hasActive()).toBe(true);
			expect(state.taskSnapshot).toEqual(tasks);
			expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("RESTORED_WORKER");
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it.each([false, true].flatMap(reducedMotion => (["stable", "failed", "cancelled"] as const).map(phase => ({ phase, reducedMotion }))))("settles queue-only $phase activity and OS progress with reducedMotion=$reducedMotion", async ({ phase, reducedMotion }) => {
		const home = await mkdtemp(join(tmpdir(), "vspi-queue-only-clock-"));
		const { app, terminal, events } = renderFixture(home);
		const state = app as unknown as {
			queuedMessages: Map<string, TranscriptMessage>;
			queuedPresentations: Map<string, { phase: string }>;
			activityPresentationActive: boolean;
			workingStartedAt?: number;
			workingTimer?: NodeJS.Timeout;
			options: { settings: { reducedMotion: boolean } };
			queueMessagePresentation(id: string): void;
			activityActive(): boolean;
		};
		try {
			await app.start();
			state.options.settings.reducedMotion = reducedMotion;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
			const progress = vi.spyOn(terminal, "setProgress");
			state.queuedMessages.set("queued-only", { id: "queued-only", role: "user", kind: "text", text: "PRESERVE_QUEUED_INPUT", delivery: "steer", deliveryState: "queued" });
			state.queueMessagePresentation("queued-only");
			expect(state.activityActive()).toBe(true);
			expect(progress).toHaveBeenLastCalledWith(true);
			if (phase === "stable") vi.advanceTimersByTime(241);
			else events().onPromptLifecycle?.("queued-only", phase);
			expect(state.activityActive()).toBe(false);
			expect(state.activityPresentationActive).toBe(false);
			expect(state.workingStartedAt).toBeUndefined();
			expect(state.workingTimer).toBeUndefined();
			expect(progress).toHaveBeenLastCalledWith(false);
			expect(state.queuedMessages.get("queued-only")?.kind).toBe("text");
			expect(state.queuedMessages.get("queued-only")).toMatchObject({ text: "PRESERVE_QUEUED_INPUT" });
			if (phase === "stable") expect(state.queuedPresentations.get("queued-only")?.phase).toBe("stable");
			else expect(state.queuedPresentations.has("queued-only")).toBe(false);
		} finally { vi.useRealTimers(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("keeps fixed-size Agent polls, usage, clocks, and ordinary input out of body layout", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-steady-body-cache-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const state = app as unknown as {
			buildRenderBody(width: number, dock: unknown): string[];
			pendingLiveOutput: boolean;
			regularBodyRevision: number;
			regularBodyCache?: { revision: number };
		};
		const layout = vi.spyOn(state, "buildRenderBody");
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			const base = panelsFailedAgentRun();
			const active = Array.from({ length: 4 }, (_, index): AgentRunSnapshot => ({ ...base, id: `active-${index}`, agentId: `child-${index}`, codename: `Worker ${index}`, status: "running", error: undefined, startedAt: new Date(Date.now() - 30_000).toISOString(), finishedAt: undefined }));
			const agents = { ...panelsAgentSnapshot(active[0]!), active, recent: [] };
			const tasks: TaskDashboardSnapshot = { agents: active.map(run => ({ taskId: run.id, kind: "agent", description: run.task, status: "running", startedAt: Date.parse(run.startedAt!), endedAt: null })), processes: [], questions: [] };
			events().onAgentSnapshot?.(agents);
			events().onTaskSnapshot?.(tasks);
			events().onBusy(true);
			events().onMessage({ id: "long-cache-answer", kind: "text", role: "assistant", streaming: false, text: Array.from({ length: 160 }, (_, index) => `CACHE_BODY_${String(index).padStart(3, "0")}`).join("\n\n") });
			await vi.waitFor(async () => {
				tui.renderNow();
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("CACHE_BODY_159");
				expect(state.pendingLiveOutput).toBe(false);
				expect(state.regularBodyCache?.revision).toBe(state.regularBodyRevision);
			});
			layout.mockClear();
			write.mockClear();
			for (let index = 0; index < 20; index++) {
				events().onAgentSnapshot?.(structuredClone(agents));
				events().onTaskSnapshot?.(structuredClone(tasks));
				events().onUsage({ ...DEFAULT_USAGE, inputTokens: index, outputTokens: index, recentCacheHitPercent: index });
				terminal.sendInput("x");
				tui.renderNow();
				await terminal.flush();
			}
			await new Promise(resolve => setTimeout(resolve, 1_100));
			await terminal.flush();
			expect(layout).not.toHaveBeenCalled();
			expect(app.composer.getText()).toBe("x".repeat(20));
			const output = write.mock.calls.map(([chunk]) => chunk).join("");
			expect(output).not.toContain("CACHE_BODY_000");
			expect(output).not.toContain("\u001B[2J");
			expect(terminal.getScrollBuffer().filter(line => line.includes("CACHE_BODY_000"))).toHaveLength(1);
			expect(terminal.getScrollBuffer().filter(line => line.includes("CACHE_BODY_159"))).toHaveLength(1);
		} finally {
			tui.stop();
			await app.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});

	it("invalidates fixed-size body layout for dock height, command panels, and new content", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-body-cache-invalidation-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const state = app as unknown as { buildRenderBody(width: number, dock: unknown): string[]; panels: PanelController };
		const layout = vi.spyOn(state, "buildRenderBody");
		try {
			await app.start();
			tui.start();
			events().onMessage({ id: "short-body", kind: "text", role: "assistant", text: "BODY_CACHE_BASE" });
			await vi.waitFor(async () => { await terminal.flush(); expect(terminal.getViewport().join("\n")).toContain("BODY_CACHE_BASE"); });
			layout.mockClear();
			terminal.sendInput("ordinary text");
			tui.renderNow();
			await terminal.flush();
			expect(layout).not.toHaveBeenCalled();
			app.composer.setText(Array.from({ length: 8 }, (_, index) => `DRAFT_ROW_${index}`).join("\n"));
			tui.renderNow();
			await terminal.flush();
			expect(layout).toHaveBeenCalled();
			expect(terminal.getViewport().join("\n")).toContain("DRAFT_ROW_7");
			app.composer.setText("");
			tui.renderNow();
			layout.mockClear();
			state.panels.open("commands");
			app.composer.setText("/tas");
			tui.renderNow();
			await terminal.flush();
			expect(layout).toHaveBeenCalled();
			expect(terminal.getViewport().join("\n")).toContain("/tasks");
			state.panels.close();
			app.composer.setText("");
			tui.renderNow();
			layout.mockClear();
			events().onMessage({ id: "new-body", kind: "text", role: "assistant", text: "BODY_CACHE_NEW_CONTENT" });
			tui.renderNow();
			await terminal.flush();
			expect(layout).toHaveBeenCalled();
			expect(terminal.getScrollBuffer().join("\n")).toContain("BODY_CACHE_NEW_CONTENT");
		} finally {
			tui.stop();
			await app.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});

	it("freezes nothing into scrollback while the frame fits the viewport", async () => {
		const { app, tui, terminal } = renderFixture();
		const commit = vi.spyOn(tui, "commitStatic");
		tui.start();
		try {
			Object.assign(app, { messages: [{ id: "short", role: "assistant", kind: "text", text: "Short output" }] });
			tui.requestRender();
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("Short output");
			});
			expect(commit).not.toHaveBeenCalled();
		} finally { tui.stop(); await app.dispose(); }
	});

	it.each(["queued", "running"] as const)("does not freeze a %s tool that is still on screen", async (status) => {
		const { app, tui, terminal } = renderFixture();
		tui.start();
		try {
			Object.assign(app, { messages: [
				{ id: `live-${status}`, role: "assistant", kind: "tool", name: "Shell", summary: `PENDING_${status}`, status, expanded: false },
			] });
			tui.requestRender();
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain(`PENDING_${status}`);
			});
			const internals = app as unknown as {
				frozenNodeRows: Map<string, unknown>;
				committedMessageCount: number;
			};
			expect(internals.committedMessageCount).toBe(0);
			expect(internals.frozenNodeRows.size).toBe(0);
		} finally { tui.stop(); await app.dispose(); }
	});

	it("freezes a tool-heavy turn into scrollback without a clearing redraw", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-tool-heavy-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const write = vi.spyOn(terminal, "write");
		const rebuild = vi.spyOn(tui, "reflowViewport");
		const markers: string[] = [];
		try {
			await app.start();
			tui.start();
			events().onBusy(true);
			events().onMessage({ id: "input", role: "user", kind: "text", text: "HEAVY_INPUT" });
			markers.push("HEAVY_INPUT");
			for (let index = 0; index < 8; index++) {
				const id = `grouped-${index}`;
				events().onMessage({ id, role: "assistant", kind: "tool", groupId: "alpha", name: "Shell", summary: `GROUP_QUEUED_${index}`, status: "queued", expanded: false });
				events().onMessageUpdate(id, { status: "running", summary: `GROUP_RUNNING_${index}` });
				events().onMessageUpdate(id, { status: "success", summary: `GROUP_DONE_${index}` });
			}
			markers.push("工具调用 · 8 项");
			for (let index = 0; index < 32; index++) {
				const tag = String(index).padStart(2, "0");
				const id = `single-${index}`;
				events().onMessage({ id, role: "assistant", kind: "tool", name: "Shell", summary: `SINGLE_QUEUED_${tag}`, status: "queued", expanded: true });
				events().onMessageUpdate(id, { status: "running", summary: `SINGLE_RUNNING_${tag}` });
				events().onMessageUpdate(id, { status: "success", summary: `SINGLE_DONE_${tag}` });
				markers.push(`SINGLE_DONE_${tag}`);
				const text = `PARA_${tag}`;
				events().onMessage({ id: `text-${index}`, role: "assistant", kind: "text", text, streaming: false });
				markers.push(text);
				if (index % 8 === 0) {
					const thinkId = `think-${index}`;
					events().onMessage({ id: thinkId, role: "assistant", kind: "thinking", effort: "high", text: `THINK_BODY_${tag}`, collapsed: true, streaming: false });
					events().onMessageUpdate(thinkId, { durationMs: 1234 + index });
				}
				if (index % 8 === 7) await terminal.flush();
			}
			events().onBusy(false);
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("PARA_31");
			});
			await new Promise((resolve) => setTimeout(resolve, 120));
			await terminal.flush();
			for (const chunk of write.mock.calls.map(([data]) => data)) {
				expect(chunk).not.toContain("\u001b[2J");
			}
			expect(rebuild).not.toHaveBeenCalled();
			const buffer = terminal.getScrollBuffer();
			let lastIndex = -1;
			for (const marker of markers) {
				const found = buffer
					.map((line, index) => ({ line, index }))
					.filter(({ line }) => line.includes(marker));
				expect(found, `marker ${marker}`).toHaveLength(1);
				expect(found[0]!.index, `order of ${marker}`).toBeGreaterThan(lastIndex);
				lastIndex = found[0]!.index;
			}
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("reflows the viewport once after a resize drag without replaying history", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-resize-drag-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const write = vi.spyOn(terminal, "write");
		const paragraphs = Array.from({ length: 120 }, (_, index) => `DRAG_PARA_${String(index).padStart(3, "0")}`);
		try {
			await app.start();
			tui.start();
			events().onMessage({ id: "input", role: "user", kind: "text", text: "DRAG_INPUT" });
			for (let index = 0; index < 3; index++) {
				const id = `drag-tool-${index}`;
				events().onMessage({ id, role: "assistant", kind: "tool", name: "Shell", summary: `DRAG_TOOL_${index}`, status: "running", expanded: false });
				events().onMessageUpdate(id, { status: "success" });
			}
			events().onMessage({ id: "answer", role: "assistant", kind: "text", text: paragraphs.join("\n\n"), streaming: false });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("DRAG_PARA_119");
			});
			write.mockClear();
			for (let step = 0; step < 30; step++) {
				terminal.resize(Math.max(50, 79 - step), 24);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.flush();
			const chunks = write.mock.calls.map(([data]) => data);
			const reflows = chunks.filter((chunk) => /\u001b\[\d+;1H\r\n/u.test(chunk));
			expect(reflows).toHaveLength(1);
			for (const chunk of chunks) {
				expect(chunk).not.toContain("\u001b[2J");
				expect(chunk).not.toContain("\u001b[3J");
			}
			const buffer = terminal.getScrollBuffer();
			let lastIndex = -1;
			for (const paragraph of paragraphs) {
				const found = buffer
					.map((line, index) => ({ line, index }))
					.filter(({ line }) => line.includes(paragraph));
				expect(found, `marker ${paragraph}`).toHaveLength(1);
				expect(found[0]!.index, `order of ${paragraph}`).toBeGreaterThan(lastIndex);
				lastIndex = found[0]!.index;
			}
			for (const line of buffer) {
				if (line.trim() === "") continue;
				expect(visibleWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(50);
			}
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("keeps the splash title unique in scrollback across a resize rebuild", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-splash-scrollback-"));
		const { app, tui, terminal, events } = renderFixture(home);
		try {
			await app.start();
			app.setStartupSurface(renderSplash(80, theme, 1, app.startupStatus()));
			tui.start();
			const paragraphs = Array.from({ length: 80 }, (_, index) => `SPLASH_PARA_${index}`);
			events().onMessage({ id: "answer", role: "assistant", kind: "text", text: paragraphs.join("\n\n"), streaming: false });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("SPLASH_PARA_79");
			});
			expect(terminal.getScrollBuffer().filter((line) => line.includes("◈ VSPi"))).toHaveLength(1);
			terminal.resize(60, 24);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.flush();
			const buffer = terminal.getScrollBuffer();
			expect(buffer.filter((line) => line.includes("◈ VSPi"))).toHaveLength(1);
			expect(buffer.join("\n")).toContain("SPLASH_PARA_79");
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("resurfaces a frozen running tool's completion and preserves it on resize", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-frozen-tool-"));
		const { app, tui, terminal, events } = renderFixture(home);
		try {
			await app.start();
			tui.start();
			events().onMessage({ id: "input", role: "user", kind: "text", text: "TOOL_INPUT" });
			events().onMessage({ id: "tool", role: "assistant", kind: "tool", name: "Shell", summary: "RUNNING_MARKER", status: "running", expanded: true });
			for (let index = 0; index < 40; index++) {
				events().onMessage({ id: `pad-${index}`, role: "assistant", kind: "text", text: `PAD_${index}`, streaming: false });
			}
			await vi.waitFor(async () => {
				await terminal.flush();
				const buffer = terminal.getScrollBuffer();
				expect(buffer.join("\n")).toContain("PAD_39");
				expect(buffer.filter((line) => line.includes("RUNNING_MARKER"))).toHaveLength(1);
			});
			events().onMessageUpdate("tool", { status: "success", summary: "DONE_MARKER" });
			for (let index = 40; index < 70; index++) {
				events().onMessage({ id: `pad-${index}`, role: "assistant", kind: "text", text: `PAD_${index}`, streaming: false });
			}
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("PAD_69");
			});
			const beforeRebuild = terminal.getScrollBuffer();
			const summaryIndex = beforeRebuild.findIndex((line) => line.includes("DONE_MARKER"));
			expect(summaryIndex).toBeGreaterThanOrEqual(0);
			const settledPadIndex = beforeRebuild.map((line) => line.includes("PAD_20")).lastIndexOf(true);
			expect(summaryIndex).toBeGreaterThan(settledPadIndex);
			terminal.resize(60, 24);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.flush();
			const rebuilt = terminal.getScrollBuffer();
			const doneLines = rebuilt
				.map((line, index) => ({ line, index }))
				.filter(({ line }) => line.includes("DONE_MARKER"));
			expect(doneLines).toHaveLength(1);
			expect(doneLines[0]!.index).toBeGreaterThan(rebuilt.findIndex((line) => line.includes("PAD_20")));
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("prints complete late output from an archived expanded tool without replaying its prefix", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-archived-tool-output-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const state = app as unknown as { committedMessageCount: number; messages: TranscriptMessage[] };
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			const original = Array.from({ length: 20 }, (_, index) => `ARCHIVED_OLD_${String(index).padStart(3, "0")}`);
			events().onMessage({ id: "archived-tool", role: "assistant", kind: "tool", name: "Shell", summary: "Archived expanded output", status: "success", expanded: true, output: original.join("\n") });
			events().onMessage({ id: "tool-padding", role: "assistant", kind: "text", text: Array.from({ length: 100 }, (_, index) => `ARCHIVE_PADDING_${index}`).join("\n\n") });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("ARCHIVE_PADDING_99");
				expect(state.committedMessageCount).toBeGreaterThan(0);
			});
			write.mockClear();
			const appended = Array.from({ length: 600 }, (_, index) => `ARCHIVED_LATE_${String(index).padStart(3, "0")}`);
			const output = [...original, ...appended].join("\n");
			events().onMessageUpdate("archived-tool", { output });
			await vi.waitFor(async () => { await terminal.flush(); expect(terminal.getScrollBuffer().join("\n")).toContain("ARCHIVED_LATE_599"); });
			for (let index = 0; index < 10; index++) events().onMessageUpdate("archived-tool", { output });
			tui.renderNow();
			await terminal.flush();
			const history = terminal.getScrollBuffer();
			for (const marker of [...original, ...appended]) expect(history.filter(line => line.includes(marker))).toHaveLength(1);
			expect(write.mock.calls.map(([chunk]) => chunk).join("")).not.toContain("ARCHIVED_OLD_000");
			expect(state.messages.find(message => message.id === "archived-tool")).toMatchObject({ output });
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("shows each archived Agent result once when several children finish in one snapshot", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-archived-agent-results-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const state = app as unknown as { committedMessageCount: number; messages: TranscriptMessage[] };
		try {
			await app.start();
			tui.start();
			const running = [{ name: "Worker A", task: "First task", status: "background" as const }, { name: "Worker B", task: "Second task", status: "background" as const }];
			events().onMessage({ id: "archived-agent", role: "assistant", kind: "tool", name: "Agent", summary: "Two background workers", status: "success", expanded: false, agentRuns: running });
			events().onMessage({ id: "agent-padding", role: "assistant", kind: "text", text: Array.from({ length: 100 }, (_, index) => `AGENT_ARCHIVE_PADDING_${index}`).join("\n\n") });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("AGENT_ARCHIVE_PADDING_99");
				expect(state.committedMessageCount).toBeGreaterThan(0);
			});
			const completed = running.map((run, index) => ({ ...run, status: "success" as const, result: `ARCHIVED_AGENT_RESULT_${index}\nComplete retained result ${index}` }));
			events().onMessageUpdate("archived-agent", { agentRuns: completed });
			await vi.waitFor(async () => {
				await terminal.flush();
				const history = terminal.getScrollBuffer().join("\n");
				expect(history).toContain("ARCHIVED_AGENT_RESULT_0");
				expect(history).toContain("ARCHIVED_AGENT_RESULT_1");
			});
			for (let index = 0; index < 10; index++) events().onMessageUpdate("archived-agent", { agentRuns: structuredClone(completed) });
			tui.renderNow();
			await terminal.flush();
			const history = terminal.getScrollBuffer();
			for (let index = 0; index < 2; index++) expect(history.filter(line => line.includes(`ARCHIVED_AGENT_RESULT_${index}`))).toHaveLength(1);
			expect(state.messages.find(message => message.id === "archived-agent")).toMatchObject({ agentRuns: completed });
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("rebuilds once when a force render lands inside the resize settle window", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-settle-force-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const rebuild = vi.spyOn(tui, "reflowViewport");
		try {
			await app.start();
			tui.start();
			events().onMessage({ id: "input", role: "user", kind: "text", text: "SETTLE_INPUT" });
			events().onMessage({ id: "answer", role: "assistant", kind: "text", text: "SETTLE_ANSWER", streaming: false });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("SETTLE_ANSWER");
			});
			terminal.resize(60, 24);
			// A forced frame inside the settle window must not cancel the rebuild.
			tui.requestRender(true);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.flush();
			expect(rebuild).toHaveBeenCalledTimes(1);
			events().onMessage({ id: "after", role: "assistant", kind: "text", text: "AFTER_SETTLE", streaming: false });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("AFTER_SETTLE");
			});
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("draws the takeover notice in the next frame without a rebuild", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-takeover-"));
		const { app, tui, terminal, events } = renderFixture(home);
		const write = vi.spyOn(terminal, "write");
		const rebuild = vi.spyOn(tui, "reflowViewport");
		try {
			await app.start();
			tui.start();
			events().onMessage({ id: "pre", role: "assistant", kind: "text", text: "PRE_TAKEOVER", streaming: false });
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("PRE_TAKEOVER");
			});
			write.mockClear();
			events().onTakeover?.();
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("Session 已移交到新终端");
			});
			const output = write.mock.calls.map(([data]) => data).join("");
			expect(output).not.toContain("\u001b[2J");
			expect(output).not.toContain("\u001b[3J");
			expect(rebuild).not.toHaveBeenCalled();
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("prunes over-limit history without a clearing redraw", async () => {
		const { app, tui, terminal } = renderFixture();
		const write = vi.spyOn(terminal, "write");
		try {
			await app.start();
			tui.start();
			const internals = app as unknown as {
				messages: TranscriptMessage[];
				committedMessageCount: number;
				pruneTranscript(): void;
			};
			internals.messages = Array.from({ length: 1100 }, (_, index) => ({
				id: `m-${index}`,
				role: "assistant",
				kind: "text",
				text: `PRUNE_ROW_${index}`,
				streaming: false,
			})) as TranscriptMessage[];
			internals.committedMessageCount = 1100;
			write.mockClear();
			internals.pruneTranscript();
			expect(internals.messages.length).toBe(1000);
			expect(internals.committedMessageCount).toBe(1000);
			expect(internals.messages[0]).toMatchObject({ text: "PRUNE_ROW_100" });
			const output = write.mock.calls.map(([data]) => data).join("");
			expect(output).not.toContain("\u001b[2J");
			expect(output).not.toContain("\u001b[3J");
		} finally { tui.stop(); await app.dispose(); }
	});

	it("keeps the live splash unique when the viewport reflows", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-splash-early-"));
		const { app, tui, terminal } = renderFixture(home);
		const rebuild = vi.spyOn(tui, "reflowViewport");
		try {
			await app.start();
			app.setStartupSurface(renderSplash(80, theme, 1, app.startupStatus()));
			tui.start();
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getViewport().join("\n")).toContain("◈ VSPi");
			});
			terminal.resize(60, 24);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.flush();
			expect(rebuild).toHaveBeenCalledTimes(1);
			const buffer = terminal.getScrollBuffer();
			expect(buffer.filter((line) => line.includes("◈ VSPi"))).toHaveLength(1);
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("keeps one blank row between sections across the commit boundary and rebuild", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-gap-"));
		const { app, tui, terminal, events } = renderFixture(home);
		try {
			await app.start();
			tui.start();
			events().onBusy(true);
			for (let index = 0; index < 40; index++) {
				events().onMessage({ id: `gap-${index}`, role: "assistant", kind: "text", text: `GAP_${index}`, streaming: false });
				await new Promise((resolve) => setTimeout(resolve, 45));
				await terminal.flush();
			}
			events().onBusy(false);
			await vi.waitFor(async () => {
				await terminal.flush();
				expect(terminal.getScrollBuffer().join("\n")).toContain("GAP_39");
			});
			const assertSingleGap = (buffer: string[], upto: number) => {
				for (let index = 0; index + 1 < upto; index++) {
					const here = buffer.findIndex((line) => line.includes(`GAP_${index}`));
					const next = buffer.findIndex((line) => line.includes(`GAP_${index + 1}`));
					expect(here, `GAP_${index} present`).toBeGreaterThanOrEqual(0);
					expect(next, `GAP_${index + 1} present`).toBeGreaterThanOrEqual(0);
					const between = buffer.slice(here + 1, next);
					expect(between, `rows between GAP_${index} and GAP_${index + 1}`).toHaveLength(1);
					expect(between[0]!.trim(), `blank row between GAP_${index} and GAP_${index + 1}`).toBe("");
				}
			};
			assertSingleGap(terminal.getScrollBuffer(), 40);
			terminal.resize(60, 24);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.flush();
			assertSingleGap(terminal.getScrollBuffer(), 40);
		} finally { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

  it('opens side questions while the main agent runs and closes without interrupting it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vspi-side-'));
    const { app, backend, events } = renderFixture(home);
    const side = { send: vi.fn(async () => {}), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const cancelMain = vi.fn(async () => {});
    backend.cancel = cancelMain;
    let receive: Parameters<NonNullable<ChatBackend['startSideQuestion']>>[0] | undefined;
    backend.startSideQuestion = vi.fn(async listener => { receive = listener; return side; });
    try {
      await app.start();
      events().onBusy(true);
      app.composer.setText('/side 解释当前设计'); app.handleInput('\r');
      await vi.waitFor(() => expect(side.send).toHaveBeenCalledWith('解释当前设计'));
      receive?.({ kind: 'answer', delta: '每个服务拥有独立生命周期。' });
      expect(app.render(100).map(stripTerminalSequences).join('\n')).toContain('每个服务拥有独立生命周期');
      app.handleInput('\u0003');
      await vi.waitFor(() => expect(side.cancel).toHaveBeenCalledOnce());
      receive?.({ kind: 'ended', reason: 'cancelled' });
      app.handleInput('\u001B');
      await vi.waitFor(() => expect(side.close).toHaveBeenCalledOnce());
      expect(cancelMain).not.toHaveBeenCalled();
      expect(resolveCommand('/btw')?.id).toBe('btw');
      expect(resolveCommand('/side')?.id).toBe('btw');
    } finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
  });

	it('copies a completed reply through the SSH terminal from the slash command', async () => {
		vi.stubEnv('SSH_CONNECTION', 'example'); vi.stubEnv('TMUX', ''); vi.stubEnv('TMUX_PANE', '');
		const home = await mkdtemp(join(tmpdir(), 'vspi-copy-'));
		const { app, terminal, events } = renderFixture(home);
		const write = vi.spyOn(terminal, 'write');
		try {
			await app.start();
			events().onMessage({ id: 'reply', role: 'assistant', kind: 'text', text: 'hello' });
      events().onMessage({ id: 'progress', role: 'assistant', kind: 'text', text: 'still working', presentation: 'intermediate' });
			app.composer.setText('/copy'); app.handleInput('\r');
			await vi.waitFor(() => expect(write).toHaveBeenCalledWith('\u001B]52;c;aGVsbG8=\u0007'));
			expect(app.render(120).map(stripTerminalSequences).join('\n')).not.toContain('没有可用的系统剪贴板');
		} finally { write.mockRestore(); await app.dispose(); await rm(home, { recursive: true, force: true }); vi.unstubAllEnvs(); }
	});

	it('sends the image attachment when Enter follows a pasted image path immediately', async () => {
		const home = await mkdtemp(join(tmpdir(), 'vspi-path-paste-'));
		const path = join(home, 'example image.png');
		await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', 'base64'));
		const { app, backend } = renderFixture(home);
		Object.assign(backend, { supportsVision: true });
		const original = backend.start;
		backend.start = async events => { await original(events); events.onSessionReset?.({ id: 'layout-test', reason: 'resume', effort: 'high' }); };
		const send = vi.fn(async () => {}); backend.send = send;
		try {
			await app.start();
			app.handleInput(`\u001B[200~"${path}"\u001B[201~\r`);
			await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
			expect(send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ attachments: [expect.objectContaining({ mimeType: 'image/png', width: 1, height: 1 })] }));
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it('keeps a pending model switch in the dock until the backend confirms the call boundary', async () => {
		const home = await mkdtemp(join(tmpdir(), 'vspi-model-boundary-'));
		const { app, events } = renderFixture(home);
		try {
			await app.start();
			events().onModelSwitchPending?.({ from: 'example/old', to: 'example/new' });
			const pending = app.render(120).map(stripTerminalSequences).join('\n');
			expect(pending).toContain('模型待生效');
			expect(pending).toContain('example/old → example/new');
			expect(pending).not.toContain('模型 --------');
			events().onMessage({ id: 'model-switch:1:2', role: 'assistant', kind: 'session', text: '模型 example/old → example/new', presentation: { kind: 'modelSwitch', from: 'example/old', to: 'example/new' } });
			events().onModelSwitchPending?.(undefined);
			const applied = app.render(120).map(stripTerminalSequences).join('\n');
			expect(applied).not.toContain('模型待生效');
			expect(applied).toContain('模型 example/old → example/new');
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it('keeps a cancelled undelivered steer out of the transcript', async () => {
		const home = await mkdtemp(join(tmpdir(), 'vspi-steer-cancel-'));
		const { app, backend, events } = renderFixture(home);
		const send = vi.fn<ChatBackend['send']>(async () => ({ status: 'queued', delivery: 'steer' }));
		backend.send = send;
		try {
			await app.start();
			events().onBusy(true);
			app.composer.setText('Queued instruction');
			app.handleInput('\r');
			await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
			const id = send.mock.calls[0]?.[1].clientMessageId;
			expect(id).toBeDefined();
			events().onPromptLifecycle?.(id!, 'cancelled');
			const output = app.render(120).map(stripTerminalSequences).join('\n');
			expect(output).toContain('已取消 · 未送达');
			expect(output).toContain('Queued instruction');
			expect(output).not.toContain('〔队列已取消〕');
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it('does not bring the Core consumed label back when history is restored', async () => {
		const home = await mkdtemp(join(tmpdir(), 'vspi-consumed-history-'));
		const { app, events } = renderFixture(home);
		try {
			await app.start();
			events().onHistory?.([{ id: 'restored', role: 'user', kind: 'text', text: '示例用户消息', delivery: 'steer', deliveryState: 'consuming' }], false);
			const output = app.render(120).map(stripTerminalSequences).join('\n');
			expect(output).toContain('示例用户消息');
			expect(output).not.toContain('Core 已消费');
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("removes the retry status from the rendered screen when recovery clears it", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-retry-notice-"));
		const { app, events } = renderFixture(home);
		try {
			await app.start();
			events().onRetryNotice?.("第 2/3 次尝试");
			expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("第 2/3 次尝试");
			events().onRetryNotice?.(undefined);
			expect(app.render(160).map(stripTerminalSequences).join("\n")).not.toContain("第 2/3 次尝试");
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("opens a saved feedback preview after explicit context selection without uploading", async () => {
		vi.stubEnv('KIMI_CODE_EXPERIMENTAL_VSPI_FEEDBACK', 'true');
		const home = await mkdtemp(join(tmpdir(), 'vspi-feedback-ui-'));
		const { app, backend, events } = renderFixture(home);
		backend.feedbackContext = () => ({ home });
		try {
			await app.start();
			events().onMessage({ id: 'example-error', role: 'assistant', kind: 'error', summary: 'example connection error', detail: 'example diagnostic', expanded: false });
			app.composer.setText('/feedback example failure');
			app.handleInput('\r');
      await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join('\n')).toContain('最近一轮'));
			app.handleInput('\r'); app.handleInput('\r');
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join('\n')).toContain('Feedback 预览'));
			app.handleInput('\u001B');
			expect(app.render(160).map(stripTerminalSequences).join('\n')).toContain('本地反馈包已保留');
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); vi.unstubAllEnvs(); }
	});

	it("collects a description when feedback is opened from the command menu", async () => {
		vi.stubEnv('KIMI_CODE_EXPERIMENTAL_VSPI_FEEDBACK', 'true');
		const home = await mkdtemp(join(tmpdir(), 'vspi-feedback-description-'));
		const { app, backend } = renderFixture(home);
		backend.feedbackContext = () => ({ home });
		try {
			await app.start(); app.composer.setText('/feedback'); app.handleInput('\r');
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join('\n')).toContain('Question'));
			app.handleInput('example problem'); app.handleInput('\r'); app.handleInput('\r');
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join('\n')).toContain('最近一轮'));
			app.handleInput('\u001B');
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); vi.unstubAllEnvs(); }
	});

	it("preserves an unrelated warning when the retry status is cleared", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-retry-warning-"));
		const { app, events } = renderFixture(home);
		try {
			await app.start();
			events().onRetryNotice?.("第 2/3 次尝试");
			events().onNotice("独立的配置警告", "warning");
			events().onRetryNotice?.(undefined);
			expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("独立的配置警告");
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("opens the main model picker without reading secondary model configuration", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-main-model-isolation-"));
		const { app, backend } = renderFixture(home);
		const getSubagent = vi.fn(async () => ({ models: { "example/code": "Review" } }));
		backend.getSubagentModelPreferences = getSubagent;
		try {
			await app.start();
			app.composer.setText("/model");
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("输入名称、ID 或 Provider 筛选"));
			expect(getSubagent).not.toHaveBeenCalled();
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("does not switch the model when effort confirmation is cancelled", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-model-confirmation-"));
		const { app, backend } = renderFixture(home);
		backend.getModelOptions = async () => [{ id: "target", alias: "example/target", provider: "example", brand: "Example", label: "Target", curated: true, vision: false, efforts: ["off", "high", "max"], defaultEffort: "high", price: {}, contextWindow: 8192 }];
		backend.getPreferredModelEffort = async () => ({ effort: "max" });
		const select = vi.fn();
		backend.selectModel = select;
		try {
			await app.start();
			app.composer.setText("/model");
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("官方推荐"));
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("确认后切换"));
			expect(select).not.toHaveBeenCalled();
			app.handleInput("\u001B");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("当前模型与 Effort 保持不变"));
			expect(select).not.toHaveBeenCalled();
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("confirms a model with its remembered effort in one backend operation", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-model-effort-commit-"));
		const { app, backend } = renderFixture(home);
		backend.getModelOptions = async () => [{ id: "target", alias: "example/target", provider: "example", brand: "Example", label: "Target", curated: true, vision: false, efforts: ["off", "high", "max"], defaultEffort: "high", price: {}, contextWindow: 8192 }];
		backend.getPreferredModelEffort = async () => ({ effort: "max" });
		const select = vi.fn(async () => ({ modelId: "target", profileModelId: "target", vision: false, contextWindow: 8192, effort: "max" }));
		backend.selectModel = select;
		const setEffort = vi.fn();
		backend.setEffort = setEffort;
		try {
			await app.start();
			app.composer.setText("/model");
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("官方推荐"));
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("确认后切换"));
			app.handleInput("\r");
			await vi.waitFor(() => expect(select).toHaveBeenCalledWith("example", "target", "max"));
			expect(setEffort).not.toHaveBeenCalled();
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("omits Off from the effort picker even when the provider advertises it", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.openEffort("max", ["off", "high", "max"]);
		const output = panels.render(100, 12, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).not.toContain("Off");
		expect(panels.handleInput("\r")).toEqual({ type: "effort", effort: "max" });
	});

	it("preserves the selected effort when a model catalog refresh arrives", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.openEffort("max", ["high", "max"]);
		panels.setModels([{ id: "target", provider: "example", brand: "Example", label: "Target", curated: true, vision: false, efforts: ["high", "max"], price: {} }]);
		expect(panels.handleInput("\r")).toEqual({ type: "effort", effort: "max" });
	});

	it("confirms a fixed model without presenting a fake Off option", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.openEffort("off", ["off"]);
		const output = panels.render(100, 12, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).toContain("没有可调 Effort");
		expect(output).not.toContain("Off");
		expect(panels.handleInput("\r")).toEqual({ type: "effort", effort: "off" });
	});

	it("routes the dedicated subagent command to core candidate edits", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-subagent-model-command-"));
		const { app, backend } = renderFixture(home);
		backend.getModelOptions = async () => [{ id: "code", alias: "example/code", provider: "example", brand: "Example", label: "Code", vision: false, efforts: ["high"], price: {}, contextWindow: 4096 }];
		backend.getSubagentModelPreferences = async () => ({ models: {} });
		const update = vi.fn(async () => ({ models: { "example/code": "" }, defaultModel: "example/code" }));
		backend.updateSubagentModelPreferences = update;
		try {
			await app.start();
			app.composer.setText("/subagent-model");
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("secondary_model"));
			app.handleInput("\r");
			await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ action: "toggle", model: "example/code" }));
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("keeps a confirmed policy in the status footer when the policy panel is reopened", async () => {
		const { app, setPolicy } = renderFixture();
		try {
			app.composer.setText("/policy");
			app.handleInput("\r");
			for (let i = 0; i < 3; i += 1) app.handleInput("\u001B[A");
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.startupStatus().policy).toBe("Safe"));
			app.composer.setText("/policy");
			app.handleInput("\r");
			app.handleInput("\r");
			await vi.waitFor(() => expect(setPolicy).toHaveBeenCalledTimes(2));
			expect(setPolicy).toHaveBeenLastCalledWith("Safe");
		} finally { await app.dispose(); }
	});

	it("shows a daemon policy update instead of the frontend default", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-policy-test-"));
		const { app, events } = renderFixture(home);
		try {
			await app.start();
			events().onPolicySnapshot?.({ policy: "Standard", boundary: "Host", sandboxed: false, recovery: false, sessionAllowlist: [] });
			expect(app.startupStatus().policy).toBe("Standard");
		} finally {
			await app.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});

	it("keeps a newer daemon policy when an older policy request completes late", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-policy-race-"));
		const { app, events, setPolicy } = renderFixture(home);
		let release: ((snapshot: PolicySnapshot) => void) | undefined;
		try {
			await app.start();
			setPolicy.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
			app.composer.setText("/policy");
			app.handleInput("\r");
			app.handleInput("\u001B[A");
			app.handleInput("\r");
			await vi.waitFor(() => expect(release).toBeTypeOf("function"));
			events().onPolicySnapshot?.({ policy: "Standard", boundary: "Host", sandboxed: false, recovery: false, sessionAllowlist: [] });
			release!({ policy: "YOLO", boundary: "Host", sandboxed: false, recovery: false, sessionAllowlist: [] });
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("Policy 已切换为 Standard"));
			expect(app.startupStatus().policy).toBe("Standard");
		} finally {
			release?.({ policy: "Standard", boundary: "Host", sandboxed: false, recovery: false, sessionAllowlist: [] });
			await app.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});

	it("offers Goal argument candidates after /goal ", async () => {
		const empty = await GOAL_SLASH_COMMAND.getArgumentCompletions?.("");
		expect(empty?.map((item) => item.value)).toEqual([
			"status",
			"pause",
			"resume",
			"cancel",
			"accept",
			"--rounds ",
			"--no-progress ",
			"--tokens ",
		]);

		const narrowed = await GOAL_SLASH_COMMAND.getArgumentCompletions?.("p");
		expect(narrowed?.map((item) => item.value)).toEqual(["pause"]);
	});

	it("applies a Goal completion without losing /goal ", async () => {
		const result = await GOAL_SLASH_COMMAND.getArgumentCompletions?.("p");
		const item = result?.[0];
		expect(item).toBeDefined();
		if (!item) return;
		const provider = new CombinedAutocompleteProvider([GOAL_SLASH_COMMAND], "/tmp");
		const applied = provider.applyCompletion(["/goal p"], 0, 7, item, "p");
		expect(applied.lines[0]).toBe("/goal pause");
		expect(applied.cursorCol).toBe(11);
	});

	it("formats inline Goal hints without changing ordinary objectives", () => {
		expect(goalInlineHint("/goal ")).toBe("[status]|pause|resume|cancel|accept|--rounds|--no-progress|--tokens");
		expect(goalInlineHint("/goal p")).toBe("[pause]");
		expect(goalInlineHint("/goal review the release")).toBeUndefined();
		expect(goalInlineHint("/goal p", false)).toBeUndefined();
	});

	it("keeps completion descriptions available for muted SelectList rendering", async () => {
		const items = await GOAL_SLASH_COMMAND.getArgumentCompletions?.("");
		expect(items?.every((item) => item.description)).toBe(true);
	});

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

	it('stages the global VSPLab route and only emits it when settings are saved', () => {
		const panels = new PanelController({ ...DEFAULT_SETTINGS, scope: 'global' });
		panels.open('settings');
		const render = () => panels.render(100, 40, theme, DEFAULT_USAGE).map(stripTerminalSequences).join('\n');
		expect(render()).toContain('cn · 无 SNI 直连');
		for (let index = 0; index < 11; index++) panels.handleInput('\u001B[B');
		expect(panels.handleInput(' ')).toBeUndefined();
		expect(render()).toContain('tech · 常规连接');
		expect(panels.render(80, 14, theme, DEFAULT_USAGE).map(stripTerminalSequences).join('\n')).toContain('VSPLab 线路');
		expect(panels.handleInput('\u0013')).toMatchObject({ type: 'settings', vsplabEndpoint: 'tech' });
		panels.handleInput('\u001B');
		panels.open('settings');
		expect(render()).toContain('cn · 无 SNI 直连');
	});

	it('does not let project settings change the global VSPLab route', () => {
		const global = { ...DEFAULT_SETTINGS, scope: 'global' as const };
		const project = { ...DEFAULT_SETTINGS, scope: 'project' as const };
		const panels = new PanelController(project);
		panels.setSettingsLayers({ global, project, projectInherited: false });
		panels.setVsplabEndpoint('tech');
		panels.open('settings');
		for (let index = 0; index < 11; index++) panels.handleInput('\u001B[B');
		expect(panels.handleInput(' ')).toMatchObject({ type: 'notice', text: expect.stringContaining('全局') });
		expect(panels.handleInput('\u0013')).toMatchObject({ type: 'notice', text: '设置没有变化' });
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
		expect(rail).toContain("待插入 2");
		expect(rail).toContain("待发送 1");

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
		expect(entering0).toContain("待插入");
		expect(entering0).toContain("等待下一次模型调用");
		expect(entering1).toContain("待插入");
		expect(entering0).not.toBe(entering1);
		const settling = stripTerminalSequences(
			renderQueuedMessage(steer, 80, theme, {
				phase: "settling",
				frame: 0,
				reducedMotion: false,
			}),
		);
		expect(settling).toContain("待插入");
		expect(settling).not.toContain("↪");

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
		).toContain("待发送");
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
				panels: { kind: "plan" },
				agentsDock: { hasActive: () => false },
				taskSnapshot: { agents: [], processes: [], questions: [] },
				options: { settings: { reducedMotion: true, workingStyle: 1 } },
				renderReady: false,
				requestRender,
				tui: { mode: "fullscreen", terminal: { setProgress: vi.fn() } },
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
			imagePathPaste: { reset: vi.fn() },
			archivedMessageIds: new Set(),
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
			frozenNodeRows: new Map(),
			committedNodeIds: new Set(),
			liveSections: [],
			liveSectionsBase: 0,
			liveTranscriptRows: 0,
			activityPresentationActive: true,
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

	it("centers the model switch label in a full-width rule", () => {
		const width = 80;
		const lines = renderTranscriptMessage({
			id: 'switch', role: 'assistant', kind: 'session', text: '模型 A → B',
			presentation: { kind: 'modelSwitch', from: 'A', to: 'B' },
		}, width, theme).map(stripTerminalSequences);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBe(width);
		const match = lines[0]!.match(/^([─-]+) 模型 A → B ([─-]+)$/u);
		expect(match).not.toBeNull();
		expect(Math.abs(match![1]!.length - match![2]!.length)).toBeLessThanOrEqual(1);
	});

	it.each([4, 24])("fits a long model switch into %i columns without wrapping", (width) => {
		const lines = renderTranscriptMessage({
			id: 'switch', role: 'assistant', kind: 'session', text: '模型切换',
			presentation: { kind: 'modelSwitch', from: 'example/very-long-model', to: 'example/another-long-model' },
		}, width, theme).map(stripTerminalSequences);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBe(width);
	});

	function stubQueuedApp(queued: TranscriptMessage, messages: TranscriptMessage[]) {
		return Object.assign(Object.create(VspiApp.prototype), {
			queuedMessages: new Map([[queued.id, queued]]),
			queuedPresentations: new Map(),
			messages,
			options: { settings: { reducedMotion: false } },
			queuedAnimationTick: 0,
			syncActivityPresentation: vi.fn(),
			requestRender: vi.fn(),
		}) as {
			queuedMessages: Map<string, TranscriptMessage>;
			queuedPresentations: Map<string, { phase: string; startedTick: number }>;
			messages: TranscriptMessage[];
			queueMessagePresentation(id: string): void;
			updateQueuedMessageLifecycle(
				id: string,
				phase: "queued" | "consuming" | "started" | "completed",
			): void;
		};
	}

	it("keeps queued steer in the dock until consuming", () => {
		const queued = {
			id: "queued-steer",
			role: "user",
			kind: "text",
			text: "Inspect changes",
			delivery: "steer",
			deliveryState: "queued",
		} satisfies TranscriptMessage;
		const app = stubQueuedApp(queued, [
			{ id: "user-1", role: "user", kind: "text", text: "Earlier" },
		]);

		app.queueMessagePresentation(queued.id);
		expect(app.messages.map((message) => message.id)).toEqual(["user-1"]);
		expect(app.queuedPresentations.get(queued.id)?.phase).toBe("entering");

		app.updateQueuedMessageLifecycle(queued.id, "consuming");
		expect(app.messages.map((message) => message.id)).toEqual([
			"user-1",
			"queued-steer",
		]);
		expect(app.queuedMessages.has(queued.id)).toBe(false);
		expect(app.messages.at(-1)).toMatchObject({
			deliveryState: "consuming",
		});
	});

	it("renders a steered message exactly once when the backend echoes it during delivery", () => {
		const queued = {
			id: "steer-1",
			role: "user",
			kind: "text",
			text: "排队等下一轮",
			delivery: "steer",
			deliveryState: "queued",
		} satisfies TranscriptMessage;
		const app = stubQueuedApp(queued, [
			{ id: "user-0", role: "user", kind: "text", text: "前面那条" },
		]);

		app.queueMessagePresentation(queued.id);
		// 后端把同一 clientMessageId 回显进时间线（queued 状态下到达）。
		app.messages.push({
			id: queued.id,
			role: "user",
			kind: "text",
			text: queued.text,
		});

		for (const phase of ["consuming", "started", "completed"] as const)
			app.updateQueuedMessageLifecycle(queued.id, phase);

		const rendered = renderTranscript(app.messages, 90, theme)
			.map(stripTerminalSequences)
			.join("\n");
		expect(rendered.match(/排队等下一轮/g)).toHaveLength(1);
		expect(rendered).not.toContain("↳");
		expect(rendered).not.toContain("待插入");
	});

	it.each(['consuming', 'completed'] as const)("does not render internal delivery labels for %s user messages", deliveryState => {
		const output = renderTranscriptMessage(
			{
				id: "steer-completed",
				role: "user",
				kind: "text",
				text: "继续处理",
				delivery: "steer",
				deliveryState,
			},
			90,
			theme,
		).map(stripTerminalSequences).join("\n");
		expect(output).toContain("继续处理");
		expect(output).not.toContain("已完成");
		expect(output).not.toContain('Core');
		expect(output).not.toContain('已消费');
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

	it("formats subagent labels only at the UI boundary", () => {
		expect(formatSubagentProfile("coder")).toBe("Coder");
		expect(formatSubagentProfile("explore")).toBe("Explore");
		expect(formatSubagentProfile("plan")).toBe("Plan");
		expect(formatSubagentModel("openai/gpt-5.6-sol")).toBe("GPT 5.6 Sol");
		expect(formatSubagentProviderModel("openai", "gpt-5.6-sol")).toBe(
			"OpenAI / GPT 5.6 Sol",
		);

		const message: TranscriptMessage = {
			id: "subagent:display",
			role: "assistant",
			kind: "subagent",
			model: "openai/gpt-5.6-sol",
			preferredModel: "openai/gpt-5.5",
			agentRole: "worker",
			effort: "medium",
			contextMode: "isolated",
			task: "Inspect the repository",
			status: "running",
			agentKind: "task",
		};
		const output = renderTranscriptMessage(message, 100, theme)
			.map(stripTerminalSequences)
			.join("\\n");
		expect(output).toContain("Worker · GPT 5.6 Sol");
		expect(output).toContain("preferred GPT 5.5");
		expect(output).not.toContain("openai/gpt-5.6-sol");
		expect(message.model).toBe("openai/gpt-5.6-sol");
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

	it("keeps exactly one blank line between consecutive blocks", () => {
		const messages: TranscriptMessage[] = [
			{
				id: "tool-1",
				role: "assistant",
				kind: "tool",
				groupId: "g1",
				name: "Bash",
				summary: "echo stub-bash-done",
				status: "success",
				expanded: false,
				durationMs: 5000,
				output: "stub-bash-done",
			},
			{ id: "user-1", role: "user", kind: "text", text: "再加一句测试看看" },
			{
				id: "thinking-1",
				role: "assistant",
				kind: "thinking",
				effort: "high",
				text: "分析",
				collapsed: true,
			},
			{ id: "assistant-1", role: "assistant", kind: "text", text: "全部完成。" },
		];
		const output = renderTranscript(messages, 80, theme).map(stripTerminalSequences);
		const blank = (line: string) => line.trim() === "";
		// 任何相邻两个非空行之间不得出现连续两行及以上空行；底色内边距行也算分隔行。
		for (let i = 0; i < output.length - 1; i += 1) {
			expect(
				!(blank(output[i]!) && blank(output[i + 1]!)),
				`double blank at lines ${i}-${i + 1}:\n${output.join("\n")}`,
			).toBe(true);
		}
		const toolTail = output.findIndex((line) => line.includes("stub-bash-done") && line.includes("→"));
		const userLine = output.findIndex((line) => line.includes("▌"));
		expect(userLine - toolTail).toBe(2);
		const thinkingHeader = output.findIndex((line) => line.includes("思考"));
		expect(thinkingHeader - userLine).toBe(2);
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
		expect(output[0]).toContain("◇  思考");
		expect(output[0]).not.toContain("Effort");
		expect(output[1]?.trimEnd()).toBe("   分析");
		expect(output).toContain("");
		expect(output.find((line) => line.includes("工具调用"))).toContain(
			"◇  工具调用",
		);
	});

	it("shows a ctrl+b background hint on running Bash tool rows only", () => {
		const messages: TranscriptMessage[] = [
			{
				id: "bash-running",
				role: "assistant",
				kind: "tool",
				name: "Bash",
				summary: "pnpm test",
				status: "running",
				expanded: false,
			},
			{
				id: "bash-done",
				role: "assistant",
				kind: "tool",
				name: "Bash",
				summary: "git status",
				status: "success",
				expanded: false,
			},
			{
				id: "agent-running",
				role: "assistant",
				kind: "tool",
				name: "Agent",
				summary: "探查模块",
				status: "running",
				expanded: false,
			},
		];

		const output = renderTranscript(messages, 80, theme, {}).map(
			stripTerminalSequences,
		);

		expect(output.join("\n")).toContain("pnpm test · 运行中 · ctrl+b 转后台");
		expect(output.join("\n")).toContain("git status");
		expect(output.join("\n")).not.toContain("git status · ctrl+b");
		expect(output.join("\n")).toContain("探查模块 · 运行中");
		expect(output.join("\n")).not.toContain("探查模块 · 运行中 · ctrl+b");
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
		expect(rows[1]).toContain("\u001B[1m");
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

	it("does not leak thinking boundary markers while preserving body text", () => {
		const thinking: TranscriptMessage = {
			id: "thinking-boundaries",
			role: "assistant",
			kind: "thinking",
			effort: "medium",
			text: "**Planning cache clearing and process restart**\nClearing cache directories before restart****Determining cache relevance\nClearing Claude CLI cache only****Verifying cache cleanup\n\n`literal **** stars`\n```text\ncode **** stars\n```",
			collapsed: false,
		};
		const expanded = renderTranscript([thinking], 100, theme, {
			thinkingDisplay: "expanded",
		}).map(stripTerminalSequences).join("\n");
		expect(expanded).not.toContain("restart****Determining");
		expect(expanded).not.toContain("only****Verifying");
		expect(expanded).toMatch(/restart\s*\n\s*\n\s*Determining cache relevance/u);
		expect(expanded).toMatch(/only\s*\n\s*\n\s*Verifying cache cleanup/u);
		expect(expanded).toContain("literal **** stars");
		expect(expanded).toContain("code **** stars");

		const collapsed = renderTranscript(
			[{ ...thinking, text: "**Verifying cache cleanup**", collapsed: true }],
			100,
			theme,
			{ thinkingDisplay: "collapsed" },
		).map(stripTerminalSequences).join("\n");
		expect(collapsed).toContain("Verifying cache cleanup");
	});

	it("keeps fullscreen row frames lossless when similar panel rows move", () => {
		const optimizer = new TerminalFrameOptimizer();
		const begin = "\u001B[?2026h";
		const end = "\u001B[?2026l";
		const cursor = "\u001B[10;1H\u001B[?25h";
		const frame = (lines: readonly string[], fullRedraw = false) =>
			`${begin}${fullRedraw ? "\u001B[2J" : ""}${lines
				.map((line, index) => `\u001B[${index + 1};1H\u001B[2K${line}`)
				.join("")}${cursor}${end}`;
		const initial = `${begin}\u001B[?1049h\u001B[2J${Array.from(
			{ length: 10 },
			(_, index) => `\u001B[${index + 1};1H\u001B[2Kpanel-${String(index)}`,
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
		expect(resolveCommand("/subagent-model")?.id).toBe("subagent-model");
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

	it.each(['k3', 'kimi-k3'])('shows both K3 identities without switching the currently selected %s', id => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const models: ModelOption[] = ['k3', 'kimi-k3'].map(id => ({ id, provider: 'example', alias: `example/${id}`, brand: 'Example', label: 'Kimi K3', wireId: id, curated: true, vision: true, efforts: ['high'], price: {} }));
		panels.setModels(models, [], { provider: 'example', id });
		panels.open('models');
		const output = panels.render(160, 16, theme, DEFAULT_USAGE).map(stripTerminalSequences).join('\n');
		expect(output).toContain('模型 ID');
		expect(output).toContain('kimi-k3, k3');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id, alias: `example/${id}` } });
		panels.handleInput('\u001B[B');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id } });
	});

	it('merges arbitrary configuration names that point to the same actual model', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels(['review-fast', 'daily-coder'].map(id => ({ id, wireId: 'qwen3.8-max', provider: 'example', brand: 'Example', label: 'Qwen 3.8 Max', curated: true, vision: false, efforts: ['high'], price: {} })), [], { provider: 'example', id: 'daily-coder' });
		panels.open('models');
		panels.handleInput('review-fast');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id: 'daily-coder', displayIds: ['review-fast', 'qwen3.8-max', 'daily-coder'] } });
	});

	it('keeps the alias group focused when an external model selection or catalog refresh arrives', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const models: ModelOption[] = ['kimi-k3', 'k3'].map(id => ({ id, wireId: id, provider: 'example', brand: 'Example', label: 'Kimi K3', curated: true, vision: true, efforts: ['high'], price: {} }));
		panels.setModels(models, [], { provider: 'example', id: 'kimi-k3' });
		panels.open('models');
		panels.confirmModelSelection({ provider: 'example', id: 'k3' });
		panels.setModels(models.toReversed(), [], { provider: 'example', id: 'k3' });
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id: 'k3', displayIds: ['kimi-k3', 'k3'] } });
	});

	it('does not guess aliases solely from matching display names', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels(['model-a', 'model-b'].map(id => ({ id, provider: 'example', brand: 'Example', label: 'Same Display Name', curated: true, vision: false, efforts: ['high'], price: {} })));
		panels.open('models');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id: 'model-a' } });
		panels.handleInput('\u001B[B');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id: 'model-b' } });
	});

	it('combines an explicit alias chain into a single model row', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const base: ModelOption = { id: 'primary', provider: 'example', brand: 'Example', label: 'Example Model', curated: true, vision: false, efforts: ['high'], price: {} };
		panels.setModels([{ ...base, modelAliases: ['middle'] }, { ...base, id: 'last' }, { ...base, id: 'middle', modelAliases: ['last'] }]);
		panels.open('models');
		panels.handleInput('last');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { displayIds: ['primary', 'middle', 'last'] } });
		panels.handleInput('\u001B[B');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id: 'primary' } });
	});

	it('orders subagent candidates by family without merging their independently configured aliases', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels([
			['a-review', 'kimi-k3'], ['b-chat', 'gpt-6-astra'], ['c-code', 'k3'],
		].map(([id, wireId]) => ({ id: id!, wireId, alias: `example/${id}`, provider: 'example', brand: 'Example', label: id!, vision: false, efforts: ['high'], price: {} })));
		panels.open('subagentModels');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'subagentModel', edit: { model: 'example/b-chat' } });
		panels.handleInput('\u001B[B');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'subagentModel', edit: { model: 'example/a-review' } });
		panels.handleInput('\u001B[B');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'subagentModel', edit: { model: 'example/c-code' } });
	});

	it('finds a catalog-declared alias even when it has no separate model row', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels([{ id: 'deepseek-flash', wireId: 'deepseek-flash', modelAliases: ['deepseek-v4.1-flash'], provider: 'example', brand: 'Example', label: 'DeepSeek V4.1 Flash', curated: true, vision: true, efforts: ['high'], price: {} }]);
		panels.open('models');
		panels.handleInput('deepseek-v4.1-flash');
		expect(panels.handleInput('\r')).toMatchObject({ type: 'model', model: { id: 'deepseek-flash', displayIds: ['deepseek-flash', 'deepseek-v4.1-flash'] } });
	});

	it.each(['provider', 'protocol', 'endpoint', 'wireId'])('does not merge matching labels when the models differ by %s', field => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const first: ModelOption = { id: 'k3', wireId: 'k3', provider: 'example', protocol: 'openai', endpoint: 'https://example.test/v1', brand: 'Example', label: 'Kimi K3', curated: true, vision: true, efforts: ['high'], price: {} };
		const values = { provider: 'other', protocol: 'anthropic', endpoint: 'https://other.example.test/v1', wireId: 'different-model' };
		panels.setModels([first, { ...first, id: 'kimi-k3', [field]: values[field as keyof typeof values] }]);
		panels.open('models');
		const before = panels.handleInput('\r');
		panels.handleInput('\u001B[B');
		expect(panels.handleInput('\r')).not.toEqual(before);
	});

	it('keeps K3 context variants distinct while grouping the aliases within each variant', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels(['k3', 'kimi-k3', 'k3-256k', 'kimi-k3-256k'].map(id => ({ id, wireId: id, provider: 'example', brand: 'Example', label: id, curated: true, vision: true, efforts: ['high'], price: {} })));
		panels.open('models');
		// 打开时焦点落在当前模型（排序靠后的 k3 组），向上进入 256k 变体行。
		const first = panels.handleInput('\r');
		panels.handleInput('\u001B[A');
		const second = panels.handleInput('\r');
		expect(first).not.toEqual(second);
		panels.handleInput('\u001B[B');
		expect(panels.handleInput('\r')).toEqual(first);
	});

	it('keeps family members adjacent before applying release dates and price ordering', () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels([
			['gpt-5.6-sol', 'GPT 5.6 Sol', '2026-04-01', 10],
			['kimi-k3', 'Kimi K3', '2026-07-16', 15],
			['claude-opus-5', 'Claude Opus 5', '2026-08-01', 25],
			['gpt-6-astra', 'GPT 6 Astra', '2026-08-15', 30],
			['claude-fable-5', 'Claude Fable 5', '2026-09-01', 5],
		].map(([id, label, releasedAt, price]) => ({ id: String(id), label: String(label), releasedAt: String(releasedAt), brand: 'Example', provider: 'example', curated: true, vision: false, efforts: ['high'], price: { inputUsdPerMillion: Number(price), outputUsdPerMillion: Number(price) } })));
		panels.open('models');
		// 打开时焦点落在当前模型行，先回到列表顶部再逐行读取顺序。
		for (let index = 0; index < 5; index++) panels.handleInput('\u001B[A');
		const ids: string[] = [];
		for (let index = 0; index < 5; index++) {
			const event = panels.handleInput('\r');
			if (event?.type === 'model') ids.push(event.model.id);
			panels.handleInput('\u001B[B');
		}
		expect(ids).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'claude-fable-5', 'claude-opus-5', 'kimi-k3']);
	});

	it.each([36, 120])('keeps model identity aliases readable at %s columns', width => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels(['k3', 'kimi-k3'].map(id => ({ id, provider: 'example', brand: 'Example', label: 'Kimi K3', curated: true, vision: true, efforts: ['high'], price: {} })));
		panels.open('models');
		panels.render(width, 16, theme, DEFAULT_USAGE);
		panels.handleInput('\u001B[C');
		const lines = panels.render(width, 16, theme, DEFAULT_USAGE);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		const output = lines.map(stripTerminalSequences).join('\n');
		expect(output).toContain('kimi-k3, k3');
	});

	it.each(["5.3 flash", "vsplab"])(
		"finds GLM 5.3 Flash by %s",
		(query) => {
			const panels = new PanelController(DEFAULT_SETTINGS);
			panels.setModels([
				{
					id: "glm-5.3-flash",
					provider: "vsplab",
					brand: "VSPLab",
					label: "GLM 5.3 Flash",
					curated: true,
					vision: false,
					efforts: ["off"],
					price: {},
				},
			]);
			panels.open("models");
			panels.handleInput(query);
			expect(panels.handleInput("\r")).toMatchObject({ type: "model", model: { id: "glm-5.3-flash", provider: "vsplab" } });
		},
	);

	it("repairs the subagent pool default when its current entry is removed", () => {
		const first = editSubagentModels({ models: {} }, { action: "toggle", model: "example/fast" });
		expect(first).toEqual({ models: { "example/fast": "" }, defaultModel: "example/fast" });
		const second = editSubagentModels(first, { action: "purpose", model: "example/code", purpose: " coding " });
		expect(second.models["example/code"]).toBe("coding");
		const removed = editSubagentModels(second, { action: "toggle", model: "example/fast" });
		expect(removed.defaultModel).toBe("example/code");
		expect(editSubagentModels(removed, { action: "toggle", model: "example/code" })).toEqual({ models: {}, defaultModel: undefined });
	});

	it("edits subagent candidates in their dedicated panel without switching the main model", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels([{ id: "code", alias: "example/code", provider: "example", brand: "Example", label: "Code", vision: false, efforts: ["off"], price: {} }]);
		panels.open("subagentModels");
		expect(panels.handleInput("\u0013")).toEqual({ type: "subagentModel", edit: { action: "toggle", model: "example/code" } });
		expect(panels.handleInput("\u0004")).toEqual({ type: "subagentModel", edit: { action: "default", model: "example/code" } });
		panels.handleInput("\u0010");
		panels.handleInput("review");
		expect(panels.handleInput("\r")).toEqual({ type: "subagentModel", edit: { action: "purpose", model: "example/code", purpose: "review" } });
	});

	it("does not include a nonrecommended subagent candidate in the main recommended list", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const model = (id: string, curated: boolean) => ({ id, alias: `example/${id}`, provider: "example", brand: "Example", label: id, vision: false, efforts: ["off"], price: {}, curated });
		panels.setModels([model("new", true), model("old", false), model("starred", false)], [], { provider: "example", id: "new" });
		panels.setSubagentModelPreferences({ models: { "example/starred": "analysis" }, defaultModel: "example/starred" });
		panels.open("models");
		const output = panels.render(120, 20, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).toContain("官方推荐");
		expect(output).not.toContain("starred");
		expect(output).not.toContain("analysis");
		expect(panels.renderHint(120, theme)).not.toContain("子模型");
		expect(panels.handleInput("\u0013")).toBeUndefined();
		panels.handleInput("old");
		// 搜索覆盖全部模型，不限于官方推荐（修复 M3）。
		expect(panels.handleInput("\r")).toMatchObject({ type: "model", model: { id: "old" } });
	});

	it("shows an unavailable configured subagent reference so the user can remove it", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels([]);
		panels.setSubagentModelPreferences({ models: { "example/retired": "Review tasks" }, defaultModel: "example/retired" });
		panels.open("subagentModels");
		const output = panels.render(120, 16, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).toContain("example/retired");
		expect(output).toContain("接入暂不可用");
		expect(output).not.toContain("★");
		expect(panels.handleInput("\r")).toEqual({ type: "subagentModel", edit: { action: "toggle", model: "example/retired" } });
	});

	it.each([36, 120])("keeps the dedicated candidate panel within %s columns", (width) => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setSubagentModelPreferences({ models: { "example/long-model-reference-for-specialized-code-review": "检查实现边界与测试覆盖" } });
		panels.open("subagentModels");
		for (const line of panels.render(width, 12, theme, DEFAULT_USAGE)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		panels.handleInput("\u0010");
		for (const line of panels.render(width, 8, theme, DEFAULT_USAGE)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("keeps a forced core subagent configuration read-only in the candidate panel", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setSubagentModelPreferences({ models: { "example/code": "" }, defaultModel: "example/code", force: true });
		panels.open("subagentModels");
		expect(panels.handleInput("\r")).toBeUndefined();
		expect(panels.handleInput("\u0004")).toBeUndefined();
		expect(panels.render(120, 16, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n")).toContain("force=true");
	});

	it("returns to recommended models when the main picker is reopened", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels([{ id: "other", brand: "Example", label: "Other", vision: false, efforts: ["high"], price: {} }]);
		panels.open("models");
		expect(panels.handleInput("\r")).toBeUndefined();
		panels.handleInput("\u000F");
		expect(panels.handleInput("\r")).toMatchObject({ type: "model", model: { id: "other" } });
		panels.close();
		panels.open("models");
		expect(panels.handleInput("\r")).toBeUndefined();
	});

	it("recognizes only the approved recommended model identities", () => {
		for (const id of ["gpt-6-sol", "kimi-k3", "deepseek/deepseek-flash", "vsplab/deepseek-v4.1-flash"]) {
			expect(isOfficialRecommendedModel(id)).toBe(true);
		}
		for (const id of ["deepseek-v4-flash", "example-model"]) {
			expect(isOfficialRecommendedModel(id)).toBe(false);
		}
	});

	it("matches a pending recommendation only when the catalog supplies its exact approved name", () => {
		expect(isOfficialRecommendedModel("new-provider-id", "Kimi K2.8 Preview")).toBe(true);
		expect(isOfficialRecommendedModel("new-provider-id", "Kimi K2.8 Other")).toBe(false);
	});

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

	it.each(["columns", "detail"])("renders the terminal agent failure in the %s view after a long conversation", (view) => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const run = panelsFailedAgentRun();
		panels.setAgentSnapshot({ ...panelsAgentSnapshot(run), active: [], recent: [run] });
		panels.open("agents");
		if (view === "detail") panels.handleInput("\r");
		panels.setAgentConversation({
			runId: run.id, agentId: run.agentId, tokenCount: 60, totalBlocks: 60,
			blocks: Array.from({ length: 60 }, (_, index) => ({
				id: `commentary-${String(index)}`, kind: "commentary", sourceRole: "assistant", text: `Process line ${String(index)}`, injected: false, presentation: "message",
			})),
		});
		const output = panels.render(140, 18, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).toContain("PROVIDER_FAILURE_DIAGNOSTIC");
		expect(output).toContain("运行时限：2 小时");
	});

	it("shows a configured agent timeout as a resumable deadline rather than an unexplained error", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const base = panelsFailedAgentRun();
		const run: AgentRunSnapshot = { ...base, error: undefined, status: "timed_out", budget: { ...base.budget, maxRunSeconds: 1_800 } };
		panels.setAgentSnapshot({ ...panelsAgentSnapshot(run), active: [], recent: [run] });
		panels.open("agents");
		const output = panels.render(140, 18, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).toContain("运行时限：30 分钟");
		expect(output).toContain("已达到运行时限");
		expect(output).toContain("可恢复同一 Agent 继续");
	});

	it("removes terminal escape sequences from an agent failure reason", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const run = { ...panelsFailedAgentRun(), error: "Failure\u001B[2Jdetail" };
		panels.setAgentSnapshot({ ...panelsAgentSnapshot(run), active: [], recent: [run] });
		panels.open("agents");
		const output = panels.render(140, 18, theme, DEFAULT_USAGE).join("\n");
		expect(output).not.toContain("\u001B[2J");
		expect(stripTerminalSequences(output)).toContain("Failuredetail");
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

		expect(panels.selectedAgentRunIdForPreview()).toBe("task-alpha");
		panels.setAgentConversation({
			runId: "task-alpha",
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
		const compactOutput = panels
			.render(72, 18, theme, DEFAULT_USAGE)
			.map(stripTerminalSequences)
			.join("\n");
		expect(compactOutput).toContain("Coder");
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
			runId: "task-alpha",
		});
		panels.setAgentConversation({
			runId: "task-alpha",
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
		panels.handleInput("\u001B[A");
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
		panels.handleInput("\u001B[6~");
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
		expect(panels.handleInput("\u001B[C")).toEqual({
			type: "agentOpen",
			runId: "task-beta",
		});
		expect(detailState.agentConversation).toBeUndefined();
		expect(detailState.agentConversationLoading).toBe(true);
		expect(detailState.agentActivity).toEqual([]);
		expect(detailState.agentDetailFollowTail).toBe(true);
		expect(detailState.state).toMatchObject({ selected: 1, scroll: 0 });
		expect(panels.handleInput("\u001B[C")).toBeUndefined();
		expect(panels.handleInput("\u001B[D")).toEqual({
			type: "agentOpen",
			runId: "task-alpha",
		});
		expect(panels.handleInput("\u001B")).toEqual({
			type: "agentConversationClose",
		});
		expect(panels.handleInput("\u001B")).toEqual({ type: "close" });

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
		panels.handleInput("\u001B[B");
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

		expect(wide.startsWith("Runtime · Waiting · 2 scheduled")).toBe(true);
		expect(wide.endsWith("Goal · 执行中")).toBe(true);
		expect(constrained.startsWith("Runtime · Waiting")).toBe(true);
		expect(constrained).not.toContain("scheduled");
		expect(constrained.endsWith("Goal · 执行中")).toBe(true);
		expect(narrow).toBe("Runtime · Waiting");
		expect(withoutGoal.startsWith("Runtime · Waiting · 2 scheduled")).toBe(true);
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

	it("treats scheduled cron as Waiting and keeps no-pending as Idle", () => {
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
		expect(scheduled.startsWith("Runtime · Waiting · 2 scheduled")).toBe(true);
		expect(scheduled).toContain("Waiting");
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
		// Working 只由 composer 上方的活动横幅表达，Runtime 行不再重复状态词。
		expect(working).toBe("Runtime · 1 Agent · 1 Process");
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

		// 未知成本不再渲染占位符，该行不出现 ¥ 金额。
		expect(unknown[1]).not.toContain("¥");
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
		expect(lines[0]).toContain("Speed ~42.8 tok/s");
		expect(lines[0]).toContain("Context 61K / 128K 48%");
		expect(lines[1]).toContain("~/Workspace/VSPi · Auto");
		expect(lines[1]).toContain("Total ↑ 18.4k ↓ 3.2k");
		expect(lines[1]).toContain("Cache read 12.7k · turn 39%");
		expect(lines[1]).not.toContain("Cache 12.7k");
		expect(lines[0]?.endsWith("Context 61K / 128K 48%")).toBe(true);
		expect(lines[1]?.endsWith("¥0.08")).toBe(true);
		expect(lines.join("\n")).not.toMatch(/Model|Effort|Host/);
	});

	it("renders million-scale cumulative tokens without overflowing the footer", () => {
		const usage = {
			...DEFAULT_USAGE,
			contextTokens: 259_000,
			contextWindow: 1_000_000,
			contextPercent: 26,
			inputTokens: 14_068_985,
			outputTokens: 86_198,
			cacheReadTokens: 13_469_770,
			recentCacheHitPercent: 50,
		};
		const input = {
			cwd: "~/Workspace/VSPi",
			usage,
			modelLabel: "GPT-5.6",
			effort: "high" as const,
			busy: false,
			policy: "Auto",
		};
		const wide = renderStatusLines(input, 120, theme).map(stripTerminalSequences);
		const narrow = renderStatusLines(input, 80, theme).map(stripTerminalSequences);

		expect(wide).toHaveLength(2);
		for (const line of wide) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		expect(wide[1]).toContain("Total ↑ 14.1M ↓ 86.2k");
		expect(wide[1]).toContain("Cache read 13.5M · turn 50%");
		expect(wide[0]).toContain("Context 259K / 1M 26%");
		expect(narrow).toHaveLength(2);
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it.each([60, 79, 80, 119, 120, 160])("keeps cache metrics complete at %i columns", (width) => {
		const lines = renderStatusLines({
			cwd: "/example", modelLabel: "Example", effort: "high", busy: false,
			usage: { ...DEFAULT_USAGE, cacheReadTokens: 999_949_999, recentCacheHitPercent: 100 },
		}, width, theme).map(stripTerminalSequences);
		expect(lines[1]).toContain(width < 120 ? "Cache 100%" : "Cache read 999M · turn 100%");
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
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
		expect(lines[0]).toContain("Speed ~42.8 tok/s");
		expect(lines[0]?.endsWith("Context 61K / 128K 48%")).toBe(true);
		expect(lines[1]).not.toContain("—");
	});

	function liveAgentPanelFixture() {
		const run: AgentRunSnapshot = { ...panelsFailedAgentRun(), status: "running", error: undefined, finishedAt: undefined };
		const snapshot = panelsAgentSnapshot(run);
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setAgentSnapshot(snapshot);
		panels.open("agents");
		panels.handleInput("\r");
		panels.setAgentConversation({ runId: run.id, agentId: run.agentId, blocks: [], tokenCount: 0 });
		const state = panels as unknown as {
			agentActivity: AgentConversationActivity[];
			agentProcessRevision: number;
			agentProcessCache: unknown;
			agentSnapshot: AgentSnapshot;
			taskSnapshot: TaskDashboardSnapshot;
			agentToolActivity: Map<string, number>;
			agentDetailFollowTail: boolean;
			state: { selected: number; scroll: number };
			renderAgentProcess(width: number, theme: ReturnType<typeof createTheme>): string[];
		};
		return { panels, run, snapshot, state };
	}

	it("preserves all Agent deltas in one stable text block beyond 100 events", () => {
		const { panels, state } = liveAgentPanelFixture();
		const chunks = Array.from({ length: 1_000 }, (_, index) => `DELTA_${index}_中 `);
		for (const delta of chunks) panels.appendAgentActivity({ kind: "assistant", turnId: 7, delta });
		expect(state.agentActivity).toHaveLength(1);
		expect(state.agentActivity[0]).toEqual({ kind: "assistant", turnId: 7, delta: chunks.join("") });
		const output = state.renderAgentProcess(120, theme).map(stripTerminalSequences).join("\n");
		expect(output).toContain("DELTA_0_中");
		expect(output.match(/● Commentary/gu)).toHaveLength(1);
	});

	it("keeps Agent commentary and tools chronological while merging progress updates", () => {
		const { panels, state } = liveAgentPanelFixture();
		panels.appendAgentActivity({ kind: "assistant", turnId: 7, delta: "COMMENTARY_BEFORE" });
		panels.appendAgentActivity({ kind: "tool", turnId: 7, state: "started", toolCallId: "read-1", toolName: "Read", text: "Starting" });
		for (let index = 0; index < 500; index++) panels.appendAgentActivity({ kind: "tool", turnId: 7, state: "progress", toolCallId: "read-1", text: `PROGRESS_${index}` });
		panels.appendAgentActivity({ kind: "tool", turnId: 7, state: "completed", toolCallId: "read-1", text: "TOOL_COMPLETE" });
		panels.appendAgentActivity({ kind: "assistant", turnId: 7, delta: "COMMENTARY_AFTER" });
		expect(state.agentActivity).toHaveLength(3);
		expect(state.agentActivity[1]).toMatchObject({ kind: "tool", toolName: "Read", state: "completed", text: "TOOL_COMPLETE" });
		const output = state.renderAgentProcess(120, theme).map(stripTerminalSequences).join("\n");
		expect(output.indexOf("COMMENTARY_BEFORE")).toBeLessThan(output.indexOf("◇ Read"));
		expect(output.indexOf("◇ Read")).toBeLessThan(output.indexOf("COMMENTARY_AFTER"));
		expect(output.match(/◇ Read/gu)).toHaveLength(1);
		expect(output).toContain("TOOL_COMPLETE");
		expect(output).not.toContain("PROGRESS_499");
	});

	it("reuses Agent process layout across snapshots, hidden thinking, and duplicate progress", () => {
		const { panels, snapshot, state } = liveAgentPanelFixture();
		panels.appendAgentActivity({ kind: "assistant", turnId: 7, delta: "CACHED_COMMENTARY" });
		panels.appendAgentActivity({ kind: "tool", turnId: 7, state: "started", toolCallId: "read-1", toolName: "Read", text: "UNCHANGED_PROGRESS" });
		const first = state.renderAgentProcess(120, theme);
		const revision = state.agentProcessRevision;
		const agents = state.agentSnapshot;
		const tasks: TaskDashboardSnapshot = { agents: [], processes: [{ taskId: "process-1", kind: "process", description: "Check", status: "running", command: "example-command", pid: 42, exitCode: null, startedAt: 1_000, endedAt: null }], questions: [] };
		panels.setTaskSnapshot(tasks);
		const taskState = state.taskSnapshot;
		for (let index = 0; index < 20; index++) {
			panels.setAgentSnapshot(structuredClone(snapshot));
			panels.setTaskSnapshot(structuredClone(tasks));
			panels.appendAgentActivity({ kind: "thinking", turnId: 7, delta: "HIDDEN_THINKING" });
			panels.appendAgentActivity({ kind: "tool", turnId: 7, state: "started", toolCallId: "read-1", toolName: "Read", text: "UNCHANGED_PROGRESS" });
			expect(state.renderAgentProcess(120, theme)).toBe(first);
		}
		expect(state.agentSnapshot).toBe(agents);
		expect(state.taskSnapshot).toBe(taskState);
		expect(state.agentProcessRevision).toBe(revision);
		expect(state.agentActivity.some(activity => activity.kind === "thinking")).toBe(false);
		panels.appendAgentActivity({ kind: "assistant", turnId: 7, delta: "NEW_COMMENTARY" });
		expect(state.renderAgentProcess(120, theme)).not.toBe(first);
		const changed = state.renderAgentProcess(120, theme);
		expect(state.renderAgentProcess(60, theme)).not.toBe(changed);
		panels.setAgentConversation({ runId: snapshot.active[0]!.id, agentId: snapshot.active[0]!.agentId, tokenCount: 1, blocks: [{ id: "history-1", kind: "final", sourceRole: "assistant", text: "NEW_HISTORY_PAGE", injected: false }] });
		expect(state.renderAgentProcess(120, theme).map(stripTerminalSequences).join("\n")).toContain("NEW_HISTORY_PAGE");
		panels.prependAgentConversation({ runId: snapshot.active[0]!.id, agentId: snapshot.active[0]!.agentId, tokenCount: 2, blocks: [{ id: "history-0", kind: "commentary", sourceRole: "assistant", text: "OLDER_HISTORY_PAGE", injected: false }] });
		expect(state.renderAgentProcess(120, theme).map(stripTerminalSequences).join("\n")).toContain("OLDER_HISTORY_PAGE");
	});

	it("clears aggregated Agent blocks and process caches when switching child runs", () => {
		const { panels, run, snapshot, state } = liveAgentPanelFixture();
		panels.setAgentSnapshot({ ...snapshot, active: [run, { ...run, id: "second-run" }] });
		panels.appendAgentActivity({ kind: "assistant", turnId: 7, delta: "OLD_CHILD_TEXT" });
		panels.appendAgentActivity({ kind: "tool", turnId: 7, state: "started", toolCallId: "read-1", toolName: "Read", text: "OLD_CHILD_TOOL" });
		state.renderAgentProcess(120, theme);
		state.agentDetailFollowTail = false;
		state.state.scroll = 10;
		expect(panels.handleInput("\u001B[C")).toEqual({ type: "agentOpen", runId: "second-run" });
		expect(state.agentActivity).toEqual([]);
		expect(state.agentToolActivity.size).toBe(0);
		expect(state.agentProcessCache).toBeUndefined();
		expect(state.agentDetailFollowTail).toBe(true);
		expect(state.state.scroll).toBe(0);
		panels.appendAgentActivity({ kind: "assistant", turnId: 7, delta: "NEW_CHILD_TEXT" });
		const output = state.renderAgentProcess(120, theme).map(stripTerminalSequences).join("\n");
		expect(output).toContain("NEW_CHILD_TEXT");
		expect(output).not.toContain("OLD_CHILD");
	});

	it("isolates Agent conversation pages by run id when child ids repeat", () => {
		const runA = { id: "run-a", agentId: "child", codename: "same" };
		const runB = { id: "run-b", agentId: "child", codename: "same" };
		const panels = new PanelController(DEFAULT_SETTINGS);
		const snapshot = panelsAgentSnapshot as unknown as (run: AgentRunSnapshot) => AgentSnapshot;
		panels.setAgentSnapshot({ ...snapshot(runA as AgentRunSnapshot), active: [runA as AgentRunSnapshot, runB as AgentRunSnapshot] });
		panels.open("agents");
		panels.setAgentConversation({ runId: "run-a", agentId: "child", blocks: [{ id: "a", kind: "final", sourceRole: "assistant", text: "RUN_A_CONTENT", injected: false }], tokenCount: 1, totalBlocks: 1 });
		const state = panels as unknown as { state: { selected: number }; agentConversation?: { runId: string; blocks: Array<{ text: string }> } };
		state.state.selected = 1;
		panels.setAgentConversation({ runId: "run-a", agentId: "child", blocks: [], tokenCount: 2, totalBlocks: 0 });
		expect(state.agentConversation?.runId).toBe("run-a");
		panels.setAgentConversation({ runId: "run-b", agentId: "child", blocks: [], tokenCount: 3, totalBlocks: 0 });
		expect(state.agentConversation?.runId).toBe("run-b");
	});

	function taskNavigationFixture() {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const run = panelsFailedAgentRun();
		const agents = panelsAgentSnapshot(run);
		agents.active.push({ ...run, id: "second-agent", agentId: "second-child" });
		const snapshot: TaskDashboardSnapshot = {
			agents: agents.active.map((agent) => ({ kind: "agent", taskId: agent.id, description: "Agent job", status: "completed", startedAt: 0, endedAt: 1 })),
			processes: Array.from({ length: 20 }, (_, index) => ({
				kind: "process", taskId: `process-${index}`, description: `Process ${index}`, status: "running", startedAt: Date.now(), endedAt: null,
				command: `example-command-${index} ` + "long-argument ".repeat(20) + "COMMAND_END", pid: 1000 + index, exitCode: null,
			})),
			questions: [{ kind: "question", taskId: "last-question", description: "LAST_QUESTION", status: "running", startedAt: 0, endedAt: null, questionCount: 1 }],
		};
		panels.setAgentSnapshot(agents);
		panels.setTaskSnapshot(snapshot);
		panels.open("tasks");
		return { panels, agents, snapshot };
	}

	it("keeps every task reachable while Agent snapshots refresh", () => {
		const { panels, agents, snapshot } = taskNavigationFixture();
		for (let index = 0; index < snapshot.agents.length + snapshot.processes.length; index++) {
			panels.handleInput("\u001b[B");
			panels.setAgentSnapshot(agents);
			panels.setTaskSnapshot(snapshot);
			const output = panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("›"))).toBe(true);
			if (index >= 1 && index < 21) expect(output.find((line) => line.includes("›"))).toContain(`pid ${999 + index}`);
		}
		expect(panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n")).toContain("›");
		expect(panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n")).toContain("LAST_QUESTION");
	});

	it("preserves task identity across reorder and exposes the complete command", () => {
		const { panels, agents, snapshot } = taskNavigationFixture();
		panels.handleInput("\u001b[F");
		panels.handleInput("\u001b[A");
		const last = snapshot.processes.at(-1)!;
		panels.setTaskSnapshot({ ...snapshot, processes: [last, ...snapshot.processes.slice(0, -1)] });
		panels.setAgentSnapshot(agents);
		expect(panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).find((line) => line.includes("›"))).toContain("pid 1019");
		panels.handleInput("\r");
		const first = panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(first).toContain("Task · process-19");
		expect(first).toContain("PID: 1019");
		panels.handleInput("\u001b[6~");
		expect(panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n")).toContain("COMMAND_END");
		panels.handleInput("\u001b");
		expect(panels.kind).toBe("tasks");
		expect(panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).find((line) => line.includes("›"))).toContain("pid 1019");
		panels.handleInput("\u001b[H");
		panels.handleInput("\u001b[6~");
		expect(panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).find((line) => line.includes("›"))).toContain("pid 1005");
	});

	it("returns from task details when the selected task disappears", () => {
		const { panels, snapshot } = taskNavigationFixture();
		panels.handleInput("\u001b[F");
		panels.handleInput("\r");
		panels.setTaskSnapshot({ ...snapshot, questions: [] });
		const output = panels.render(80, 10, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).toContain("Tasks");
		expect(output).not.toContain("Task · last-question");
		expect(output).toContain("pid 1019");
	});

	it("renders multiline long process commands on one bounded row", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setTaskSnapshot({ agents: [], processes: [{ kind: "process", taskId: "process-long", description: "long bash", status: "running", startedAt: Date.now() - 12_000, endedAt: null, command: "printf 'first\nsecond' &&\n pnpm test " + "x".repeat(200), pid: 4242, exitCode: null }], questions: [] });
		panels.open("tasks");
		const width = 80;
		const processRow = panels.render(width, 20, theme, DEFAULT_USAGE).map(stripTerminalSequences).find((line) => line.includes("pid 4242"));
		expect(processRow).toBeDefined();
		expect(processRow).toContain("printf 'first second'");
		expect(processRow).toContain("· running ·");
		expect(processRow).toMatch(/\d+s/u);
		expect(visibleWidth(processRow ?? "")).toBeLessThanOrEqual(width);
	});

	it("focuses the current model when the picker opens", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const model = (id: string) => ({ id, provider: "example", brand: "Example", label: id, curated: true, vision: false, efforts: ["high"], price: {} });
		panels.setModels([model("first"), model("second"), model("third")], [], { provider: "example", id: "second" });
		panels.open("models");
		expect(panels.handleInput("\r")).toMatchObject({ type: "model", model: { id: "second" } });
	});

	it("shows a visible search row that searches every model from the common view", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		panels.setModels([
			{ id: "star", provider: "example", brand: "Example", label: "Star", curated: true, vision: false, efforts: ["high"], price: {} },
			{ id: "niche", provider: "other", brand: "Other", label: "Niche", curated: false, vision: false, efforts: ["high"], price: {} },
		]);
		panels.open("models");
		const output = panels.render(120, 16, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(output).toContain("搜索");
		expect(output).not.toContain("niche");
		panels.handleInput("niche");
		expect(panels.handleInput("\r")).toMatchObject({ type: "model", model: { id: "niche" } });
	});

	it("keeps the wide picker's divider on the same column for every body row", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const model = (id: string) => ({ id, provider: "example", brand: "Example", label: id, curated: true, vision: false, efforts: ["high"], price: {} });
		panels.setModels([model("first"), model("second"), model("third")]);
		panels.open("models");
		const lines = panels.render(120, 16, theme, DEFAULT_USAGE).map(stripTerminalSequences);
		const splitRows = lines.filter((line) => (line.match(/│/g)?.length ?? 0) >= 3);
		expect(splitRows.length).toBeGreaterThan(0);
		const dividerColumns = new Set(
			splitRows.map((line) => {
				const first = line.indexOf("│");
				const second = line.indexOf("│", first + 1);
				return visibleWidth(line.slice(0, second));
			}),
		);
		expect([...dividerColumns]).toHaveLength(1);
	});

	it("pins a model with Ctrl+P, re-sections it, and keeps focus by identity", () => {
		const panels = new PanelController(DEFAULT_SETTINGS);
		const model = (id: string) => ({ id, provider: "example", brand: "Example", label: id, curated: true, vision: false, efforts: ["high"], price: {} });
		panels.setModels([model("alpha"), model("beta")]);
		panels.open("models");
		expect(panels.handleInput("\u0010")).toEqual({ type: "modelPin", pinned: ["example\0alpha"] });
		const pinned = panels.render(120, 16, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n");
		expect(pinned).toContain("置顶");
		expect(pinned).toContain("官方推荐");
		expect(panels.handleInput("\r")).toMatchObject({ type: "model", model: { id: "alpha" } });
		expect(panels.handleInput("\u0010")).toEqual({ type: "modelPin", pinned: [] });
		expect(panels.render(120, 16, theme, DEFAULT_USAGE).map(stripTerminalSequences).join("\n")).not.toContain("置顶");
	});

	it("records a confirmed model in recent picks", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-model-recent-"));
		const { app, backend } = renderFixture(home);
		backend.getModelOptions = async () => [{ id: "target", alias: "example/target", provider: "example", brand: "Example", label: "Target", curated: true, vision: false, efforts: ["high"], price: {}, contextWindow: 8192 }];
		backend.getPreferredModelEffort = async () => ({ effort: "high" });
		backend.selectModel = async () => ({ modelId: "target", profileModelId: "target", vision: false, contextWindow: 8192, effort: "high" });
		try {
			await app.start();
			app.composer.setText("/model");
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("官方推荐"));
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("确认后切换"));
			app.handleInput("\r");
			await vi.waitFor(async () => {
				const picks = JSON.parse(await readFile(modelPicksPath(home), "utf8")) as { recent: string[] };
				expect(picks.recent).toContain("example\0target");
			});
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("does not record a recent model when the staged switch is cancelled", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-model-recent-cancel-"));
		const { app, backend } = renderFixture(home);
		backend.getModelOptions = async () => [{ id: "target", alias: "example/target", provider: "example", brand: "Example", label: "Target", curated: true, vision: false, efforts: ["high"], price: {}, contextWindow: 8192 }];
		backend.getPreferredModelEffort = async () => ({ effort: "high" });
		backend.selectModel = vi.fn();
		try {
			await app.start();
			app.composer.setText("/model");
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("官方推荐"));
			app.handleInput("\r");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("确认后切换"));
			app.handleInput("\u001B");
			await vi.waitFor(() => expect(app.render(160).map(stripTerminalSequences).join("\n")).toContain("当前模型与 Effort 保持不变"));
			await expect(readFile(modelPicksPath(home), "utf8")).rejects.toThrow();
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("clears the delivery badge once a steered message finishes", () => {
		const base: Extract<TranscriptMessage, { kind: "text" }> = {
			id: "steer-1", role: "user", kind: "text", text: "继续处理", delivery: "steer",
		};
		const render = (deliveryState: NonNullable<typeof base.deliveryState>) =>
			renderTranscriptMessage({ ...base, deliveryState }, 80, theme)
				.map(stripTerminalSequences)
				.join("\n");
		expect(render("consuming")).toContain("↳ 已送达模型");
		expect(render("completed")).not.toContain("↳");
		expect(render("failed")).toContain("↳ 回复失败");
		expect(render("cancelled")).toContain("↳ 队列已取消");
	});

	it("keeps the footer height constant when a notice replaces the runtime line", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-notice-height-"));
		const { app, events } = renderFixture(home);
		try {
			await app.start();
			const baseline = app.render(160).length;
			events().onRuntimeConnectionState?.("reconnecting", 1);
			const output = app.render(160);
			expect(output.length).toBe(baseline);
			expect(output.map(stripTerminalSequences).join("\n")).toContain("正在自动恢复");
		} finally { await app.dispose(); await rm(home, { recursive: true, force: true }); }
	});

	it("renders Agent tool rows with run details and a result summary", () => {
		const output = renderTranscriptMessage(
			{
				id: "agent-tool",
				role: "assistant",
				kind: "tool",
				name: "Agent",
				summary: "1 agent",
				status: "success",
				expanded: false,
				output: "调研完成：模块边界已确认\n补充细节",
				agentRuns: [
					{
						name: "图灵",
						task: "调研模块边界",
						profile: "explore",
						model: "example/model",
						status: "success",
						startedAt: "2026-09-12T00:00:00.000Z",
						finishedAt: "2026-09-12T00:01:05.000Z",
					},
				],
			},
			120,
			theme,
		).map(stripTerminalSequences).join("\n");
		expect(output).toContain("图灵");
		expect(output).toContain("调研模块边界");
		expect(output).toContain("1m05s");
		expect(output).toContain("→ 调研完成：模块边界已确认");
	});

	it("shows the [summary] result instead of agent output envelope lines", () => {
		const output = renderTranscriptMessage(
			{
				id: "agent-tool",
				role: "assistant",
				kind: "tool",
				name: "Agent",
				summary: "1 agent",
				status: "success",
				expanded: false,
				output: [
					"agent_id: agent-abc",
					"actual_subagent_type: explore",
					"status: completed",
					"stop_reason: completed",
					"",
					"[summary]",
					"调研完成：模块边界已确认",
					"",
					'resume_hint: Continue with Agent(resume="agent-abc", prompt="...").',
				].join("\n"),
				agentRuns: [{ name: "图灵", task: "调研模块边界", status: "success" }],
			},
			120,
			theme,
		).map(stripTerminalSequences).join("\n");
		expect(output).toContain("→ 调研完成：模块边界已确认");
		expect(output).not.toContain("→ agent_id:");
	});

	it("falls back to the task result when the Agent output is a background receipt", () => {
		const message = {
			id: "agent-tool",
			role: "assistant" as const,
			kind: "tool" as const,
			name: "Agent",
			summary: "1 agent",
			status: "success" as const,
			expanded: false,
			output: [
				"task_id: task-xyz",
				"status: running",
				"agent_id: agent-abc",
				"actual_subagent_type: explore",
				"automatic_notification: true",
				"",
				"description: 调研模块边界",
				"",
				"next_step: The completion arrives automatically in a later turn.",
				'resume_hint: call Agent(resume="agent-abc", prompt="...").',
			].join("\n"),
		};
		const withResult = renderTranscriptMessage(
			{ ...message, agentRuns: [{ name: "图灵", task: "调研模块边界", status: "background" as const, result: "后台子代理完成：已写入报告" }] },
			120,
			theme,
		).map(stripTerminalSequences).join("\n");
		expect(withResult).toContain("→ 后台子代理完成：已写入报告");
		expect(withResult).not.toContain("→ task_id:");
		const withoutResult = renderTranscriptMessage(
			{ ...message, agentRuns: [{ name: "图灵", task: "调研模块边界", status: "background" as const }] },
			120,
			theme,
		).map(stripTerminalSequences).join("\n");
		expect(withoutResult).not.toContain("→ ");
	});

	it("keeps dock rows ordered by start time across status changes", () => {
		const dock = new AgentsDock();
		const base = panelsFailedAgentRun();
		const older = {
			...base,
			id: "task-older",
			status: "running" as const,
			startedAt: "2026-09-12T00:00:00.000Z",
			finishedAt: undefined,
			codename: "旧成员",
			taskTitle: "较早任务",
			error: undefined,
		};
		const newer = {
			...base,
			id: "task-newer",
			status: "running" as const,
			startedAt: "2026-09-12T00:10:00.000Z",
			finishedAt: undefined,
			codename: "新成员",
			taskTitle: "较晚任务",
			error: undefined,
		};
		dock.setSnapshot({ ...panelsAgentSnapshot(older), active: [older, newer], recent: [] });
		const running = stripTerminalSequences(dock.render(140, theme).join("\n"));
		expect(running.indexOf("较早任务")).toBeGreaterThanOrEqual(0);
		expect(running.indexOf("较早任务")).toBeLessThan(running.indexOf("较晚任务"));
		dock.setSnapshot({
			...panelsAgentSnapshot(newer),
			active: [newer],
			recent: [{ ...older, status: "success" as const, finishedAt: "2026-09-12T00:05:00.000Z" }],
		});
		const finished = stripTerminalSequences(dock.render(140, theme).join("\n"));
		expect(finished.indexOf("较早任务")).toBeGreaterThanOrEqual(0);
		expect(finished.indexOf("较早任务")).toBeLessThan(finished.indexOf("较晚任务"));
	});
});
