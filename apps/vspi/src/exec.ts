import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
	AgentEventPayloads,
	AgentHandle,
	IDisposable,
	Interaction,
	Klient,
	ModelCatalogItem,
	ProviderCatalogItem,
	SessionHandle,
	SessionSummary,
} from "@moonshot-ai/klient";

import {
	catalogEffortCapability,
	normalizeCatalogEffort,
	resolveCatalogEffort,
} from "./v1/domain/effort.js";

const EXEC_VERSION = 1 as const;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TOOL_SUMMARY = 2_000;
const CANCEL_WAIT_MS = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const EXEC_USAGE = `Usage: vspi exec [options] [--] [prompt...]
       vspi exec [options] -
       vspi exec resume [latest|session-id] [prompt...]

Options:
  --model <provider/model|alias>
  --effort <level>
  --profile <profile>
  --cwd <directory>
  --output <text|json|jsonl>
  --session <new|latest|session-id>
  --continue
  -h, --help
`;

export type ExecOutput = "text" | "json" | "jsonl";
export type ExecStatus = "success" | "failed" | "cancelled";

export interface ExecOptions {
	readonly prompt: string;
	readonly stdin: boolean;
	readonly model?: string;
	readonly effort?: string;
	readonly profile?: string;
	readonly cwd: string;
	readonly output: ExecOutput;
	readonly session: string;
	readonly continueLatest: boolean;
	readonly help: boolean;
}

export interface ExecResult {
	readonly version: 1;
	readonly type: "result";
	readonly status: ExecStatus;
	readonly exitCode: 0 | 1 | 2 | 130;
	readonly sessionId: string | null;
	readonly turnId: number | null;
	readonly text: string;
	readonly error: string | null;
}

interface ExecJsonlBase {
	readonly version: 1;
	readonly sequence: number;
}

export type ExecJsonlEvent =
	| { readonly type: "turn_started"; readonly turnId: number }
	| { readonly type: "assistant_delta"; readonly turnId: number; readonly delta: string }
	| {
			readonly type: "tool_started";
			readonly turnId: number;
			readonly toolCallId: string;
			readonly name: string;
			readonly summary: string;
	  }
	| {
			readonly type: "tool_result";
			readonly turnId: number;
			readonly toolCallId: string;
			readonly isError: boolean;
			readonly summary: string;
	  }
	| {
			readonly type: "interaction";
			readonly interactionId: string;
			readonly kind: Interaction["kind"];
			readonly action: "rejected" | "dismissed" | "failed";
	  }
	| {
			readonly type: "turn_ended";
			readonly turnId: number;
			readonly reason: AgentEventPayloads["turn.ended"]["reason"];
	  };

export type ExecJsonlRecord = (ExecJsonlBase & ExecJsonlEvent) | (ExecJsonlBase & ExecResult);

export interface ExecIo {
	readonly stdinIsTTY: boolean;
	readonly readStdin: (limit: number) => Promise<string>;
	readonly stdout: (chunk: string) => void;
	readonly stderr: (chunk: string) => void;
	readonly onSignal: (listener: () => void) => void;
	readonly offSignal: (listener: () => void) => void;
}

export class ExecUsageError extends Error {}

export interface ExecCommandDependencies {
	readonly connect: () => Promise<{ readonly klient: Klient; close(): Promise<void> }>;
	readonly io?: ExecIo;
	readonly cwd?: string;
	readonly setExitCode?: (code: number) => void;
}

export async function dispatchExecCommand(
	args: readonly string[],
	dependencies: ExecCommandDependencies,
): Promise<boolean> {
	if (!isExecCommand(args)) return false;
	const io = dependencies.io ?? processExecIo();
	const setExitCode = dependencies.setExitCode ?? ((code: number) => {
		process.exitCode = code;
	});
	const output = detectExecOutput(args.slice(1));
	let options: ExecOptions;
	try {
		options = parseExecArgs(args.slice(1), dependencies.cwd, io.stdinIsTTY);
		if (options.help) {
			io.stdout(EXEC_USAGE);
			return true;
		}
		options = await readExecPrompt(options, io);
	} catch (error) {
		const result = failedResult(error, 2);
		if (output === "text" && error instanceof ExecUsageError) {
			io.stderr(`${error.message}\n${EXEC_USAGE}`);
		} else {
			writeExecResult(result, output, io, 0);
		}
		setExitCode(result.exitCode);
		return true;
	}

	let connection: Awaited<ReturnType<ExecCommandDependencies["connect"]>> | undefined;
	let result: ExecResult;
	let sequence = 0;
	const emit = (event: ExecJsonlEvent): void => {
		sequence += 1;
		const record: ExecJsonlRecord = { version: EXEC_VERSION, sequence, ...event };
		io.stdout(`${JSON.stringify(record)}\n`);
	};
	try {
		connection = await dependencies.connect();
		result = await runExec(
			connection.klient,
			options,
			io,
			options.output === "jsonl" ? emit : undefined,
		);
	} catch (error) {
		result = failedResult(error, 1);
	}
	if (connection !== undefined) {
		try {
			await connection.close();
		} catch (error) {
			if (result.status === "success") result = failedResult(error, 1, result);
		}
	}
	writeExecResult(result, options.output, io, sequence);
	setExitCode(result.exitCode);
	return true;
}

export function isExecCommand(args: readonly string[]): boolean {
	return args[0] === "exec" || args[0] === "run";
}

export function detectExecOutput(args: readonly string[]): ExecOutput {
	let output: ExecOutput = "text";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args.at(index);
		if (arg === "--") break;
		const value = arg === "--output" ? args.at(index + 1) : arg?.startsWith("--output=") ? arg.slice(9) : undefined;
		if (value === "text" || value === "json" || value === "jsonl") output = value;
		if (arg === "--output") index += 1;
	}
	return output;
}

export function parseExecArgs(
	args: readonly string[],
	defaultCwd = process.cwd(),
	stdinIsTTY = true,
): ExecOptions {
	let model: string | undefined;
	let effort: string | undefined;
	let profile: string | undefined;
	let cwd = defaultCwd;
	let output: ExecOutput = "text";
	let session = "new";
	let continueLatest = false;
	let help = false;
	let positionalOnly = false;
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args.at(index);
		if (arg === undefined) break;
		if (positionalOnly) {
			positional.push(arg);
			continue;
		}
		if (arg === "--") {
			positionalOnly = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (arg === "--continue") {
			continueLatest = true;
			continue;
		}
		const option = optionName(arg);
		if (option !== undefined) {
			const inline = arg.startsWith(`${option}=`) ? arg.slice(option.length + 1) : undefined;
			const value = inline ?? args.at(++index);
			if (value === undefined || value.length === 0 || (inline === undefined && value.startsWith("-"))) {
				throw new ExecUsageError(`Missing value for ${option}`);
			}
			switch (option) {
				case "--model":
					model = value;
					break;
				case "--effort":
					effort = value;
					break;
				case "--profile":
					profile = value;
					break;
				case "--cwd":
					cwd = value;
					break;
				case "--output":
					if (value !== "text" && value !== "json" && value !== "jsonl") {
						throw new ExecUsageError(`Invalid --output: ${value}`);
					}
					output = value;
					break;
				case "--session":
					session = value;
					break;
			}
			continue;
		}
		if (arg !== "-" && arg.startsWith("-")) throw new ExecUsageError(`Unknown option: ${arg}`);
		positional.push(arg);
	}

	if (help) {
		return { prompt: "", stdin: false, model, effort, profile, cwd, output, session, continueLatest, help };
	}
	if (continueLatest && session !== "new") {
		throw new ExecUsageError("--continue cannot be combined with --session");
	}
	if (positional[0] === "resume") {
		if (continueLatest || session !== "new") {
			throw new ExecUsageError("exec resume cannot be combined with --continue or --session");
		}
		const tail = positional.slice(1);
		if (tail[0] !== undefined && legacyResumeSelector(tail[0])) session = tail.shift()!;
		else session = "latest";
		positional.length = 0;
		positional.push(...tail);
	}
	const implicitStdin = positional.length === 0 && !stdinIsTTY;
	const stdin = implicitStdin || (positional.length === 1 && positional[0] === "-");
	if (positional.includes("-") && !(positional.length === 1 && positional[0] === "-")) {
		throw new ExecUsageError("stdin marker '-' must be the only prompt argument");
	}
	const prompt = stdin ? "" : positional.join(" ").trim();
	if (!stdin && prompt.length === 0) throw new ExecUsageError("Prompt is required");
	return { prompt, stdin, model, effort, profile, cwd, output, session, continueLatest, help };
}

export async function runExec(
	klient: Klient,
	options: ExecOptions,
	io: ExecIo = processExecIo(),
	emitJsonl?: (event: ExecJsonlEvent) => void,
): Promise<ExecResult> {
	let sessionId: string | null = null;
	let session: SessionHandle | undefined;
	let created = false;
	let submitted = false;
	try {
		const cwd = await normalizeCwd(options.cwd);
		const workspace = await klient.global.workspaces.createOrTouch({ root: cwd });
		const [models, providers, defaultModel, configuredThinking] = await Promise.all([
			klient.global.kosong.listModels(),
			klient.global.kosong.listProviders(),
			klient.global.config.get<string | undefined>("defaultModel"),
			klient.global.config.get<{ effort?: string } | undefined>("thinking"),
		]);
		const selection = await resolveExecSession(klient, workspace.id, cwd, options);
		sessionId = selection.id;
		created = selection.created;
		session = klient.session(sessionId);
		if (!created) {
			const restored = await session.restore();
			if (!restored) throw new Error(`Session not found: ${sessionId}`);
			const meta = await session.get();
			const sessionCwd = meta.cwd === undefined ? undefined : await canonicalExistingPath(meta.cwd);
			if (sessionCwd !== cwd) {
				throw new Error(`Session ${sessionId} belongs to a different workspace: ${meta.cwd ?? "unknown"}`);
			}
		}
		const agent = session.agent("main");
		if (created) {
			const selectedModel = resolveExecModel(options.model ?? defaultModel, models);
			const thinking = resolveExecEffort(selectedModel, providers, options.effort, configuredThinking?.effort);
			await agent.bindProfile({
				profile: options.profile ?? "agent",
				model: selectedModel.model,
				thinking,
				strictThinking: true,
			});
		} else {
			if (options.profile !== undefined) {
				await agent.bindProfile({ profile: options.profile, strictThinking: true });
			}
			let selectedModel: ModelCatalogItem | undefined;
			if (options.model !== undefined) {
				selectedModel = resolveExecModel(options.model, models);
				await agent.setModel(selectedModel.model);
			}
			if (options.effort !== undefined) {
				selectedModel ??= resolveExecModel(await agent.getModel(), models);
				await agent.setThinking(resolveExecEffort(selectedModel, providers, options.effort));
			}
		}
		await agent.setPermission("manual");
		const outcome = await driveTurn(session, agent, options.prompt, io, emitJsonl, () => {
			submitted = true;
		});
		if (created && !submitted) await session.delete().catch(() => {});
		return makeResult(outcome.status, outcome.status === "success" ? 0 : outcome.status === "cancelled" ? 130 : 1, {
			sessionId,
			turnId: outcome.turnId,
			text: outcome.text,
			error: outcome.error,
		});
	} catch (error) {
		if (created && !submitted && session !== undefined) await session.delete().catch(() => {});
		return failedResult(error, 1, { sessionId });
	}
}

export async function readExecPrompt(options: ExecOptions, io: ExecIo): Promise<ExecOptions> {
	if (!options.stdin || options.help) return options;
	const prompt = (await io.readStdin(MAX_STDIN_BYTES)).trim();
	if (prompt.length === 0) throw new ExecUsageError("Prompt is required");
	return { ...options, prompt };
}

export function processExecIo(): ExecIo {
	return {
		stdinIsTTY: process.stdin.isTTY ?? false,
		readStdin: async (limit) => {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of process.stdin) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += buffer.length;
				if (size > limit) throw new ExecUsageError(`stdin exceeds ${String(limit)} bytes`);
				chunks.push(buffer);
			}
			return Buffer.concat(chunks).toString("utf8");
		},
		stdout: (chunk) => process.stdout.write(chunk),
		stderr: (chunk) => process.stderr.write(chunk),
		onSignal: (listener) => process.on("SIGINT", listener),
		offSignal: (listener) => process.off("SIGINT", listener),
	};
}

export function resolveExecModel(
	requested: string | undefined,
	models: readonly ModelCatalogItem[],
): ModelCatalogItem {
	if (requested === undefined || requested.trim().length === 0) {
		throw new Error("No model configured; use --model");
	}
	const value = requested.trim();
	const exactAlias = models.filter((model) => model.model === value);
	const aliasMatch = exactAlias.at(0);
	if (exactAlias.length === 1 && aliasMatch !== undefined) return aliasMatch;
	if (exactAlias.length > 1) throw new Error(`Ambiguous model "${value}": ${modelNames(exactAlias)}`);
	const qualified = models.filter((model) => displayModelAlias(model) === value);
	const qualifiedMatch = qualified.at(0);
	if (qualified.length === 1 && qualifiedMatch !== undefined) return qualifiedMatch;
	if (qualified.length > 1) throw new Error(`Ambiguous model "${value}": ${modelNames(qualified)}`);
	const short = models.filter((model) => displayModelId(model) === value);
	const shortMatch = short.at(0);
	if (short.length === 1 && shortMatch !== undefined) return shortMatch;
	if (short.length > 1) throw new Error(`Ambiguous model "${value}": ${modelNames(short)}`);
	throw new Error(`Model not found: ${value}`);
}

async function normalizeCwd(cwd: string): Promise<string> {
	const normalized = resolve(cwd);
	let info;
	try {
		info = await stat(normalized);
	} catch {
		throw new Error(`Working directory does not exist: ${normalized}`);
	}
	if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${normalized}`);
	return realpath(normalized);
}

async function canonicalExistingPath(path: string): Promise<string | undefined> {
	try {
		return await realpath(resolve(path));
	} catch {
		return undefined;
	}
}

async function resolveExecSession(
	klient: Klient,
	workspaceId: string,
	cwd: string,
	options: Pick<ExecOptions, "session" | "continueLatest">,
): Promise<{ id: string; created: boolean }> {
	if (options.session === "new" && !options.continueLatest) {
		const meta = await klient.global.sessions.create({ workDir: cwd });
		return { id: meta.id, created: true };
	}
	const firstPage = await klient.global.sessions.list({ workspaceIds: [workspaceId], limit: 100 });
	if (options.continueLatest && firstPage.items.length === 0) {
		const meta = await klient.global.sessions.create({ workDir: cwd });
		return { id: meta.id, created: true };
	}
	const selector = options.continueLatest ? "latest" : options.session;
	if (selector === "latest") {
		const latest = firstPage.items[0];
		if (latest === undefined) throw new Error("No session found for this workspace");
		return { id: latest.id, created: false };
	}
	const exact = await klient.global.sessions.get(selector);
	if (exact !== undefined) {
		if (exact.workspaceId !== workspaceId) throw new Error(`Session ${selector} belongs to a different workspace`);
		return { id: exact.id, created: false };
	}
	const summaries = await collectWorkspaceSessions(klient, workspaceId, firstPage);
	const matches = summaries.filter((item) => item.id.startsWith(selector));
	const prefixMatch = matches.at(0);
	if (matches.length === 1 && prefixMatch !== undefined) {
		return { id: prefixMatch.id, created: false };
	}
	if (matches.length > 1) throw new Error(`Ambiguous session prefix "${selector}": ${matches.map((item) => item.id).join(", ")}`);
	throw new Error(`Session not found: ${selector}`);
}

async function collectWorkspaceSessions(
	klient: Klient,
	workspaceId: string,
	firstPage: { readonly items: readonly SessionSummary[]; readonly nextCursor?: string },
): Promise<readonly SessionSummary[]> {
	const summaries = [...firstPage.items];
	let before = firstPage.nextCursor;
	while (before !== undefined) {
		const page = await klient.global.sessions.list({ workspaceIds: [workspaceId], limit: 100, before });
		summaries.push(...page.items);
		before = page.nextCursor;
	}
	return summaries;
}

type BufferedTurnEvent =
	| { readonly kind: "assistant"; readonly event: AgentEventPayloads["assistant.delta"] }
	| { readonly kind: "tool_started"; readonly event: AgentEventPayloads["tool.call.started"] }
	| { readonly kind: "tool_result"; readonly event: AgentEventPayloads["tool.result"] }
	| { readonly kind: "ended"; readonly event: AgentEventPayloads["turn.ended"] };

async function driveTurn(
	session: SessionHandle,
	agent: AgentHandle,
	prompt: string,
	io: ExecIo,
	emit: ((event: ExecJsonlEvent) => void) | undefined,
	onSubmitted: () => void,
): Promise<{ status: ExecStatus; turnId: number | null; text: string; error: string | null }> {
	const promptId = randomUUID();
	let targetTurn: number | undefined;
	let text = "";
	let interrupts = 0;
	let interactionFailure: string | undefined;
	let submitted = false;
	let settled = false;
	let settlementRequested = false;
	let launchResolved = false;
	let pendingPromptSettlement: { readonly status: ExecStatus; readonly error: string | null } | undefined;
	let cancelTimer: NodeJS.Timeout | undefined;
	let resolveSettled!: (value: { status: ExecStatus; turnId: number | null; text: string; error: string | null }) => void;
	const settledPromise = new Promise<{
		status: ExecStatus;
		turnId: number | null;
		text: string;
		error: string | null;
	}>((resolvePromise) => {
		resolveSettled = resolvePromise;
	});
	const subscriptions: IDisposable[] = [];
	const buffered = new Map<number, BufferedTurnEvent[]>();
	const handledInteractions = new Set<string>();
	let interactionChain = Promise.resolve();

	const markSubmitted = (): void => {
		if (submitted) return;
		submitted = true;
		onSubmitted();
	};
	const clearCancelTimer = (): void => {
		if (cancelTimer === undefined) return;
		clearTimeout(cancelTimer);
		cancelTimer = undefined;
	};
	const finish = (status: ExecStatus, error: string | null = null): void => {
		if (settlementRequested) return;
		settlementRequested = true;
		clearCancelTimer();
		void interactionChain.finally(() => {
			if (settled) return;
			settled = true;
			resolveSettled({
				status: interactionFailure === undefined ? status : "failed",
				turnId: targetTurn ?? null,
				text,
				error: interactionFailure ?? error,
			});
		});
	};
	const settlePrompt = (status: ExecStatus, error: string | null = null): void => {
		if (!launchResolved) {
			pendingPromptSettlement = { status, error };
			return;
		}
		finish(status, error);
	};
	const respondToInteractions = async (interactions: readonly Interaction[]): Promise<void> => {
		for (const interaction of interactions) {
			if (settled || handledInteractions.has(interaction.id)) continue;
			if (interaction.origin.agentId !== undefined && interaction.origin.agentId !== "main") continue;
			if (targetTurn === undefined || interaction.origin.turnId !== targetTurn) continue;
			handledInteractions.add(interaction.id);
			if (interaction.kind === "approval") {
				emit?.({ type: "interaction", interactionId: interaction.id, kind: interaction.kind, action: "rejected" });
				await session.interactions.respond(interaction.id, { decision: "rejected" });
			} else if (interaction.kind === "question") {
				emit?.({ type: "interaction", interactionId: interaction.id, kind: interaction.kind, action: "dismissed" });
				await session.interactions.respond(interaction.id, null);
			} else {
				emit?.({ type: "interaction", interactionId: interaction.id, kind: interaction.kind, action: "failed" });
				await session.interactions.respond(interaction.id, {
					output: "User tools are unavailable in non-interactive exec mode.",
					isError: true,
					stopTurn: true,
				});
				await agent.cancel({ turnId: targetTurn });
				throw new Error("User tool interaction is unavailable in non-interactive exec mode");
			}
		}
	};
	const failInteraction = (error: unknown): void => {
		interactionFailure = errorMessage(error);
		finish("failed", interactionFailure);
	};
	const enqueueInteractions = (interactions: readonly Interaction[]): void => {
		if (settlementRequested) return;
		interactionChain = interactionChain
			.then(() => respondToInteractions(interactions))
			.catch(failInteraction);
	};
	const refreshInteractions = (): void => {
		interactionChain = interactionChain
			.then(async () => respondToInteractions(await session.interactions.list()))
			.catch(failInteraction);
	};
	const consume = (bufferedEvent: BufferedTurnEvent): void => {
		if (settlementRequested) return;
		const event = bufferedEvent.event;
		if (targetTurn === undefined || event.turnId !== targetTurn) return;
		switch (bufferedEvent.kind) {
			case "assistant":
				text += bufferedEvent.event.delta;
				emit?.({ type: "assistant_delta", turnId: targetTurn, delta: bufferedEvent.event.delta });
				break;
			case "tool_started":
				emit?.({
					type: "tool_started",
					turnId: targetTurn,
					toolCallId: bufferedEvent.event.toolCallId,
					name: bufferedEvent.event.name,
					summary: safeSummary(bufferedEvent.event.description ?? bufferedEvent.event.args),
				});
				break;
			case "tool_result":
				emit?.({
					type: "tool_result",
					turnId: targetTurn,
					toolCallId: bufferedEvent.event.toolCallId,
					isError: bufferedEvent.event.isError ?? false,
					summary: safeSummary(bufferedEvent.event.output),
				});
				break;
			case "ended":
				emit?.({ type: "turn_ended", turnId: targetTurn, reason: bufferedEvent.event.reason });
				if (interrupts > 0 || bufferedEvent.event.reason === "cancelled") finish("cancelled");
				else if (bufferedEvent.event.reason === "completed") finish("success");
				else finish("failed", turnError(bufferedEvent.event));
		}
	};
	const acceptTurn = (turnId: number): void => {
		if (targetTurn !== undefined || settlementRequested) return;
		markSubmitted();
		targetTurn = turnId;
		emit?.({ type: "turn_started", turnId });
		for (const event of buffered.get(turnId) ?? []) consume(event);
		buffered.clear();
		refreshInteractions();
	};
	const bufferOrConsume = (event: BufferedTurnEvent): void => {
		if (settlementRequested) return;
		if (targetTurn === undefined) {
			const events = buffered.get(event.event.turnId) ?? [];
			events.push(event);
			buffered.set(event.event.turnId, events);
			return;
		}
		consume(event);
	};

	subscriptions.push(
		agent.events.on("turn.started", (event) => {
			if (event.promptId === promptId) acceptTurn(event.turnId);
		}),
		agent.events.on("assistant.delta", (event) => {
			bufferOrConsume({ kind: "assistant", event });
		}),
		agent.events.on("tool.call.started", (event) => {
			bufferOrConsume({ kind: "tool_started", event });
		}),
		agent.events.on("tool.result", (event) => {
			bufferOrConsume({ kind: "tool_result", event });
		}),
		agent.events.on("turn.ended", (event) => {
			bufferOrConsume({ kind: "ended", event });
		}),
		agent.events.on("prompt.completed", (event) => {
			if (event.promptId !== promptId || settlementRequested) return;
			markSubmitted();
			if (interrupts > 0) settlePrompt("cancelled");
			else if (event.reason === undefined || event.reason === "completed") settlePrompt("success");
			else settlePrompt("failed", `Prompt ${event.reason}`);
		}),
		agent.events.on("prompt.aborted", (event) => {
			if (event.promptId !== promptId || settlementRequested) return;
			markSubmitted();
			settlePrompt(interrupts > 0 ? "cancelled" : "failed", interrupts > 0 ? null : "Prompt aborted");
		}),
		session.events.on("interactions.changed", enqueueInteractions),
		agent.events.onError((error) => {
			finish("failed", error.message);
		}),
		session.events.onError((error) => {
			finish("failed", error.message);
		}),
	);

	const onSignal = (): void => {
		interrupts += 1;
		if (interrupts >= 2) {
			finish("cancelled");
			return;
		}
		void agent.cancel({ turnId: targetTurn }).catch(() => {});
		clearCancelTimer();
		cancelTimer = setTimeout(() => {
			finish("cancelled");
		}, CANCEL_WAIT_MS);
		cancelTimer.unref();
	};
	io.onSignal(onSignal);
	try {
		const launchPromise = agent.prompt({
			input: [{ type: "text", text: prompt }],
			promptId,
		}).then(
			(launch) => ({ kind: "launch" as const, launch }),
			(error: unknown) => ({ kind: "error" as const, error }),
		);
		const first = await Promise.race([
			launchPromise,
			settledPromise.then((result) => ({ kind: "settled" as const, result })),
		]);
		if (first.kind === "settled") return first.result;
		if (first.kind === "error") throw first.error;
		markSubmitted();
		if (first.launch !== undefined) acceptTurn(first.launch.turn_id);
		launchResolved = true;
		if (pendingPromptSettlement !== undefined) {
			finish(pendingPromptSettlement.status, pendingPromptSettlement.error);
		}
		return await settledPromise;
	} finally {
		clearCancelTimer();
		io.offSignal(onSignal);
		for (const subscription of subscriptions) subscription.dispose();
	}
}

function writeExecResult(result: ExecResult, output: ExecOutput, io: ExecIo, sequence: number): void {
	if (output === "text") {
		if (result.status === "success" && result.text.length > 0) {
			io.stdout(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
		} else if (result.error !== null) {
			io.stderr(`${result.error}\n`);
		}
		return;
	}
	if (output === "json") {
		io.stdout(`${JSON.stringify(result)}\n`);
		return;
	}
	const record: ExecJsonlRecord = { ...result, sequence: sequence + 1 };
	io.stdout(`${JSON.stringify(record)}\n`);
}

function makeResult(
	status: ExecStatus,
	exitCode: ExecResult["exitCode"],
	values: Partial<Pick<ExecResult, "sessionId" | "turnId" | "text" | "error">> = {},
): ExecResult {
	return {
		version: EXEC_VERSION,
		type: "result",
		status,
		exitCode,
		sessionId: values.sessionId ?? null,
		turnId: values.turnId ?? null,
		text: values.text ?? "",
		error: values.error ?? null,
	};
}

function failedResult(
	error: unknown,
	exitCode: 1 | 2,
	values: Partial<Pick<ExecResult, "sessionId" | "turnId" | "text">> | ExecResult = {},
): ExecResult {
	return makeResult("failed", exitCode, {
		sessionId: values.sessionId,
		turnId: values.turnId,
		text: values.text,
		error: errorMessage(error),
	});
}

function legacyResumeSelector(value: string): boolean {
	return value === "latest" || UUID_PATTERN.test(value) || ULID_PATTERN.test(value) || (value.startsWith("session_") && UUID_PATTERN.test(value.slice(8)));
}

function optionName(arg: string): "--model" | "--effort" | "--profile" | "--cwd" | "--output" | "--session" | undefined {
	for (const option of ["--model", "--effort", "--profile", "--cwd", "--output", "--session"] as const) {
		if (arg === option || arg.startsWith(`${option}=`)) return option;
	}
	return undefined;
}

function displayModelId(model: ModelCatalogItem): string {
	const prefix = `${model.provider}/`;
	return model.model.startsWith(prefix) ? model.model.slice(prefix.length) : model.model;
}

function displayModelAlias(model: ModelCatalogItem): string {
	return `${model.provider}/${displayModelId(model)}`;
}

function modelNames(models: readonly ModelCatalogItem[]): string {
	return models.map(displayModelAlias).join(", ");
}

function resolveExecEffort(
	model: ModelCatalogItem,
	providers: readonly ProviderCatalogItem[],
	requested: string | undefined,
	fallback?: string,
): string {
	const provider = providers.find((candidate) => candidate.id === model.provider);
	const capability = catalogEffortCapability(model.thinking, {
		identity: model.provider,
		type: provider?.type,
	});
	const normalized = normalizeCatalogEffort(requested);
	if (requested !== undefined && (normalized === undefined || !capability.options.includes(normalized))) {
		throw new Error(
			`Effort "${requested}" is not supported by ${displayModelAlias(model)}; supported: ${capability.options.join(", ")}`,
		);
	}
	return resolveCatalogEffort(normalized ?? fallback, capability);
}

function safeSummary(value: unknown): string {
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	text = text.replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "");
	return text.length <= MAX_TOOL_SUMMARY ? text : `${text.slice(0, MAX_TOOL_SUMMARY)}…[truncated]`;
}

function turnError(event: { reason: string; error?: unknown }): string {
	if (event.error !== undefined) return `${event.reason}: ${safeSummary(event.error)}`;
	return `Turn ${event.reason}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
