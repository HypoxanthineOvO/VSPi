import { describe, expect, it, vi } from "vitest";

import type { ExecIo, ExecOptions } from "../src/exec.js";
import {
	detectExecOutput,
	dispatchExecCommand,
	ExecUsageError,
	parseExecArgs,
	readExecPrompt,
	resolveExecModel,
	runExec,
} from "../src/exec.js";
import { normalizeCatalogEffort } from "../src/v1/domain/effort.js";

class EventSource {
	private readonly listeners = new Map<string, Set<(event: any) => void>>();
	private readonly errors = new Set<(error: Error) => void>();

	on(name: string, listener: (event: any) => void) {
		const listeners = this.listeners.get(name) ?? new Set();
		listeners.add(listener);
		this.listeners.set(name, listeners);
		return { dispose: () => listeners.delete(listener) };
	}

	onError(listener: (error: Error) => void) {
		this.errors.add(listener);
		return { dispose: () => this.errors.delete(listener) };
	}

	emit(name: string, event: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) listener(event);
	}

	emitError(error: Error): void {
		for (const listener of this.errors) listener(error);
	}

	listenerCount(): number {
		return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0) + this.errors.size;
	}
}

const model = (
	provider: string,
	alias: string,
	efforts = ["low", "high"],
) => ({
	provider,
	model: alias,
	max_context_size: 128_000,
	thinking: {
		availability: "dynamic" as const,
		can_disable: true,
		controls: ["effort" as const],
		efforts,
		default_effort: efforts[0],
	},
});

function options(overrides: Partial<ExecOptions> = {}): ExecOptions {
	return {
		prompt: "hello",
		stdin: false,
		cwd: process.cwd(),
		output: "text",
		session: "new",
		continueLatest: false,
		help: false,
		...overrides,
	};
}

function io(overrides: Partial<ExecIo> = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let signal: (() => void) | undefined;
	let adds = 0;
	let removes = 0;
	const value: ExecIo = {
		stdinIsTTY: true,
		readStdin: vi.fn(async () => "stdin prompt\n"),
		stdout: (chunk) => stdout.push(chunk),
		stderr: (chunk) => stderr.push(chunk),
		onSignal: (listener) => {
			adds += 1;
			signal = listener;
		},
		offSignal: (listener) => {
			if (signal === listener) signal = undefined;
			removes += 1;
		},
		...overrides,
	};
	return {
		value,
		stdout,
		stderr,
		signal: () => signal?.(),
		listener: () => signal,
		adds: () => adds,
		removes: () => removes,
	};
}

interface FixtureConfig {
	readonly models?: ReturnType<typeof model>[];
	readonly summaries?: any[];
	readonly exact?: any;
	readonly restore?: boolean;
	readonly interactions?: any[];
	readonly bindError?: Error;
	readonly promptError?: Error;
	readonly deleteError?: Error;
	readonly onPrompt?: (
		events: EventSource,
		sessionEvents: EventSource,
		input: { promptId: string },
	) => Promise<{ turn_id: number } | undefined> | { turn_id: number } | undefined;
}

function fixture(config: FixtureConfig = {}) {
	const events = new EventSource();
	const sessionEvents = new EventSource();
	const calls: string[] = [];
	const bindProfile = vi.fn(async (input) => {
		calls.push(`bind:${JSON.stringify(input)}`);
		if (config.bindError !== undefined) throw config.bindError;
	});
	const setModel = vi.fn(async (value) => {
		calls.push(`model:${value}`);
	});
	const setThinking = vi.fn(async (value) => {
		calls.push(`thinking:${value}`);
	});
	const setPermission = vi.fn(async (value) => {
		calls.push(`permission:${value}`);
	});
	const getModel = vi.fn(async () => "wire-k2");
	const cancel = vi.fn(async () => undefined);
	const prompt = vi.fn(async (input: { promptId: string }) => {
		calls.push(`prompt:${input.promptId}`);
		if (config.promptError !== undefined) throw config.promptError;
		if (config.onPrompt !== undefined) return config.onPrompt(events, sessionEvents, input);
		events.emit("turn.started", { turnId: 7, promptId: input.promptId });
		events.emit("assistant.delta", { turnId: 7, delta: "final " });
		events.emit("thinking.delta", { turnId: 7, delta: "secret" });
		events.emit("assistant.delta", { turnId: 7, delta: "answer" });
		events.emit("turn.ended", { turnId: 7, reason: "completed" });
		return { turn_id: 7 };
	});
	const deleteSession = vi.fn(async () => {
		if (config.deleteError !== undefined) throw config.deleteError;
	});
	const interactions = config.interactions ?? [];
	const session = {
		restore: vi.fn(async () => config.restore ?? true),
		get: vi.fn(async () => ({ id: "session-1", cwd: process.cwd() })),
		delete: deleteSession,
		agent: vi.fn(() => ({
			events,
			bindProfile,
			getModel,
			setModel,
			setThinking,
			setPermission,
			cancel,
			prompt,
		})),
		events: sessionEvents,
		interactions: {
			list: vi.fn(async () => interactions),
			respond: vi.fn(async () => undefined),
		},
	};
	const summaries = config.summaries ?? [];
	const klient = {
		global: {
			workspaces: { createOrTouch: vi.fn(async ({ root }) => ({ id: "workspace-1", root })) },
			sessions: {
				create: vi.fn(async () => ({ id: "session-1" })),
				list: vi.fn(async () => ({ items: summaries })),
				get: vi.fn(async () => config.exact),
			},
			kosong: {
				listModels: vi.fn(async () => config.models ?? [model("kimi", "wire-k2")]),
				listProviders: vi.fn(async () => [{ id: "kimi", type: "kimi" }]),
			},
			config: {
				get: vi.fn(async (domain: string) => domain === "defaultModel" ? "wire-k2" : { effort: "low" }),
			},
		},
		session: vi.fn(() => session),
	} as any;
	return {
		klient,
		session,
		events,
		sessionEvents,
		calls,
		bindProfile,
		setModel,
		setThinking,
		setPermission,
		cancel,
		prompt,
		deleteSession,
	};
}

const RESULT_KEYS = [
	"error",
	"exitCode",
	"sessionId",
	"status",
	"text",
	"turnId",
	"type",
	"version",
];

function parsedLines(chunks: readonly string[]): any[] {
	return chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function emitLater(events: EventSource, name: string, event: unknown): void {
	queueMicrotask(() => {
		events.emit(name, event);
	});
}

describe("exec command machine output", () => {
	it("detects output before later parse failures and emits exact JSON keys", async () => {
		expect(detectExecOutput(["--output", "json", "--bad"])).toBe("json");
		const stream = io();
		const connect = vi.fn();
		const exits: number[] = [];
		await dispatchExecCommand(["exec", "--output", "json", "--bad"], {
			connect,
			io: stream.value,
			setExitCode: (code) => exits.push(code),
		});
		const result = JSON.parse(stream.stdout.join(""));
		expect(Object.keys(result).toSorted()).toEqual(RESULT_KEYS);
		expect(result).toMatchObject({ version: 1, type: "result", status: "failed", exitCode: 2 });
		expect(stream.stderr).toEqual([]);
		expect(connect).not.toHaveBeenCalled();
		expect(exits).toEqual([2]);
	});

	it.each([
		["stdin", async () => {
			const stream = io({ stdinIsTTY: false, readStdin: async () => { throw new Error("stdin failed"); } });
			return { stream, connect: vi.fn() };
		}],
		["connect", async () => ({ stream: io(), connect: vi.fn(async () => { throw new Error("connect failed"); }) })],
	])("emits structured JSONL for %s failure with empty stderr", async (_name, setup) => {
		const { stream, connect } = await setup();
		const exits: number[] = [];
		await dispatchExecCommand(["exec", "--output", "jsonl"], {
			connect,
			io: stream.value,
			setExitCode: (code) => exits.push(code),
		});
		const rows = parsedLines(stream.stdout);
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]).toSorted()).toEqual([...RESULT_KEYS, "sequence"].toSorted());
		expect(rows[0]).toMatchObject({ version: 1, sequence: 1, type: "result", status: "failed" });
		expect(stream.stderr).toEqual([]);
		expect(exits[0]).toBeGreaterThan(0);
	});

	it("turns close failure into the only structured failed result", async () => {
		const fake = fixture();
		const stream = io();
		const close = vi.fn(async () => { throw new Error("close failed"); });
		await dispatchExecCommand(["exec", "--output", "json", "hello"], {
			connect: async () => ({ klient: fake.klient, close }),
			io: stream.value,
		});
		const result = JSON.parse(stream.stdout.join(""));
		expect(result).toMatchObject({ status: "failed", exitCode: 1, error: "close failed", text: "final answer" });
		expect(stream.stderr).toEqual([]);
		expect(stream.stdout).toHaveLength(1);
	});

	it("keeps the original run error when close also fails", async () => {
		const fake = fixture({ bindError: new Error("bind failed") });
		const stream = io();
		await dispatchExecCommand(["exec", "--output", "json", "hello"], {
			connect: async () => ({ klient: fake.klient, close: async () => { throw new Error("close failed"); } }),
			io: stream.value,
		});
		expect(JSON.parse(stream.stdout.join("")).error).toBe("bind failed");
		expect(stream.stderr).toEqual([]);
	});

	it("keeps empty and oversized stdin failures structured in machine modes", async () => {
		for (const error of ["Prompt is required", "stdin exceeds 1048576 bytes"]) {
			const stream = io({
				stdinIsTTY: false,
				readStdin: async () => {
					if (error.startsWith("stdin")) throw new ExecUsageError(error);
					return "";
				},
			});
			await dispatchExecCommand(["exec", "--output", "json"], {
				connect: vi.fn(),
				io: stream.value,
			});
			expect(JSON.parse(stream.stdout.join(""))).toMatchObject({
				status: "failed",
				exitCode: 2,
				error,
			});
			expect(stream.stderr).toEqual([]);
		}
	});

	it("uses stderr only for text failures", async () => {
		const stream = io();
		await dispatchExecCommand(["exec", "--bad"], { connect: vi.fn(), io: stream.value });
		expect(stream.stdout).toEqual([]);
		expect(stream.stderr.join("")).toContain("Unknown option");
	});
});

describe("exec parser and stdin", () => {
	it("does not read stdin for help", async () => {
		const stream = io({ stdinIsTTY: false });
		await dispatchExecCommand(["exec", "--help"], { connect: vi.fn(), io: stream.value });
		expect(stream.value.readStdin).not.toHaveBeenCalled();
		expect(stream.stdout.join("")).toMatch(/^Usage: vspi exec/u);
	});

	it("uses implicit stdin only when non-TTY", async () => {
		expect(parseExecArgs([], "/tmp", false)).toMatchObject({ stdin: true, prompt: "" });
		expect(() => parseExecArgs([], "/tmp", true)).toThrow(ExecUsageError);
		await expect(readExecPrompt(parseExecArgs([], "/tmp", false), io().value)).resolves.toMatchObject({ prompt: "stdin prompt" });
	});

	it("rejects empty and propagates the stdin limit", async () => {
		const empty = io({ readStdin: async () => "  " });
		await expect(readExecPrompt(parseExecArgs(["-"], "/tmp"), empty.value)).rejects.toThrow("Prompt is required");
		const oversized = io({ readStdin: vi.fn(async (limit) => { throw new ExecUsageError(`stdin exceeds ${String(limit)} bytes`); }) });
		await expect(readExecPrompt(parseExecArgs(["-"], "/tmp"), oversized.value)).rejects.toThrow("1048576");
		expect(oversized.value.readStdin).toHaveBeenCalledWith(1024 * 1024);
	});

	it("parses legacy resume selectors only for explicit ID formats", () => {
		const uuid = "123e4567-e89b-42d3-a456-426614174000";
		const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		expect(parseExecArgs(["resume", "latest", "do", "it"], "/tmp")).toMatchObject({ session: "latest", prompt: "do it" });
		expect(parseExecArgs(["resume", uuid, "do", "it"], "/tmp")).toMatchObject({ session: uuid, prompt: "do it" });
		expect(parseExecArgs(["resume", ulid, "do"], "/tmp")).toMatchObject({ session: ulid, prompt: "do" });
		expect(parseExecArgs(["resume", "fix", "the", "bug"], "/tmp")).toMatchObject({ session: "latest", prompt: "fix the bug" });
		expect(parseExecArgs(["--session", "abc", "prompt"], "/tmp")).toMatchObject({ session: "abc", prompt: "prompt" });
	});
});

describe("model, effort, profile, and cleanup", () => {
	it("resolves display names but sends the real catalog alias", async () => {
		const catalog = [model("provider", "wire-alias")];
		expect(resolveExecModel("wire-alias", catalog).model).toBe("wire-alias");
		expect(resolveExecModel("provider/wire-alias", catalog).model).toBe("wire-alias");
		const fake = fixture({ models: catalog });
		await runExec(fake.klient, options({ model: "provider/wire-alias" }), io().value);
		expect(fake.bindProfile).toHaveBeenCalledWith(expect.objectContaining({ model: "wire-alias" }));
		expect(fake.bindProfile).not.toHaveBeenCalledWith(expect.objectContaining({ model: "provider/wire-alias" }));
	});

	it("rejects provider/model mismatches", () => {
		const catalog = [model("a", "wire-alias")];
		expect(() => resolveExecModel("b/wire-alias", catalog)).toThrow("Model not found");
	});

	it("normalizes known efforts case-insensitively and preserves provider raw case", async () => {
		expect(normalizeCatalogEffort("高")).toBe("high");
		expect(normalizeCatalogEffort("HIGH")).toBe("high");
		expect(normalizeCatalogEffort("ProviderRaw")).toBe("ProviderRaw");
		const known = fixture();
		await runExec(known.klient, options({ effort: "HIGH" }), io().value);
		expect(known.bindProfile).toHaveBeenCalledWith(expect.objectContaining({ thinking: "high" }));
		const raw = fixture({ models: [model("kimi", "wire-k2", ["ProviderRaw"])] });
		expect((await runExec(raw.klient, options({ effort: "ProviderRaw" }), io().value)).status).toBe("success");
		expect((await runExec(fixture({ models: [model("kimi", "wire-k2", ["ProviderRaw"])] }).klient, options({ effort: "providerraw" }), io().value)).status).toBe("failed");
	});

	it("lets bindProfile authoritatively accept or reject resume profile", async () => {
		const summaries = [{ id: "session-1", workspaceId: "workspace-1" }];
		const same = fixture({ summaries });
		await runExec(same.klient, options({ session: "latest", profile: "agent" }), io().value);
		expect(same.bindProfile).toHaveBeenCalledWith({ profile: "agent", strictThinking: true });
		expect(same.calls.some((call) => call.startsWith("model:"))).toBe(false);
		const different = fixture({ summaries, bindError: new Error("engine profile mismatch") });
		const result = await runExec(different.klient, options({ session: "latest", profile: "reviewer" }), io().value);
		expect(result.error).toBe("engine profile mismatch");
	});

	it("deletes a new session before successful prompt submission without masking the original error", async () => {
		const setup = fixture({ bindError: new Error("setup failed"), deleteError: new Error("delete failed") });
		expect((await runExec(setup.klient, options(), io().value)).error).toBe("setup failed");
		expect(setup.deleteSession).toHaveBeenCalledOnce();
		const rejected = fixture({ promptError: new Error("prompt rejected") });
		expect((await runExec(rejected.klient, options(), io().value)).error).toBe("prompt rejected");
		expect(rejected.deleteSession).toHaveBeenCalledOnce();
	});

	it("keeps a new session after queued prompt submission", async () => {
		const queued = fixture({ onPrompt: async (events, _sessionEvents, input) => {
			emitLater(events, "prompt.aborted", { promptId: input.promptId });
			return undefined;
		} });
		expect((await runExec(queued.klient, options(), io().value)).status).toBe("failed");
		expect(queued.deleteSession).not.toHaveBeenCalled();
	});
});

describe("turn ownership, output events, and interactions", () => {
	it("filters unrelated turns and buffers target events before prompt resolves", async () => {
		const fake = fixture({ onPrompt: async (events, _sessionEvents, input) => {
			events.emit("turn.started", { turnId: 99, promptId: "other" });
			events.emit("assistant.delta", { turnId: 99, delta: "wrong" });
			events.emit("turn.ended", { turnId: 1, reason: "completed" });
			events.emit("assistant.delta", { turnId: 7, delta: "right" });
			events.emit("turn.ended", { turnId: 7, reason: "completed" });
			await Promise.resolve();
			events.emit("turn.started", { turnId: 7, promptId: input.promptId });
			return { turn_id: 7 };
		} });
		const result = await runExec(fake.klient, options(), io().value);
		expect(result).toMatchObject({ status: "success", turnId: 7, text: "right" });
	});

	it("settles from matching prompt completion when turn ended was missed", async () => {
		const fake = fixture({ onPrompt: async (events, _sessionEvents, input) => {
			events.emit("turn.started", { turnId: 8, promptId: input.promptId });
			events.emit("assistant.delta", { turnId: 8, delta: "done" });
			emitLater(events, "prompt.completed", { promptId: input.promptId, reason: "completed" });
			return { turn_id: 8 };
		} });
		expect(await runExec(fake.klient, options(), io().value)).toMatchObject({ status: "success", text: "done" });
	});

	it("waits for prompt resolve before applying an early completion", async () => {
		const fake = fixture({ onPrompt: async (events, _sessionEvents, input) => {
			events.emit("prompt.completed", { promptId: input.promptId, reason: "completed" });
			await Promise.resolve();
			return { turn_id: 11 };
		} });
		expect(await runExec(fake.klient, options(), io().value)).toMatchObject({
			status: "success",
			turnId: 11,
		});
	});

	it("ignores old prompt completion and fails matching blocked/aborted prompts", async () => {
		const blocked = fixture({ onPrompt: async (events, _sessionEvents, input) => {
			events.emit("prompt.completed", { promptId: "old", reason: "completed" });
			emitLater(events, "prompt.completed", { promptId: input.promptId, reason: "blocked" });
			return undefined;
		} });
		expect(await runExec(blocked.klient, options(), io().value)).toMatchObject({ status: "failed", error: "Prompt blocked" });
		const aborted = fixture({ onPrompt: async (events, _sessionEvents, input) => {
			emitLater(events, "prompt.aborted", { promptId: input.promptId });
			return undefined;
		} });
		expect(await runExec(aborted.klient, options(), io().value)).toMatchObject({ status: "failed", error: "Prompt aborted" });
	});

	it("emits exact discriminated JSONL keys and a final result", async () => {
		const fake = fixture({ onPrompt: async (events, _sessionEvents, input) => {
			events.emit("turn.started", { turnId: 7, promptId: input.promptId });
			events.emit("tool.call.started", { turnId: 7, toolCallId: "t", name: "Bash", args: { command: "x" } });
			events.emit("tool.result", { turnId: 7, toolCallId: "t", output: "x".repeat(3_000) });
			events.emit("assistant.delta", { turnId: 7, delta: "done" });
			events.emit("turn.ended", { turnId: 7, reason: "completed" });
			return { turn_id: 7 };
		} });
		const stream = io();
		await dispatchExecCommand(["exec", "--output", "jsonl", "hello"], {
			connect: async () => ({ klient: fake.klient, close: async () => undefined }),
			io: stream.value,
		});
		const rows = parsedLines(stream.stdout);
		expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(Object.keys(rows[0]).toSorted()).toEqual(["sequence", "turnId", "type", "version"]);
		expect(Object.keys(rows[1]).toSorted()).toEqual(["name", "sequence", "summary", "toolCallId", "turnId", "type", "version"]);
		expect(Object.keys(rows[2]).toSorted()).toEqual(["isError", "sequence", "summary", "toolCallId", "turnId", "type", "version"]);
		expect(Object.keys(rows[3]).toSorted()).toEqual(["delta", "sequence", "turnId", "type", "version"]);
		expect(Object.keys(rows[4]).toSorted()).toEqual(["reason", "sequence", "turnId", "type", "version"]);
		expect(Object.keys(rows[5]).toSorted()).toEqual([...RESULT_KEYS, "sequence"].toSorted());
		expect(rows[2].summary).toContain("[truncated]");
		expect(rows[5]).toMatchObject({ type: "result", status: "success", text: "done" });
		expect(stream.stderr).toEqual([]);
	});

	it("responds only to interactions owned by the target turn", async () => {
		const fake = fixture({ interactions: [
			{ id: "old", kind: "approval", payload: {}, origin: { agentId: "main", turnId: 1 }, createdAt: 1 },
			{ id: "child", kind: "question", payload: {}, origin: { agentId: "child", turnId: 7 }, createdAt: 2 },
			{ id: "a", kind: "approval", payload: {}, origin: { agentId: "main", turnId: 7 }, createdAt: 3 },
			{ id: "q", kind: "question", payload: {}, origin: { turnId: 7 }, createdAt: 4 },
		] });
		await runExec(fake.klient, options(), io().value);
		expect(fake.session.interactions.respond).toHaveBeenCalledWith("a", { decision: "rejected" });
		expect(fake.session.interactions.respond).toHaveBeenCalledWith("q", null);
		expect(fake.session.interactions.respond).not.toHaveBeenCalledWith("old", expect.anything());
		expect(fake.session.interactions.respond).not.toHaveBeenCalledWith("child", expect.anything());
	});

	it("fails and cancels a target user_tool interaction without racing turn end", async () => {
		const fake = fixture({ interactions: [
			{ id: "u", kind: "user_tool", payload: {}, origin: { agentId: "main", turnId: 7 }, createdAt: 1 },
		] });
		const result = await runExec(fake.klient, options(), io().value);
		expect(result).toMatchObject({
			status: "failed",
			error: "User tool interaction is unavailable in non-interactive exec mode",
		});
		expect(fake.session.interactions.respond).toHaveBeenCalledWith("u", expect.objectContaining({
			isError: true,
			stopTurn: true,
		}));
		expect(fake.cancel).toHaveBeenCalledWith({ turnId: 7 });
	});
});

describe("SIGINT lifecycle", () => {
	it("waits for the target turn after first SIGINT and clears timer/listener", async () => {
		vi.useFakeTimers();
		try {
			let input!: { promptId: string };
			const fake = fixture({ onPrompt: async (events, _sessionEvents, value) => {
				input = value;
				events.emit("turn.started", { turnId: 9, promptId: value.promptId });
				return { turn_id: 9 };
			} });
			const stream = io();
			const running = runExec(fake.klient, options(), stream.value);
			await vi.waitFor(() => {
				expect(fake.prompt).toHaveBeenCalled();
			});
			stream.signal();
			expect(fake.cancel).toHaveBeenCalledWith({ turnId: 9 });
			fake.events.emit("turn.ended", { turnId: 9, reason: "cancelled" });
			await expect(running).resolves.toMatchObject({ status: "cancelled", exitCode: 130 });
			expect(input.promptId).toBeTypeOf("string");
			expect(vi.getTimerCount()).toBe(0);
			expect(stream.listener()).toBeUndefined();
			expect(stream.adds()).toBe(1);
			expect(stream.removes()).toBe(1);
			expect(fake.events.listenerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not wait for an unresolved prompt after the second SIGINT", async () => {
		vi.useFakeTimers();
		try {
			const fake = fixture({ onPrompt: async () => new Promise<never>(() => {}) });
			const stream = io();
			const running = runExec(fake.klient, options(), stream.value);
			await vi.waitFor(() => {
				expect(fake.prompt).toHaveBeenCalled();
			});
			stream.signal();
			stream.signal();
			await expect(running).resolves.toMatchObject({ status: "cancelled", exitCode: 130 });
			expect(fake.deleteSession).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			expect(stream.listener()).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles immediately on second SIGINT and clears the timeout", async () => {
		vi.useFakeTimers();
		try {
			const fake = fixture({ onPrompt: async (events, _sessionEvents, input) => {
				events.emit("turn.started", { turnId: 10, promptId: input.promptId });
				return { turn_id: 10 };
			} });
			const stream = io();
			const running = runExec(fake.klient, options(), stream.value);
			await vi.waitFor(() => {
				expect(fake.prompt).toHaveBeenCalled();
			});
			stream.signal();
			stream.signal();
			await expect(running).resolves.toMatchObject({ status: "cancelled", exitCode: 130 });
			expect(vi.getTimerCount()).toBe(0);
			expect(stream.listener()).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
