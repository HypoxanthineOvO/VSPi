import { effortLabel } from "../domain/effort.js";
import { formatLocalTime } from "../domain/local-time.js";
import type { TranscriptMessage } from "../domain/types.js";
import {
	frame,
	padLine,
	stripAnsi,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./ansi.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { LiveTool, type ToolOutputPosition } from "./live-tool.js";
import { type DiffLine, renderDiff } from "./diff.js";
import {
	createVspiMarkdownTransformer,
	postprocessMarkdownLines,
	renderMarkdown,
} from "./markdown.js";
import {
	formatSubagentModel,
	formatSubagentProfile,
} from "./subagent-display.js";
import type { VspiTheme } from "./theme.js";

/** Render cap for a single thinking block. Full text stays in the message for
 *  persistence/export; only the tail is sent through Markdown/layout so a giant
 *  streaming block cannot wedge the TUI renderer or grow the write without bound. */
const MAX_THINKING_RENDER_CHARS = 200_000;
const AGENT_TIMEZONE = "Asia/Shanghai";
const TRANSCRIPT_RETENTION_LIMITS = { messages: 1000, characters: 4 * 1024 * 1024 };

export function retainTranscript(
	messages: TranscriptMessage[], committedCount: number,
	limits = TRANSCRIPT_RETENTION_LIMITS,
	canRemove?: (message: TranscriptMessage, index: number) => boolean,
): { messages: TranscriptMessage[]; committedCount: number } {
	const size = (message: TranscriptMessage) => Object.values(message).reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);
	let characters = messages.reduce((sum, message) => sum + size(message), 0);
	let count = messages.length;
	let committed = committedCount;
	const removed = new Set<number>();
	for (const [index, message] of messages.entries()) {
		if (count <= limits.messages && characters <= limits.characters) break;
		if (canRemove && !canRemove(message, index)) continue;
		if (('streaming' in message && message.streaming) || isQueuedTranscriptMessage(message) || ('status' in message && ['running', 'queued'].includes(message.status))) continue;
		removed.add(index);
		characters -= size(message);
		count--;
		if (index < committedCount) committed--;
	}
	return { messages: removed.size === 0 ? messages : messages.filter((_message, index) => !removed.has(index)), committedCount: committed };
}

export interface TranscriptRenderOptions {
	live?: {
		maxRows: number;
		deadline: number;
		emit: (section: TranscriptSection, maxRows: number) => { lines: string[]; start: number; auxiliary?: boolean; origins?: { row: number; column: number }[] };
		width: (id: string) => number | undefined;
		committed: ReadonlySet<string>;
		renderText: (message: Extract<TranscriptMessage, { kind: "text" | "thinking" }>, maxRows: number) => string[];
		renderTools: (id: string, messages: Extract<TranscriptMessage, { kind: "tool" }>[], maxRows: number) => string[];
		pending: (id: string) => boolean;
		beginText: (id: string, gap: boolean) => boolean;
		defer: () => void;
	};
	inspectedId?: string;
	selectedNodeId?: string;
	selectedToolId?: string;
	thinkingDisplay?: "hidden" | "collapsed" | "expanded";
	wrapCode?: boolean;
	collapseCompletedTools?: boolean;
	mermaidRendering?: "off" | "final" | "streaming";
	cache?: TranscriptRenderCache;
}

export interface TranscriptNode {
	id: string;
	kind: "message" | "toolGroup";
	messageIndexes: number[];
}

export interface TranscriptWindowOptions {
	width: number;
	maxRows: number;
	maxBlocks?: number;
	maxCharacters?: number;
	thinkingDisplay?: TranscriptRenderOptions["thinkingDisplay"];
	collapseCompletedTools?: boolean;
	pinnedNodeId?: string;
	/** Anchor mode: start the window at this node and fill forward instead of trailing the tail. */
	startNodeId?: string;
	/** Skip the exact hidden-block count so tail-follow redraws only inspect the bounded visible tail. */
	exactHiddenBlocks?: boolean;
	/** Row-estimate cache shared with rendering; avoids per-frame visibleWidth walks. */
	cache?: TranscriptRenderCache;
}

export interface TranscriptWindow {
	messages: TranscriptMessage[];
	nodes: TranscriptNode[];
	hiddenBlocks: number;
	/** Nodes after the window that are not shown (anchor mode browsing mid-history). */
	truncatedTailBlocks: number;
}

interface TranscriptCacheEntry {
	references: TranscriptMessage[];
	state: string;
	lines: string[];
}

interface TranscriptRowEstimateEntry {
	references: TranscriptMessage[];
	rows: number;
}

interface OfficialAssistantCacheEntry {
	component: AssistantMessageComponent;
	initialized: boolean;
	reference: Extract<TranscriptMessage, { kind: "text" }>;
	state: string;
	theme: VspiTheme;
}

export class TranscriptRenderCache {
	private entries = new Map<string, Map<string, TranscriptCacheEntry>>();
	private hits = 0;
	private misses = 0;
	private rowEstimates = new Map<string, TranscriptRowEstimateEntry>();
	private officialAssistants = new Map<string, OfficialAssistantCacheEntry>();

	render(
		key: string,
		references: TranscriptMessage[],
		state: string,
		factory: () => string[],
	): string[] {
		const variants = this.entries.get(key);
		const cached = variants?.get(state);
		if (
			cached &&
			cached.state === state &&
			cached.references.length === references.length &&
			cached.references.every(
				(reference, index) => reference === references[index],
			)
		) {
			this.hits += 1;
			return cached.lines;
		}
		this.misses += 1;
		const lines = factory();
		const nextVariants = variants ?? new Map<string, TranscriptCacheEntry>();
		if (nextVariants.size >= 4 && !nextVariants.has(state)) {
			const oldest = nextVariants.keys().next().value;
			if (oldest !== undefined) nextVariants.delete(oldest);
		}
		nextVariants.set(state, { references: [...references], state, lines });
		this.entries.set(key, nextVariants);
		return lines;
	}

	/**
	 * Cache window-selection row estimates per message identity + width. The
	 * estimator walks every line with visibleWidth (Intl.Segmenter slow path for
	 * CJK), and selectTranscriptWindow runs it on every frame otherwise. Bounded
	 * FIFO: entries also retain message references so immutable streaming
	 * patches invalidate estimates even when ids and streaming state are stable.
	 */
	estimateRows(
		key: string,
		width: number,
		references: TranscriptMessage[],
		factory: () => number,
	): number {
		const cacheKey = `${key}@${width}`;
		const cached = this.rowEstimates.get(cacheKey);
		if (
			cached &&
			cached.references.length === references.length &&
			cached.references.every(
				(reference, index) => reference === references[index],
			)
		) {
			return cached.rows;
		}
		if (this.rowEstimates.size >= 512) {
			const oldest = this.rowEstimates.keys().next().value;
			if (oldest !== undefined) this.rowEstimates.delete(oldest);
		}
		const rows = factory();
		this.rowEstimates.set(cacheKey, { references: [...references], rows });
		return rows;
	}

	renderOfficialAssistant(
		key: string,
		message: Extract<TranscriptMessage, { kind: "text" }>,
		width: number,
		theme: VspiTheme,
		options: Pick<TranscriptRenderOptions, "wrapCode" | "mermaidRendering">,
	): string[] {
		const state = `${options.wrapCode === false ? "nowrap" : "wrap"}:${options.mermaidRendering ?? "final"}`;
		let cached = this.officialAssistants.get(key);
		if (!cached || cached.state !== state || cached.theme !== theme) {
			cached = {
				component: new AssistantMessageComponent(
					undefined,
					false,
					theme.markdown,
					"Thinking...",
					0,
					[
						createVspiMarkdownTransformer({
							...options,
							unicode: theme.capabilities.unicode,
						}),
					],
				),
				initialized: false,
				reference: message,
				state,
				theme,
			};
			this.officialAssistants.set(key, cached);
		}
		if (!cached.initialized || cached.reference !== message) {
			cached.initialized = true;
			cached.reference = message;
			cached.component.updateContent(
				toOfficialAssistantMessage(message.text),
				message.streaming ?? false,
			);
		}
		return postprocessMarkdownLines(
			normalizeOfficialAssistantLines(cached.component.render(width)),
			width,
			theme,
		);
	}

	retain(keys: Set<string>, references: TranscriptMessage[]): void {
		for (const key of this.entries.keys()) {
			if (!keys.has(key)) this.entries.delete(key);
		}
		for (const key of this.officialAssistants.keys()) {
			if (!keys.has(key)) this.officialAssistants.delete(key);
		}
		const retainedReferences = new Set(references);
		for (const [key, entry] of this.rowEstimates) {
			if (
				!entry.references.some((reference) => retainedReferences.has(reference))
			)
				this.rowEstimates.delete(key);
		}
	}

	clear(): void {
		this.entries.clear();
		this.rowEstimates.clear();
		this.officialAssistants.clear();
		this.hits = 0;
		this.misses = 0;
	}

	stats(): { entries: number; hits: number; misses: number } {
		return { entries: this.entries.size, hits: this.hits, misses: this.misses };
	}
}

export function isQueuedTranscriptMessage(
	message: TranscriptMessage,
): message is Extract<TranscriptMessage, { kind: "text" }> & {
	delivery: "steer" | "followUp";
	deliveryState?: "queued";
} {
	return (
		message.kind === "text" &&
		message.role === "user" &&
		(message.delivery === "steer" || message.delivery === "followUp") &&
		(message.deliveryState === undefined || message.deliveryState === "queued")
	);
}

export function buildTranscriptNodes(
	messages: TranscriptMessage[],
): TranscriptNode[] {
	const nodes: TranscriptNode[] = [];
	for (let index = 0; index < messages.length; ) {
		const message = messages[index];
		if (!message) break;
		if (isQueuedTranscriptMessage(message)) {
			index += 1;
			continue;
		}
		if (message.kind !== "tool") {
			nodes.push({ id: message.id, kind: "message", messageIndexes: [index] });
			index += 1;
			continue;
		}
		const indexes = [index];
		let cursor = index + 1;
		while (cursor < messages.length) {
			const candidate = messages[cursor];
			if (candidate?.kind !== "tool" || !sameToolGroup(message, candidate))
				break;
			indexes.push(cursor);
			cursor += 1;
		}
		nodes.push({
			id: toolGroupNodeId(message),
			kind: "toolGroup",
			messageIndexes: indexes,
		});
		index = cursor;
	}
	return nodes;
}

export function selectTranscriptWindow(
	messages: TranscriptMessage[],
	options: TranscriptWindowOptions,
): TranscriptWindow {
	if (
		options.exactHiddenBlocks === false &&
		!options.startNodeId &&
		!options.pinnedNodeId
	) {
		return selectTranscriptTail(messages, options);
	}
	const nodes = buildTranscriptNodes(messages);
	if (nodes.length === 0)
		return { messages: [], nodes: [], hiddenBlocks: 0, truncatedTailBlocks: 0 };

	const maxBlocks = Math.max(1, options.maxBlocks ?? 80);
	const maxCharacters = Math.max(1, options.maxCharacters ?? 60_000);
	const maxRows = Math.max(1, options.maxRows);

	if (options.startNodeId) {
		const startIndex = nodes.findIndex(
			(node) => node.id === options.startNodeId,
		);
		if (startIndex >= 0) {
			let anchorCharacters = 0;
			let anchorRows = 0;
			let end = startIndex;
			for (
				let nodeIndex = startIndex;
				nodeIndex < nodes.length;
				nodeIndex += 1
			) {
				const node = nodes[nodeIndex];
				if (!node) break;
				const block = node.messageIndexes
					.map((messageIndex) => messages[messageIndex])
					.filter(
						(message): message is TranscriptMessage => message !== undefined,
					);
				const nextCharacters = block.reduce(
					(total, message) => total + transcriptMessageCharacters(message),
					0,
				);
				const nextRows = estimateTranscriptBlockRows(block, options);
				if (
					nodeIndex > startIndex &&
					(nodeIndex - startIndex >= maxBlocks ||
						anchorCharacters + nextCharacters > maxCharacters ||
						anchorRows + nextRows > maxRows)
				) {
					break;
				}
				end = nodeIndex + 1;
				anchorCharacters += nextCharacters;
				anchorRows += nextRows;
			}
			const anchorNodes = nodes.slice(startIndex, end);
			const firstMessageIndex =
				anchorNodes[0]?.messageIndexes[0] ?? messages.length;
			const lastMessageIndex =
				(anchorNodes.at(-1)?.messageIndexes.at(-1) ?? firstMessageIndex - 1) +
				1;
			return {
				messages: messages.slice(firstMessageIndex, lastMessageIndex),
				nodes: anchorNodes,
				hiddenBlocks: startIndex,
				truncatedTailBlocks: nodes.length - end,
			};
		}
	}

	let characters = 0;
	let rows = 0;
	let start = nodes.length;
	let pinnedIncluded =
		options.pinnedNodeId === undefined ||
		!nodes.some((node) => node.id === options.pinnedNodeId);

	for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
		const node = nodes[nodeIndex];
		if (!node) continue;
		const block = node.messageIndexes
			.map((messageIndex) => messages[messageIndex])
			.filter((message): message is TranscriptMessage => message !== undefined);
		const nextCharacters = block.reduce(
			(total, message) => total + transcriptMessageCharacters(message),
			0,
		);
		const nextRows = estimateTranscriptBlockRows(block, options);
		const selectedBlocks = nodes.length - start;
		const pinned = node.id === options.pinnedNodeId;
		if (
			pinnedIncluded &&
			selectedBlocks > 0 &&
			(selectedBlocks >= maxBlocks ||
				characters + nextCharacters > maxCharacters ||
				rows + nextRows > maxRows)
		) {
			break;
		}
		start = nodeIndex;
		characters += nextCharacters;
		rows += nextRows;
		if (pinned) pinnedIncluded = true;
	}

	const selectedNodes = nodes.slice(start);
	const firstMessageIndex =
		selectedNodes[0]?.messageIndexes[0] ?? messages.length;
	return {
		messages: messages.slice(firstMessageIndex),
		nodes: selectedNodes,
		hiddenBlocks: start,
		truncatedTailBlocks: 0,
	};
}

function selectTranscriptTail(
	messages: TranscriptMessage[],
	options: TranscriptWindowOptions,
): TranscriptWindow {
	const maxBlocks = Math.max(1, options.maxBlocks ?? 80);
	const maxCharacters = Math.max(1, options.maxCharacters ?? 60_000);
	const maxRows = Math.max(1, options.maxRows);
	const reversedNodes: TranscriptNode[] = [];
	let characters = 0;
	let rows = 0;
	let cursor = messages.length - 1;

	while (cursor >= 0) {
		const message = messages[cursor];
		if (!message || isQueuedTranscriptMessage(message)) {
			cursor -= 1;
			continue;
		}
		let start = cursor;
		if (message.kind === "tool") {
			while (start > 0) {
				const candidate = messages[start - 1];
				if (candidate?.kind !== "tool" || !sameToolGroup(candidate, message))
					break;
				start -= 1;
			}
		}
		const messageIndexes = Array.from(
			{ length: cursor - start + 1 },
			(_, offset) => start + offset,
		);
		const block = messageIndexes
			.map((messageIndex) => messages[messageIndex])
			.filter(
				(candidate): candidate is TranscriptMessage => candidate !== undefined,
			);
		const nextCharacters = block.reduce(
			(total, candidate) => total + transcriptMessageCharacters(candidate),
			0,
		);
		const nextRows = estimateTranscriptBlockRows(block, options);
		if (
			reversedNodes.length > 0 &&
			(reversedNodes.length >= maxBlocks ||
				characters + nextCharacters > maxCharacters ||
				rows + nextRows > maxRows)
		) {
			break;
		}
		reversedNodes.push({
			id: message.kind === "tool" ? toolGroupNodeId(message) : message.id,
			kind: message.kind === "tool" ? "toolGroup" : "message",
			messageIndexes,
		});
		characters += nextCharacters;
		rows += nextRows;
		cursor = start - 1;
	}

	const nodes = reversedNodes.toReversed();
	const firstMessageIndex = nodes[0]?.messageIndexes[0] ?? messages.length;
	return {
		messages: messages.slice(firstMessageIndex),
		nodes,
		hiddenBlocks: cursor >= 0 ? 1 : 0,
		truncatedTailBlocks: 0,
	};
}

function transcriptMessageCharacters(message: TranscriptMessage): number {
	if (message.kind === "thinking")
		return (message.translatedText || message.text).length;
	if (message.kind === "text" || message.kind === "session") {
		return message.text.length;
	}
	if (message.kind === "error")
		return (
			message.summary.length +
			message.detail.length +
			(message.model?.length ?? 0)
		);
	if (message.kind === "tool")
		return (
			message.name.length +
			message.summary.length +
			(message.output?.length ?? 0)
		);
	return message.model.length + message.task.length;
}

function estimatedWrappedRows(text: string, width: number): number {
	return text
		.split("\n")
		.reduce(
			(total, line) =>
				total + Math.max(1, Math.ceil(visibleWidth(line) / width)),
			0,
		);
}

function estimateTranscriptBlockRows(
	block: TranscriptMessage[],
	options: TranscriptWindowOptions,
): number {
	const first = block[0];
	if (!first) return 0;
	const compute = () => estimateTranscriptBlockRowsUncached(block, options);
	const cache = options.cache;
	if (!cache || block.length > 64) return compute();
	// Key on message ids plus every row-affecting mutable state: tool expansion,
	// thinking collapse, and streaming patches all change rendered height while
	// keeping ids stable, and a stale estimate mis-places the window boundary.
	const state = block
		.map((message) => {
			if (message.kind === "tool") return message.expanded ? "1" : "0";
			if (message.kind === "error") return message.expanded ? "1" : "0";
			if (message.kind === "thinking")
				return message.collapsed ? "c" : message.streaming ? "s" : "e";
			if (message.kind === "text") return message.streaming ? "s" : "e";
			return "";
		})
		.join("");
	const key = `rows:${block.map((message) => message.id).join("|")}:${state}:${options.thinkingDisplay ?? "collapsed"}:${options.collapseCompletedTools ? "collapse" : "expand"}`;
	return cache.estimateRows(key, options.width, block, compute);
}

function estimateTranscriptBlockRowsUncached(
	block: TranscriptMessage[],
	options: TranscriptWindowOptions,
): number {
	const first = block[0];
	if (!first) return 0;
	const width = Math.max(1, options.width - 2);
	if (first.kind === "tool") {
		const tools = block.filter(
			(message): message is Extract<TranscriptMessage, { kind: "tool" }> =>
				message.kind === "tool",
		);
		const collapsed =
			options.collapseCompletedTools &&
			allToolsTerminal(tools) &&
			!tools.some((message) => message.expanded);
		if (collapsed) return 2;
		return (
			2 +
			tools.reduce(
				(total, message) =>
					total +
					1 +
					(message.expanded && message.output
						? estimatedWrappedRows(message.output, width)
						: 0),
				0,
			)
		);
	}
	if (first.kind === "text" && first.role === "user") {
		return 3 + estimatedWrappedRows(first.text, Math.max(1, options.width - 4));
	}
	if (first.kind === "session" && first.presentation?.kind === "cron") {
		return 1 + estimatedWrappedRows(first.presentation.prompt, width);
	}
	if (first.kind === "thinking") {
		if (options.thinkingDisplay === "hidden") return 2;
		const displayText = first.translatedText || first.text;
		const boundedText =
			displayText.length > MAX_THINKING_RENDER_CHARS
				? displayText.slice(-MAX_THINKING_RENDER_CHARS)
				: displayText;
		return first.collapsed ? 3 : 2 + estimatedWrappedRows(boundedText, width);
	}
	if (first.kind === "error") {
		return first.expanded ? 1 + estimatedWrappedRows(first.detail, width) : 1;
	}
	if (first.kind === "text") return 1 + estimatedWrappedRows(first.text, width);
	return 2;
}

export function attachmentSummary(
	message: Extract<TranscriptMessage, { kind: "text" }>,
): string[] {
	return (message.attachments ?? []).map(
		(attachment) =>
			`〔${attachment.alias} · ${attachment.width}×${attachment.height} · ${attachment.mimeType.split("/")[1]?.toUpperCase()}〕`,
	);
}

export function deliveryStatus(
	message: Extract<TranscriptMessage, { kind: "text" }>,
): string | undefined {
	if (message.delivery === "cancelled" || message.deliveryState === "cancelled")
		return "队列已取消";
	if (message.deliveryState === "failed") return "回复失败";
	if (message.deliveryState === "queued") return "等待插入";
	if (
		message.deliveryState === "consuming" ||
		message.deliveryState === "started"
	)
		return "已送达模型";
	return undefined;
}

function wrapUserContent(content: string, width: number): string[] {
	return content.split("\n").flatMap((hardLine) => {
		const wrapped = wrapTextWithAnsi(hardLine, width);
		return wrapped.length > 0 ? wrapped : [""];
	});
}

export function renderTranscriptMessage(
	message: TranscriptMessage,
	width: number,
	theme: VspiTheme,
	options: TranscriptRenderOptions = {},
): string[] {
	if (isQueuedTranscriptMessage(message)) return [];
	const selected =
		options.selectedNodeId === message.id || options.inspectedId === message.id;
	let lines: string[];
	if (message.kind === "text" && message.role === "user") {
		const content = [message.text, ...attachmentSummary(message)]
			.filter(Boolean)
			.join(" ");
		const contentLines = wrapUserContent(content, Math.max(1, width - 4));
		const status = deliveryStatus(message);
		lines = [
			theme.userSurface(padLine("", width)),
			...contentLines.map((line) =>
				theme.userSurface(
					padLine(`${theme.focus("▌")} ${line || " "}`, width),
				),
			),
			...(status
				? [
						theme.userSurface(
							padLine(`  ${theme.muted(`↳ ${status}`)}`, width),
						),
					]
				: []),
			theme.userSurface(padLine("", width)),
		];
	} else if (message.kind === "text") {
		const markdownWidth = Math.max(1, width - 2);
		const markdown = options.cache
			? options.cache.renderOfficialAssistant(
					`message:${message.id}`,
					message,
					markdownWidth,
					theme,
					options,
				)
			: renderOfficialAssistant(message, markdownWidth, theme, options);
		if (message.presentation === "formal") {
			const marker = theme.capabilities.unicode ? "✦" : "*";
			const rule = theme.capabilities.unicode ? "─" : "-";
			lines = [
				theme.muted(rule.repeat(Math.max(1, width))),
				...markdown.map(
					(line, index) =>
						`${index === 0 ? `${theme.focus(marker)} ` : "  "}${line}`,
				),
			];
		} else if (message.presentation === "intermediate") {
			const marker = theme.capabilities.unicode ? "·" : "-";
			// Commentary：工具间隙里模型的直接文字输出，主体保持正常文本与 Markdown 主题色，
			// 仅用弱化的首行标记与 formal 区分，不再整块置灰。
			lines = markdown.map(
				(line, index) =>
					`${index === 0 ? `${theme.muted(marker)} ` : "  "}${line}`,
			);
		} else {
			lines = markdown.map(
				(line, index) =>
					`${index === 0 ? `${theme.muted("•")} ` : "  "}${line}`,
			);
		}
		if (message.streaming && lines.length > 0) {
			// 满宽行先把内容截到 width-1，再追加光标，避免后续 padLine 把光标切掉。
			const last = lines.at(-1) ?? "";
			let clipped = last;
			if (visibleWidth(last) >= width) {
				const raw = truncateToWidth(last, Math.max(0, width - 1), "");
				clipped = last.includes("\u001B") ? raw : stripAnsi(raw);
			}
			lines[lines.length - 1] = `${clipped}${theme.focus("▋")}`;
		}
	} else if (message.kind === "thinking") {
		if (
			options.thinkingDisplay === "hidden" &&
			message.streaming &&
			!selected
		) {
			return [theme.muted(`◇  思考中`)];
		}
		if (options.thinkingDisplay === "hidden" && !selected) {
			return [theme.muted("◇  思考 · 已隐藏")];
		}
		const duration =
			message.durationMs === undefined
				? ""
				: ` · ${(message.durationMs / 1000).toFixed(1)}s`;
		const translation =
			message.translationStatus === "pending"
				? " · 翻译中"
				: message.translationStatus === "translated"
					? " · 已翻译"
					: message.translationStatus === "error"
						? " · 翻译失败"
						: "";
		const fullDisplayText = message.translatedText || message.text;
		const renderBounded = fullDisplayText.length > MAX_THINKING_RENDER_CHARS;
		const displayText = renderBounded
			? fullDisplayText.slice(-MAX_THINKING_RENDER_CHARS)
			: fullDisplayText;
		const truncationNotice = renderBounded
			? `   … 思考过长，仅显示末尾 ${MAX_THINKING_RENDER_CHARS.toLocaleString()} 字符（共 ${fullDisplayText.length.toLocaleString()}）`
			: undefined;
		lines = [
			theme.muted(`◇  思考${duration}${translation}`),
		];
		if (truncationNotice) lines.push(theme.warning(truncationNotice));
		if (message.collapsed) {
			const preview = collapsedThinkingPreview(
				displayText,
				Math.max(1, width - 3),
			);
			if (preview) {
				const previewLine = renderMarkdown(
					preview,
					Math.max(1, width - 3),
					theme,
					{
						...(options.wrapCode !== undefined
							? { wrapCode: options.wrapCode }
							: {}),
						streaming: false,
						tone: "thinking",
					},
				).find((line) => stripAnsi(line).trim().length > 0);
				if (previewLine) lines.push(`   ${previewLine}`);
			}
		} else
			lines.push(
				...renderMarkdown(displayText, Math.max(1, width - 3), theme, {
					...(options.wrapCode !== undefined
						? { wrapCode: options.wrapCode }
						: {}),
					...(options.mermaidRendering
						? { mermaidRendering: options.mermaidRendering }
						: {}),
					streaming: message.streaming ?? false,
					tone: "thinking",
				}).map((line) => `   ${line}`),
			);
	} else if (message.kind === "tool") {
		return renderToolGroup([message], width, theme, options);
	} else if (message.kind === "session" && message.presentation?.kind === "cron") {
		const cron = message.presentation;
		const schedule = cron.cron
			? `cron ${cron.cron}`
			: cron.runAt
				? `runAt ${cron.runAt}`
				: "schedule unknown";
		lines = [
			theme.muted(
				`◇ Cron · ${cron.jobId} · ${schedule} · ${cron.recurring ? "recurring" : "one-shot"} · coalesced ${String(cron.coalescedCount)} · ${cron.stale ? "stale" : "active"}`,
			),
			...wrapTextWithAnsi(cron.prompt, Math.max(1, width - 3)).map(
				(line) => `   ${line}`,
			),
		];
	} else if (message.kind === "session" && message.presentation?.kind === "modelSwitch") {
		const text = `模型 ${message.presentation.from} → ${message.presentation.to}`;
		const label = width > 4
			? ` ${truncateToWidth(text, width - 4, "…")} `
			: truncateToWidth(text, width, "");
		const remaining = Math.max(0, width - visibleWidth(label));
		const left = Math.floor(remaining / 2);
		const rule = theme.capabilities.unicode ? "─" : "-";
		lines = [theme.muted(`${rule.repeat(left)}${label}${rule.repeat(remaining - left)}`)];
	} else if (message.kind === "session") {
		lines = wrapTextWithAnsi(theme.muted(`◇ ${message.text}`), width);
	} else if (message.kind === "error") {
		const metadata = [message.summary, message.model]
			.filter(Boolean)
			.join(" · ");
		lines = [`${theme.error("×")} ${theme.error(metadata)}`];
		if (message.expanded) {
			lines.push(
				...wrapTextWithAnsi(message.detail, Math.max(1, width - 2)).map(
					(line) => `  ${theme.muted(line)}`,
				),
			);
		}
	} else {
		const symbol =
			message.status === "success"
				? theme.success("✓")
				: message.status === "error" ||
						message.status === "timed_out" ||
						message.status === "lost"
					? theme.error("×")
					: message.status === "cancelled" || message.status === "killed"
						? theme.warning("−")
						: theme.focus("●");
		const identity =
			message.agentKind === "teammate"
				? (message.teammateId ?? "teammate")
				: "task";
		const lane = message.lane ? ` · lane ${message.lane}` : "";
		const preferred =
			message.preferredModel && message.preferredModel !== message.model
				? ` · preferred ${formatSubagentModel(message.preferredModel)}`
				: "";
		const fallback = message.fallbackReason
			? ` · fallback ${message.fallbackReason}`
			: "";
		const context = message.contextMode ? ` · ${message.contextMode}` : "";
		const agentRole = message.agentRole
			? ` · ${formatSubagentProfile(message.agentRole)}`
			: "";
		const metadata = `${symbol} ${identity}${agentRole} · ${theme.blue(formatSubagentModel(message.model))}${preferred} · ${effortLabel(message.effort)}${context}${lane}${fallback}`;
		// C19 P0-5：运行中的进度行——当前工具、轮次、最近活动、耗时。
		// 2026-08-28：不再渲染 run/tree 预算警戒线行。默认 120K/500K 上限对真实
		// 多轮任务形同虚设，警告常亮失去信息量；用量细节移至 /agents 面板详情。
		const running = message.status === "running" || message.status === "queued";
		const progress = running
			? [
					"Progress",
					`  ${message.currentTool ? `tool ${message.currentTool}` : "thinking"} · turn ${(message.usageTurns ?? 0) + 1}${message.lastActivityAt ? ` · 活动于 ${formatLocalTime(message.lastActivityAt, AGENT_TIMEZONE) ?? "--:--:--"}` : ""}${message.elapsedSeconds !== undefined ? ` · 已运行 ${formatSubagentDuration(message.elapsedSeconds)}` : ""}`,
				]
			: message.elapsedSeconds !== undefined
				? [
						"Progress",
						`  用时 ${formatSubagentDuration(message.elapsedSeconds)} · ${message.status}`,
					]
				: undefined;
		const bodyWidth = Math.max(1, width - 2);
		const body = [
			padLine(metadata, bodyWidth),
			...wrapTextWithAnsi(message.task, bodyWidth).slice(0, 2),
			...(progress
				? [
						theme.focus(progress[0] as string),
						theme.focus(truncateToWidth(progress[1] as string, bodyWidth, "…")),
					]
				: []),
			...(message.outputPreview
				? [
						theme.muted(
							truncateToWidth(
								message.outputPreview.replaceAll(/\s+/g, " ").trim(),
								bodyWidth,
								"…",
							),
						),
					]
				: running
					? [theme.muted("Working...")]
					: []),
		];
		lines = frame(body, width, theme, {
			title: "Subagent",
			rightTitle: message.status,
			focused: selected,
			maxBodyLines: body.length,
		});
	}

	if (selected) return renderSelectedLines(lines, width, theme);
	return lines.map((line) =>
		visibleWidth(line) > width ? padLine(line, width) : line,
	);
}

const ESCAPE = String.fromCodePoint(27);
const BELL = String.fromCodePoint(7);
const OSC133_ZONE = new RegExp(
	`${ESCAPE}\\]133;[ABC](?:${BELL}|${ESCAPE}\\\\)`,
	"gu",
);

type OfficialAssistantMessage = NonNullable<
	ConstructorParameters<typeof AssistantMessageComponent>[0]
>;

function toOfficialAssistantMessage(text: string): OfficialAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "vspi",
		model: "transcript",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as OfficialAssistantMessage;
}

function normalizeOfficialAssistantLines(lines: string[]): string[] {
	const normalized = lines.map((line) => line.replace(OSC133_ZONE, ""));
	while (normalized.length > 0 && stripAnsi(normalized[0] ?? "").trim() === "")
		normalized.shift();
	return normalized;
}

function renderOfficialAssistant(
	message: Extract<TranscriptMessage, { kind: "text" }>,
	width: number,
	theme: VspiTheme,
	options: Pick<TranscriptRenderOptions, "wrapCode" | "mermaidRendering">,
): string[] {
	const component = new AssistantMessageComponent(
		undefined,
		false,
		theme.markdown,
		"Thinking...",
		0,
		[
			createVspiMarkdownTransformer({
				...options,
				unicode: theme.capabilities.unicode,
			}),
		],
	);
	component.updateContent(
		toOfficialAssistantMessage(message.text),
		message.streaming ?? false,
	);
	return postprocessMarkdownLines(
		normalizeOfficialAssistantLines(component.render(width)),
		width,
		theme,
	);
}

/** C19 P0-5：秒数格式化为人类可读时长。 */
function formatSubagentDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function collapsedThinkingPreview(
	text: string,
	width: number,
): string | undefined {
	const sections = text
		.split(/\n\s*\n/gu)
		.map((section) => section.trim())
		.filter(Boolean);
	const latest = sections.at(-1);
	if (!latest) return undefined;
	const line = latest
		.split("\n")
		.map((item) => item.trim())
		.find(Boolean);
	if (!line) return undefined;
	const suffix = sections.length > 1 ? ` · ${sections.length} 段` : "";
	return truncateToWidth(`${line}${suffix}`, width, "…");
}

function toolLabel(name: string): string {
	if (name.toLowerCase() === "question") return "Question";
	return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

interface DiffCursor {
	oldLine: number;
	newLine: number;
}

function parseDiffLine(text: string, cursor: DiffCursor): DiffLine {
	const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
	if (header) {
		cursor.oldLine = Number(header[1]);
		cursor.newLine = Number(header[2]);
		return { kind: "meta", text };
	}
	if (text.startsWith("+")) return { kind: "add", newLine: cursor.newLine++, text: text.slice(1) };
	if (text.startsWith("-")) return { kind: "remove", oldLine: cursor.oldLine++, text: text.slice(1) };
	return { kind: "context", oldLine: cursor.oldLine++, newLine: cursor.newLine++, text: text.replace(/^ /, "") };
}

function parseDiff(value: string): DiffLine[] {
	const cursor = { oldLine: 0, newLine: 0 };
	return value.split("\n").map(text => parseDiffLine(text, cursor));
}

class NativeDiff {
	private revision = -1;
	private line = -1;
	private before: DiffCursor = { oldLine: 0, newLine: 0 };
	private after: DiffCursor = { oldLine: 0, newLine: 0 };
	private previous: DiffLine | undefined;

	parse(text: string, position: ToolOutputPosition): DiffLine {
		if (position.revision !== this.revision) {
			this.revision = position.revision;
			this.line = -1;
			this.after = { oldLine: 0, newLine: 0 };
		}
		if (position.line !== this.line) {
			this.line = position.line;
			this.before = { ...this.after };
			this.previous = undefined;
		}
		if (position.continuation && this.previous) return { ...this.previous, text };
		this.after = { ...this.before };
		this.previous = parseDiffLine(text, this.after);
		return this.previous;
	}
}

export interface TranscriptSection {
	emission?: { start: number; auxiliary?: boolean; origins?: { row: number; column: number }[] };
	layoutWidth?: number;
	references?: readonly TranscriptMessage[];
	nodeId: string;
	kind: "message" | "toolGroup";
	/** Indexes into the `messages` argument the section was rendered from. */
	messageIndexes: number[];
	/** Every message in the section is terminal (not queued/running/streaming). */
	final: boolean;
	/** Thinking blocks carry status/duration on their header row. */
	thinking: boolean;
	/** Rendered lines, including the leading separator row when present. */
	lines: string[];
}

/** Messages that produce a transcript section (the rest render nothing). */
export function isTranscriptSectionVisible(message: TranscriptMessage): boolean {
	return !(
		isQueuedTranscriptMessage(message) ||
		message.kind === "subagent" ||
		(message.kind === "tool" && internalControlTool(message.name))
	);
}

function isSettledTranscriptMessage(message: TranscriptMessage): boolean {
	if (isQueuedTranscriptMessage(message)) return false;
	if (
		message.kind === "tool" &&
		(message.status === "queued" || message.status === "running")
	)
		return false;
	return !("streaming" in message && message.streaming === true);
}

export class LiveToolGroup {
	private tools = new Map<string, { layout: LiveTool; diff: NativeDiff; message: Extract<TranscriptMessage, { kind: "tool" }>; empty: boolean }>();
	private frame: { layout: LiveTool; rows: number }[] = [];
	private leading: string[] = [];
	private separatorSet = false;
	pending = false;
	version = 0;

	render(messages: Extract<TranscriptMessage, { kind: "tool" }>[], width: number, theme: VspiTheme, options: TranscriptRenderOptions, maxRows: number, previewRows: number): string[] {
		const lines = [...this.leading];
		this.frame = [];
		this.pending = false;
		const collapsed = options.collapseCompletedTools && allToolsTerminal(messages) && !messages.some(message => message.expanded);
		const labelWidth = Math.min(Math.max(4, Math.floor(width / 4)), Math.max(...messages.map(message => visibleWidth(toolLabel(message.name)))));
		const deadline = performance.now() + 8;
		for (const [index, message] of messages.entries()) {
			const cached = this.tools.get(message.id);
			if (cached?.message === message && cached.empty && !cached.layout.pending) continue;
			if (lines.length >= maxRows || (this.frame.length > 0 && performance.now() >= deadline)) { this.pending = true; break; }
			const layout = cached?.layout ?? new LiveTool();
			const diff = cached?.diff ?? new NativeDiff();
			const header = index === 0 ? [fitLine(theme.muted(`◇  工具调用 · ${messages.length} 项 · ${toolGroupStatus(messages)}`), width)] : [];
			if (!collapsed) {
				const limit = Math.max(256, width * 4);
				const firstLine = message.expanded ? undefined : message.output?.slice(0, limit)?.match(/\S[^\r\n]*/u)?.[0]?.trim();
				const metadata = { ...message, summary: message.summary.slice(0, limit), output: firstLine, agentRuns: message.agentRuns?.map(run => ({ ...run, name: run.name.slice(0, limit), task: run.task?.slice(0, limit), result: run.result?.slice(0, limit).match(/\S[^\r\n]*/u)?.[0] })) };
				header.push(...renderToolEntry(metadata, index === messages.length - 1, labelWidth, width, theme, options));
			}
			const before = layout.version;
			const chunk = layout.render(message, width, theme, maxRows - lines.length, previewRows, header, (text, position) => {
				const prefix = index === messages.length - 1 ? "   " : theme.muted(theme.capabilities.unicode ? "│  " : "|  ");
				const output = message.name === "edit" && message.output?.startsWith("@@")
					? renderDiff([diff.parse(text, position)], Math.max(1, width - 6), theme)
					: wrapTextWithAnsi(text, Math.max(1, width - 6));
				return output.map(line => fitLine(`${prefix}   ${line}`, width));
			});
			if (layout.version !== before) this.version++;
			this.tools.set(message.id, { layout, diff, message, empty: chunk.length === 0 });
			this.frame.push({ layout, rows: chunk.length });
			lines.push(...chunk);
			if (layout.pending) { this.pending = true; break; }
		}
		return lines;
	}

	beginSection(gap: boolean): boolean {
		if (this.separatorSet) return false;
		this.separatorSet = true;
		if (gap) this.leading = [""];
		return gap;
	}

	freeze(count: number): void {
		const leading = Math.min(count, this.leading.length);
		this.leading.splice(0, leading);
		count -= leading;
		for (const entry of this.frame) {
			if (count <= 0) break;
			const rows = Math.min(count, entry.rows);
			entry.layout.freeze(rows);
			entry.rows -= rows;
			count -= rows;
		}
	}

	beginViewport(): void {
		for (const { layout } of this.tools.values()) layout.beginViewport();
	}
}

export function renderTranscriptSections(
	messages: TranscriptMessage[],
	width: number,
	theme: VspiTheme,
	options: TranscriptRenderOptions = {},
	previousMessage?: TranscriptMessage,
): TranscriptSection[] {
	const sections: TranscriptSection[] = [];
	const visible: { message: TranscriptMessage; index: number }[] = [];
	for (const [index, message] of messages.entries()) {
		if (!isTranscriptSectionVisible(message)) continue;
		visible.push({ message, index });
	}
	let renderedRows = 0;
	const retainedCacheKeys = new Set<string>();
	const cacheState = [
		width,
		options.thinkingDisplay ?? "collapsed",
		options.wrapCode === false ? "nowrap" : "wrap",
		options.collapseCompletedTools ? "collapse-tools" : "expand-tools",
		options.mermaidRendering ?? "final",
		options.selectedNodeId ?? "",
		options.selectedToolId ?? "",
		options.inspectedId ?? "",
	].join(":");
	for (let index = 0; index < visible.length; ) {
		const entry = visible[index];
		if (!entry) break;
		const message = entry.message;
		const nativeText = message.kind === "text" || (message.kind === "thinking" && !message.collapsed && options.thinkingDisplay !== "hidden");
		const nodeId = message.kind === "tool" ? toolGroupNodeId(message) : message.id;
		const skipped = options.live?.committed.has(nodeId) === true;
		const renderWidth = options.live?.width(nodeId) ?? width;
		const nodeCacheState = renderWidth === width ? cacheState : `${renderWidth}${cacheState.slice(String(width).length)}`;
		if (!skipped && options.live && (renderedRows >= options.live.maxRows || (sections.length > 0 && performance.now() >= options.live.deadline))) {
			options.live.defer();
			break;
		}
		let section: TranscriptSection;
		if (message.kind === "tool") {
			const group = [message];
			const groupIndexes = [entry.index];
			let cursor = index + 1;
			while (cursor < visible.length) {
				const candidate = visible[cursor]?.message;
				if (candidate?.kind !== "tool" || !sameToolGroup(message, candidate))
					break;
				group.push(candidate);
				groupIndexes.push(visible[cursor]!.index);
				cursor += 1;
			}
			const key = toolGroupNodeId(message);
			retainedCacheKeys.add(key);
			const state = `${nodeCacheState}:${group.map((tool) => (tool.expanded ? "1" : "0")).join("")}`;
			section = {
				nodeId: key,
				references: group,
				kind: "toolGroup",
				messageIndexes: groupIndexes,
				final: group.every(isSettledTranscriptMessage),
				thinking: false,
				lines: skipped ? [] : options.live ? options.live.renderTools(key, group, Math.max(1, options.live.maxRows - renderedRows - 1)) : [
					...(options.cache?.render(key, group, state, () =>
						renderToolGroup(group, renderWidth, theme, options),
					) ?? renderToolGroup(group, renderWidth, theme, options)),
				],
			};
			section.final = group.every(isSettledTranscriptMessage) && !options.live?.pending(key);
			index = cursor;
		} else {
			const key = `message:${message.id}`;
			retainedCacheKeys.add(key);
			const mutableState =
				message.kind === "thinking"
					? message.collapsed
						? "collapsed"
						: "expanded"
					: "";
			section = {
				nodeId: message.id,
				references: [message],
				kind: "message",
				messageIndexes: [entry.index],
				final: isSettledTranscriptMessage(message) && !options.live?.pending(message.id),
				thinking: message.kind === "thinking",
				lines: skipped ? [] : options.live && nativeText && (message.kind === "text" || message.kind === "thinking")
					? options.live.renderText(message, Math.max(1, options.live.maxRows - renderedRows - 1))
					: [
					...(options.cache?.render(
						key,
						[message],
						`${nodeCacheState}:${mutableState}`,
						() => renderTranscriptMessage(message, renderWidth, theme, options),
					) ?? renderTranscriptMessage(message, renderWidth, theme, options)),
				],
			};
			section.final = isSettledTranscriptMessage(message) && !options.live?.pending(message.id);
			index += 1;
		}
		// 分隔空行属于后一个 section：section 作为最后一块被冻结/提交时
		// 不带分隔行，间隙由后继块提供，重建时间距保持一致。
		// userSurface 等带底色块以整行空白作内边距开头，本身就是分隔行；
		// 上一块以空白行结尾（用户消息的底色内边距）时也不再叠加。
		const previous = sections.at(-1);
		const previousEndsBlank = previous
			? stripAnsi(previous.lines.at(-1) ?? "").trim() === ""
			: previousMessage?.kind === "text" && previousMessage.role === "user";
		const startsWithPad =
			message.kind === "text" && message.role === "user";
		const gap = (previous !== undefined || previousMessage !== undefined) && !previousEndsBlank && !startsWithPad;
		if (!skipped) {
			if (options.live && (nativeText || message.kind === "tool")) {
				if (options.live.beginText(nodeId, gap)) section.lines.unshift("");
			} else if (gap) section.lines.unshift("");
		}
		section.layoutWidth = renderWidth;
		if (options.live) {
			const emitted = options.live.emit(section, Math.max(1, options.live.maxRows - renderedRows));
			section.lines = emitted.lines;
			section.emission = { start: emitted.start, auxiliary: emitted.auxiliary, origins: emitted.origins };
		}
		renderedRows += section.lines.length;
		sections.push(section);
		if (!skipped && options.live?.pending(nodeId)) break;
	}
	options.cache?.retain(retainedCacheKeys, visible.map((entry) => entry.message));
	return sections;
}

export function renderTranscript(
	messages: TranscriptMessage[],
	width: number,
	theme: VspiTheme,
	options: TranscriptRenderOptions = {},
): string[] {
	return renderTranscriptSections(messages, width, theme, options).flatMap(
		(section) => section.lines,
	);
}

function internalControlTool(name: string): boolean {
	return name === "EnterPlanMode" || name === "ExitPlanMode";
}

function sameToolGroup(
	first: Extract<TranscriptMessage, { kind: "tool" }>,
	candidate: Extract<TranscriptMessage, { kind: "tool" }>,
): boolean {
	if (first.groupId || candidate.groupId)
		return first.groupId === candidate.groupId;
	return true;
}

function toolGroupNodeId(
	message: Extract<TranscriptMessage, { kind: "tool" }>,
): string {
	return `tool-group:${message.groupId ?? message.id}`;
}

function renderToolGroup(
	messages: Extract<TranscriptMessage, { kind: "tool" }>[],
	width: number,
	theme: VspiTheme,
	options: TranscriptRenderOptions,
): string[] {
	const nodeId = toolGroupNodeId(
		messages[0] as Extract<TranscriptMessage, { kind: "tool" }>,
	);
	const childSelected = messages.some(
		(message) =>
			message.id === options.selectedToolId ||
			message.id === options.inspectedId,
	);
	const expanded =
		!options.collapseCompletedTools ||
		messages.some((message) => message.expanded) ||
		childSelected;
	const summary = `◇  工具调用 · ${messages.length} 项 · ${toolGroupStatus(messages)}`;
	if (
		options.collapseCompletedTools &&
		allToolsTerminal(messages) &&
		!expanded
	) {
		const line = fitLine(theme.muted(summary), width);
		return options.selectedNodeId === nodeId
			? renderSelectedLines([line], width, theme)
			: [line];
	}
	const header = fitLine(theme.muted(summary), width);
	const lines =
		options.selectedNodeId === nodeId && !childSelected
			? renderSelectedLines([header], width, theme)
			: [header];
	const labelLimit = Math.max(4, Math.floor(width / 4));
	const labelWidth = Math.min(
		labelLimit,
		Math.max(
			...messages.map((message) => visibleWidth(toolLabel(message.name))),
		),
	);
	messages.forEach((message, index) => {
		lines.push(
			...renderToolEntry(
				message,
				index === messages.length - 1,
				labelWidth,
				width,
				theme,
				options,
			),
		);
	});
	return lines;
}

function toolStatusSymbol(
	status: string,
	theme: VspiTheme,
): string {
	return status === "success"
		? theme.success("✓")
		: status === "error" ||
				status === "timed_out" ||
				status === "lost"
			? theme.error("×")
			: status === "cancelled" ||
					status === "killed" ||
					status === "stopping"
				? theme.warning("−")
				: theme.focus("●");
}

function toolStatusText(status: string): string {
	return status === "error" ||
		status === "timed_out" ||
		status === "lost"
		? "失败"
		: status === "cancelled" || status === "killed"
			? "已取消"
			: status === "queued"
				? "等待中"
				: status === "running" ||
						status === "background" ||
						status === "stopping" ||
						status === "detached"
					? "运行中"
					: "";
}

function runElapsed(run: {
	startedAt?: string;
	finishedAt?: string;
}): number | undefined {
	if (run.startedAt === undefined) return undefined;
	const start = Date.parse(run.startedAt);
	if (!Number.isFinite(start)) return undefined;
	const end =
		run.finishedAt === undefined
			? Date.now()
			: Date.parse(run.finishedAt);
	if (!Number.isFinite(end)) return undefined;
	return Math.max(0, Math.floor((end - start) / 1000));
}

// Agent 工具输出的信封行（前台 [summary] 段与后台回执共用这些 key），不是结果内容。
const AGENT_RECEIPT_LINE =
	/^(?:task_id|agent_id|status|stop_reason|actual_subagent_type|automatic_notification|description|next_step|resume_hint|note):/i;

function agentOutcomeLine(
	message: Extract<TranscriptMessage, { kind: "tool" }>,
): string | undefined {
	if (message.output !== undefined) {
		const lines = message.output.split("\n");
		const marker = lines.findIndex((line) => line.trim() === "[summary]");
		const candidates = marker >= 0 ? lines.slice(marker + 1) : lines;
		const line = candidates
			.map((text) => text.trim())
			.find(
				(text) =>
					text.length > 0 &&
					text !== "[summary]" &&
					!AGENT_RECEIPT_LINE.test(text),
			);
		if (line !== undefined) return line;
	}
	for (const run of message.agentRuns ?? []) {
		const line = run.result
			?.split("\n")
			.map((text) => text.trim())
			.find((text) => text.length > 0);
		if (line !== undefined) return line;
	}
	return undefined;
}

function renderToolEntry(
	message: Extract<TranscriptMessage, { kind: "tool" }>,
	last: boolean,
	labelWidth: number,
	width: number,
	theme: VspiTheme,
	options: TranscriptRenderOptions,
): string[] {
	const label = padLine(
		truncateToWidth(toolLabel(message.name), labelWidth, "…"),
		labelWidth,
	);
	const continuation = last
		? "   "
		: theme.muted(theme.capabilities.unicode ? "│  " : "|  ");
	const terminal = !["queued", "running"].includes(message.status);
	const lines: string[] = [];
	if (message.name === "Agent" && (message.agentRuns?.length ?? 0) > 0) {
		const runs = message.agentRuns ?? [];
		for (const [index, run] of runs.entries()) {
			const elapsed = runElapsed(run);
			const detail = [
				run.name,
				run.task,
				run.profile ? formatSubagentProfile(run.profile) : undefined,
				run.model ? formatSubagentModel(run.model) : undefined,
				elapsed === undefined
					? undefined
					: formatSubagentDuration(elapsed),
			]
				.filter(Boolean)
				.join(" · ");
			lines.push(
				fitLine(
					`${theme.muted(treeConnector(last && index === runs.length - 1, theme))} ${toolStatusSymbol(run.status, theme)} ${theme.bold(label)}  ${theme.muted(detail)}`,
					width,
				),
			);
		}
	} else {
		const state = toolStatusText(message.status);
		const summary = message.summary.replaceAll(/\s+/g, " ").trim();
		// Bash 等工具的瞬时标题（"Running:"/"Starting background:"）只在进行中成立，终态去掉前缀。
		const title =
			terminal && state !== "运行中"
				? summary.replace(/^(?:Running|Starting background):\s*/iu, "")
				: summary;
		const backgroundHint =
			message.status === "running" && message.name.toLowerCase() === "bash"
				? " · ctrl+b 转后台"
				: "";
		const duration =
			terminal && message.durationMs !== undefined
				? ` · ${(message.durationMs / 1000).toFixed(1)}s`
				: "";
		const detail = `${title}${duration}${state ? ` · ${state}` : ""}${backgroundHint}`;
		lines.push(
			fitLine(
				`${theme.muted(treeConnector(last, theme))} ${toolStatusSymbol(message.status, theme)} ${theme.bold(label)}  ${theme.muted(detail)}`,
				width,
			),
		);
	}
	if (terminal && !message.expanded) {
		const outputLine =
			message.name === "Agent"
				? agentOutcomeLine(message)
				: message.output
						?.split("\n")
						.map((line) => line.trim())
						.find((line) => line.length > 0);
		const outcome =
			outputLine ??
			(message.status === "success"
				? undefined
				: toolStatusText(message.status) || "失败");
		if (outcome)
			lines.push(
				fitLine(
					`${continuation}${theme.muted(`→ ${outcome}`)}`,
					width,
				),
			);
	}
	const legacyRestricted =
		options.inspectedId !== undefined && options.selectedToolId === undefined;
	if (
		message.expanded &&
		message.output &&
		(!legacyRestricted || options.inspectedId === message.id)
	) {
		const continuation = last
			? "   "
			: theme.muted(theme.capabilities.unicode ? "│  " : "|  ");
		if (message.name === "edit" && message.output.startsWith("@@")) {
			lines.push(
				...renderDiff(
					parseDiff(message.output),
					Math.max(1, width - 6),
					theme,
				).map((line) => fitLine(`${continuation}   ${line}`, width)),
			);
		} else {
			lines.push(
				...wrapTextWithAnsi(message.output, Math.max(1, width - 6)).map(
					(line) => fitLine(`${continuation}   ${line}`, width),
				),
			);
		}
	}
	if (
		options.selectedToolId === message.id ||
		options.inspectedId === message.id
	) {
		return renderSelectedLines(lines, width, theme);
	}
	return lines;
}

function renderSelectedLines(
	lines: string[],
	width: number,
	theme: VspiTheme,
): string[] {
	return lines.map((line, index) => {
		const content = truncateToWidth(line, Math.max(1, width - 2), "…");
		return theme.selected(
			padLine(`${index === 0 ? theme.focus("▌ ") : "  "}${content}`, width),
		);
	});
}

function toolGroupStatus(
	messages: Extract<TranscriptMessage, { kind: "tool" }>[],
): string {
	if (
		messages.some(
			(message) => message.status === "running" || message.status === "queued",
		)
	)
		return "执行中";
	const errors = messages.filter(
		(message) => message.status === "error",
	).length;
	const cancelled = messages.filter(
		(message) => message.status === "cancelled",
	).length;
	if (errors > 0 || cancelled > 0) {
		return [
			errors > 0 ? `${errors} 失败` : "",
			cancelled > 0 ? `${cancelled} 已取消` : "",
		]
			.filter(Boolean)
			.join(" · ");
	}
	return "已完成";
}

function allToolsTerminal(
	messages: Extract<TranscriptMessage, { kind: "tool" }>[],
): boolean {
	return messages.every((message) =>
		["success", "error", "cancelled", "timed_out", "killed", "lost"].includes(
			message.status,
		),
	);
}

function treeConnector(last: boolean, theme: VspiTheme): string {
	if (theme.capabilities.unicode) return last ? "└─" : "├─";
	return last ? "\\-" : "|-";
}

function fitLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}
