import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { VspiApp } from "../../src/v1/app/vspi-app.js";
import { AttachmentService } from "../../src/v1/attachments/service.js";
import type {
	AgentRunSnapshot,
	AgentSnapshot,
} from "../../src/v1/agents/types.js";
import type {
	ChatBackend,
	ChatBackendEvents,
} from "../../src/v1/backend/types.js";
import { DEFAULT_SETTINGS } from "../../src/v1/domain/defaults.js";
import { detectTerminalCapabilities } from "../../src/v1/ui/capabilities.js";
import {
	ScrollbackProcessTerminal,
	ScrollbackTUI,
} from "../../src/v1/ui/scrollback-terminal.js";
import { createTheme } from "../../src/v1/ui/theme.js";

const home = process.argv[2]!;
const reportPath = process.argv[3]!;
const terminal = new ScrollbackProcessTerminal();
const tui = new ScrollbackTUI(terminal);
const theme = createTheme(
	detectTerminalCapabilities({ TERM: "xterm-256color", LANG: "zh_CN.UTF-8" }),
	"VSPi Dark",
);
let events: ChatBackendEvents;
let inputs = 0;
let inputMs = 0;
let maximumInputMs = 0;
let partialSurrogates = 0;
let writes = 0;
let bytes = 0;
let deferred = 0;
let revision = 0;
let reportSequence = 0;
let pressured = false;
let body = Array.from(
	{ length: 200 },
	(_, index) =>
		`PTY_HISTORY_${String(index).padStart(3, "0")} original content`,
).join("\n\n");
const backend: ChatBackend = {
	kind: "runtime",
	modelId: "example/model",
	modelLabel: "Example",
	supportsVision: false,
	start: async (listener) => {
		events = listener;
	},
	dispose: async () => {},
	send: async () => {},
	cancel: async () => {},
	compact: async () => false,
	newSession: async () => {},
	listSessions: async () => ({ items: [] }),
	switchSession: async () => {},
	setPolicy: async (policy) => ({
		policy,
		boundary: "Host",
		sandboxed: false,
		recovery: false,
		sessionAllowlist: [],
	}),
};
const app = new VspiApp(tui, theme, backend, {
	cwd: "/workspace",
	home,
	settings: { ...DEFAULT_SETTINGS, summarizeSessionTitleOnExit: false },
	attachments: new AttachmentService("pty-pressure", theme, { home }),
	onExit() {},
});
const write = terminal.write.bind(terminal);
terminal.write = (data) => {
	writes++;
	bytes += Buffer.byteLength(data);
	write(data);
};
const defer = terminal.deferRender.bind(terminal);
terminal.deferRender = (render) => {
	const result = defer(render);
	if (result) deferred++;
	return result;
};

function report(): void {
	const draft = app.composer.getText();
	writeFileSync(
		reportPath,
		JSON.stringify({
			sequence: ++reportSequence,
			inputs,
			inputMs,
			maximumInputMs,
			partialSurrogates,
			writes,
			bytes,
			deferred,
			pressured,
			revision,
			characters: draft.length,
			hash: createHash("sha256").update(draft).digest("hex"),
			tty: process.stdin.isTTY && process.stdout.isTTY,
		}),
	);
}

function snapshot(status: "running" | "success"): AgentSnapshot {
	const run: AgentRunSnapshot = {
		id: "pty-agent",
		agentId: "pty-child",
		treeId: "pty-tree",
		kind: "task",
		depth: 1,
		model: "example/model",
		provider: "example",
		role: "worker",
		profile: "coder",
		modelReason: "requested",
		effort: "medium",
		contextMode: "isolated",
		contextChars: 0,
		task: "Example work",
		progress: `Step ${revision}`,
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
			maxRunSeconds: 7200,
			warnRunTokens: false,
			warnTreeTokens: false,
			warnTreeCost: false,
			warnElapsed: false,
		},
		timeline: [],
		status,
		background: true,
		resumed: false,
	};
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
			maxRunSeconds: 7200,
		},
		pools: [],
		active: status === "running" ? [run] : [],
		recent: status === "success" ? [run] : [],
		teammates: [],
		authority: {
			pendingRequired: [],
			turnOverrides: [],
			sessionOverrides: [],
			taskEpoch: 0,
		},
	};
}

const start = terminal.start.bind(terminal);
terminal.start = (onInput, onResize) => {
	start((data) => {
		if (data === "\u001B[90~") {
			report();
			return;
		}
		if (data === "\u001B[91~") {
			app.composer.setText("草稿".repeat(20000));
			tui.requestRender();
			report();
			return;
		}
		if (data === "\u001B[92~") {
			revision++;
			const status = revision < 8 ? "running" : "success";
			events.onMessageUpdate("legacy-agent", {
				status,
				task: `Example work step ${revision}`,
			});
			events.onAgentSnapshot?.(snapshot(status));
			events.onTaskSnapshot?.({ agents: [], processes: [], questions: [] });
			body += `\n\nPTY_STREAM_${String(revision).padStart(3, "0")}`;
			events.onMessageUpdate("history", { text: body });
			return;
		}
		if (data === "\u001B[93~") {
			process.stdout.cork();
			process.stdout.write(`\u001B]0;${"pressure".repeat(40000)}\u0007`);
			pressured = process.stdout.writableNeedDrain;
			body += "\n\nPTY_DRAIN_RESUMED";
			events.onMessageUpdate("history", { text: body });
			tui.requestRender();
			setTimeout(() => {
				process.stdout.uncork();
			}, 150);
			report();
			return;
		}
		if (data === "\u001B[94~") {
			tui.stop();
			void app.dispose().then(() => process.exit(0));
			return;
		}
		const started = performance.now();
		inputs++;
		const codePoint = data.codePointAt(0) ?? 0;
		if (
			data.length === 1 &&
			codePoint >= 0xd800 &&
			codePoint <= 0xdfff
		)
			partialSurrogates++;
		onInput(data);
		const elapsed = performance.now() - started;
		inputMs += elapsed;
		maximumInputMs = Math.max(maximumInputMs, elapsed);
	}, onResize);
};
tui.addChild(app);
tui.setFocus(app);
await app.start();
events!.onMessage({
	id: "legacy-agent",
	kind: "subagent",
	role: "assistant",
	model: "example/model",
	effort: "medium",
	task: "Example work",
	status: "running",
});
events!.onMessage({
	id: "history",
	kind: "text",
	role: "assistant",
	text: body,
	streaming: false,
});
tui.start();
report();
