import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { effortLabel } from "../domain/effort.js";
import type { TranscriptMessage } from "../domain/types.js";
import { frame, padLine, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import { type DiffLine, renderDiff } from "./diff.js";
import { createVspiMarkdownTransformer, postprocessMarkdownLines, renderMarkdown } from "./markdown.js";
import type { VspiTheme } from "./theme.js";

/** Render cap for a single thinking block. Full text stays in the message for
 *  persistence/export; only the tail is sent through Markdown/layout so a giant
 *  streaming block cannot wedge the TUI renderer or grow the write without bound. */
const MAX_THINKING_RENDER_CHARS = 200_000;

export interface TranscriptRenderOptions {
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

  render(key: string, references: TranscriptMessage[], state: string, factory: () => string[]): string[] {
    const variants = this.entries.get(key);
    const cached = variants?.get(state);
    if (
      cached &&
      cached.state === state &&
      cached.references.length === references.length &&
      cached.references.every((reference, index) => reference === references[index])
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
  estimateRows(key: string, width: number, references: TranscriptMessage[], factory: () => number): number {
    const cacheKey = `${key}@${width}`;
    const cached = this.rowEstimates.get(cacheKey);
    if (
      cached &&
      cached.references.length === references.length &&
      cached.references.every((reference, index) => reference === references[index])
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
        component: new AssistantMessageComponent(undefined, false, theme.markdown, "Thinking...", 0, [
          createVspiMarkdownTransformer({ ...options, unicode: theme.capabilities.unicode }),
        ]),
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
      cached.component.updateContent(toOfficialAssistantMessage(message.text), message.streaming ?? false);
    }
    return postprocessMarkdownLines(normalizeOfficialAssistantLines(cached.component.render(width)), width, theme);
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
      if (!entry.references.some((reference) => retainedReferences.has(reference))) this.rowEstimates.delete(key);
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
): message is Extract<TranscriptMessage, { kind: "text" }> & { delivery: "steer" | "followUp" } {
  return (
    message.kind === "text" &&
    message.role === "user" &&
    (message.delivery === "steer" || message.delivery === "followUp")
  );
}

export function buildTranscriptNodes(messages: TranscriptMessage[]): TranscriptNode[] {
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
      if (candidate?.kind !== "tool" || !sameToolGroup(message, candidate)) break;
      indexes.push(cursor);
      cursor += 1;
    }
    nodes.push({ id: toolGroupNodeId(message), kind: "toolGroup", messageIndexes: indexes });
    index = cursor;
  }
  return nodes;
}

export function selectTranscriptWindow(
  messages: TranscriptMessage[],
  options: TranscriptWindowOptions,
): TranscriptWindow {
  if (options.exactHiddenBlocks === false && !options.startNodeId && !options.pinnedNodeId) {
    return selectTranscriptTail(messages, options);
  }
  const nodes = buildTranscriptNodes(messages);
  if (nodes.length === 0) return { messages: [], nodes: [], hiddenBlocks: 0, truncatedTailBlocks: 0 };

  const maxBlocks = Math.max(1, options.maxBlocks ?? 80);
  const maxCharacters = Math.max(1, options.maxCharacters ?? 60_000);
  const maxRows = Math.max(1, options.maxRows);

  if (options.startNodeId) {
    const startIndex = nodes.findIndex((node) => node.id === options.startNodeId);
    if (startIndex >= 0) {
      let anchorCharacters = 0;
      let anchorRows = 0;
      let end = startIndex;
      for (let nodeIndex = startIndex; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex];
        if (!node) break;
        const block = node.messageIndexes
          .map((messageIndex) => messages[messageIndex])
          .filter((message): message is TranscriptMessage => message !== undefined);
        const nextCharacters = block.reduce((total, message) => total + transcriptMessageCharacters(message), 0);
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
      const firstMessageIndex = anchorNodes[0]?.messageIndexes[0] ?? messages.length;
      const lastMessageIndex = (anchorNodes.at(-1)?.messageIndexes.at(-1) ?? firstMessageIndex - 1) + 1;
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
  let pinnedIncluded = options.pinnedNodeId === undefined || !nodes.some((node) => node.id === options.pinnedNodeId);

  for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
    const node = nodes[nodeIndex];
    if (!node) continue;
    const block = node.messageIndexes
      .map((messageIndex) => messages[messageIndex])
      .filter((message): message is TranscriptMessage => message !== undefined);
    const nextCharacters = block.reduce((total, message) => total + transcriptMessageCharacters(message), 0);
    const nextRows = estimateTranscriptBlockRows(block, options);
    const selectedBlocks = nodes.length - start;
    const pinned = node.id === options.pinnedNodeId;
    if (
      pinnedIncluded &&
      selectedBlocks > 0 &&
      (selectedBlocks >= maxBlocks || characters + nextCharacters > maxCharacters || rows + nextRows > maxRows)
    ) {
      break;
    }
    start = nodeIndex;
    characters += nextCharacters;
    rows += nextRows;
    if (pinned) pinnedIncluded = true;
  }

  const selectedNodes = nodes.slice(start);
  const firstMessageIndex = selectedNodes[0]?.messageIndexes[0] ?? messages.length;
  return {
    messages: messages.slice(firstMessageIndex),
    nodes: selectedNodes,
    hiddenBlocks: start,
    truncatedTailBlocks: 0,
  };
}

function selectTranscriptTail(messages: TranscriptMessage[], options: TranscriptWindowOptions): TranscriptWindow {
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
        if (candidate?.kind !== "tool" || !sameToolGroup(candidate, message)) break;
        start -= 1;
      }
    }
    const messageIndexes = Array.from({ length: cursor - start + 1 }, (_, offset) => start + offset);
    const block = messageIndexes
      .map((messageIndex) => messages[messageIndex])
      .filter((candidate): candidate is TranscriptMessage => candidate !== undefined);
    const nextCharacters = block.reduce((total, candidate) => total + transcriptMessageCharacters(candidate), 0);
    const nextRows = estimateTranscriptBlockRows(block, options);
    if (
      reversedNodes.length > 0 &&
      (reversedNodes.length >= maxBlocks || characters + nextCharacters > maxCharacters || rows + nextRows > maxRows)
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

  const nodes = reversedNodes.reverse();
  const firstMessageIndex = nodes[0]?.messageIndexes[0] ?? messages.length;
  return {
    messages: messages.slice(firstMessageIndex),
    nodes,
    hiddenBlocks: cursor >= 0 ? 1 : 0,
    truncatedTailBlocks: 0,
  };
}

function transcriptMessageCharacters(message: TranscriptMessage): number {
  if (message.kind === "thinking") return (message.translatedText || message.text).length;
  if (message.kind === "text" || message.kind === "session") {
    return message.text.length;
  }
  if (message.kind === "tool") return message.name.length + message.summary.length + (message.output?.length ?? 0);
  return message.model.length + message.task.length;
}

function estimatedWrappedRows(text: string, width: number): number {
  return text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(visibleWidth(line) / width)), 0);
}

function estimateTranscriptBlockRows(block: TranscriptMessage[], options: TranscriptWindowOptions): number {
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
      if (message.kind === "thinking") return message.collapsed ? "c" : message.streaming ? "s" : "e";
      if (message.kind === "text") return message.streaming ? "s" : "e";
      return "";
    })
    .join("");
  const key = `rows:${block.map((message) => message.id).join("|")}:${state}:${options.thinkingDisplay ?? "collapsed"}:${options.collapseCompletedTools ? "collapse" : "expand"}`;
  return cache.estimateRows(key, options.width, block, compute);
}

function estimateTranscriptBlockRowsUncached(block: TranscriptMessage[], options: TranscriptWindowOptions): number {
  const first = block[0];
  if (!first) return 0;
  const width = Math.max(1, options.width - 2);
  if (first.kind === "tool") {
    const tools = block.filter(
      (message): message is Extract<TranscriptMessage, { kind: "tool" }> => message.kind === "tool",
    );
    const collapsed =
      options.collapseCompletedTools && allToolsTerminal(tools) && !tools.some((message) => message.expanded);
    if (collapsed) return 2;
    return (
      2 +
      tools.reduce(
        (total, message) =>
          total + 1 + (message.expanded && message.output ? estimatedWrappedRows(message.output, width) : 0),
        0,
      )
    );
  }
  if (first.kind === "text" && first.role === "user") {
    return 3 + estimatedWrappedRows(first.text, Math.max(1, options.width - 4));
  }
  if (first.kind === "thinking") {
    if (options.thinkingDisplay === "hidden") return 2;
    const displayText = first.translatedText || first.text;
    const boundedText =
      displayText.length > MAX_THINKING_RENDER_CHARS ? displayText.slice(-MAX_THINKING_RENDER_CHARS) : displayText;
    return first.collapsed ? 3 : 2 + estimatedWrappedRows(boundedText, width);
  }
  if (first.kind === "text") return 1 + estimatedWrappedRows(first.text, width);
  return 2;
}

function attachmentSummary(message: Extract<TranscriptMessage, { kind: "text" }>): string[] {
  return (message.attachments ?? []).map(
    (attachment) =>
      `〔${attachment.alias} · ${attachment.width}×${attachment.height} · ${attachment.mimeType.split("/")[1]?.toUpperCase()}〕`,
  );
}

function deliverySummary(message: Extract<TranscriptMessage, { kind: "text" }>): string {
  if (message.delivery === "cancelled") return "〔队列已取消〕";
  return "";
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
  const selected = options.selectedNodeId === message.id || options.inspectedId === message.id;
  let lines: string[];
  if (message.kind === "text" && message.role === "user") {
    const content = [message.text, ...attachmentSummary(message)].filter(Boolean).join(" ");
    const contentLines = wrapUserContent(content, Math.max(1, width - 4));
    const status = deliverySummary(message);
    lines = [
      theme.userSurface(padLine("", width)),
      ...contentLines.map((line) => theme.userSurface(padLine(`${theme.focus("▌")}  ${line || " "}`, width))),
      ...(status ? [theme.userSurface(padLine(`   ${theme.muted(status)}`, width))] : []),
      theme.userSurface(padLine("", width)),
    ];
  } else if (message.kind === "text") {
    const markdownWidth = Math.max(1, width - 2);
    const markdown = options.cache
      ? options.cache.renderOfficialAssistant(`message:${message.id}`, message, markdownWidth, theme, options)
      : renderOfficialAssistant(message, markdownWidth, theme, options);
    if (message.presentation === "formal") {
      const marker = theme.capabilities.unicode ? "✦" : "*";
      const rule = theme.capabilities.unicode ? "─" : "-";
      lines = [
        theme.muted(rule.repeat(Math.max(1, width))),
        ...markdown.map((line, index) => `${index === 0 ? `${theme.focus(marker)} ` : "  "}${line}`),
      ];
    } else if (message.presentation === "intermediate") {
      const marker = theme.capabilities.unicode ? "·" : "-";
      lines = markdown.map((line, index) => theme.muted(`${index === 0 ? `${marker} ` : "  "}${line}`));
    } else {
      lines = markdown.map((line, index) => `${index === 0 ? `${theme.muted("•")} ` : "  "}${line}`);
    }
    if (message.streaming && lines.length > 0) {
      // 满宽行先把内容截到 width-1，再追加光标，避免后续 padLine 把光标切掉。
      const last = lines[lines.length - 1] ?? "";
      let clipped = last;
      if (visibleWidth(last) >= width) {
        const raw = truncateToWidth(last, Math.max(0, width - 1), "");
        clipped = last.includes("\u001b") ? raw : stripAnsi(raw);
      }
      lines[lines.length - 1] = `${clipped}${theme.focus("▋")}`;
    }
  } else if (message.kind === "thinking") {
    if (options.thinkingDisplay === "hidden" && message.streaming && !selected) {
      return [theme.muted(`◇ 思考中 · Effort ${effortLabel(message.effort)}`)];
    }
    if (options.thinkingDisplay === "hidden" && !selected) {
      return [theme.muted("◇ 思考 · 已隐藏")];
    }
    const duration = message.durationMs === undefined ? "" : ` · ${(message.durationMs / 1000).toFixed(1)}s`;
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
    const displayText = renderBounded ? fullDisplayText.slice(-MAX_THINKING_RENDER_CHARS) : fullDisplayText;
    const truncationNotice = renderBounded
      ? `  … 思考过长，仅显示末尾 ${MAX_THINKING_RENDER_CHARS.toLocaleString()} 字符（共 ${fullDisplayText.length.toLocaleString()}）`
      : undefined;
    lines = [
      theme.muted(
        `◇ 思考 · Effort ${effortLabel(message.effort)}${duration}${translation} · ${message.collapsed ? "已折叠" : "已展开"}`,
      ),
    ];
    if (truncationNotice) lines.push(theme.warning(truncationNotice));
    if (message.collapsed) {
      const preview = collapsedThinkingPreview(displayText, Math.max(1, width - 2));
      if (preview) lines.push(theme.muted(`  ${preview}`));
    } else
      lines.push(
        ...renderMarkdown(displayText, Math.max(1, width - 2), theme, {
          ...(options.wrapCode !== undefined ? { wrapCode: options.wrapCode } : {}),
          ...(options.mermaidRendering ? { mermaidRendering: options.mermaidRendering } : {}),
          streaming: message.streaming ?? false,
          tone: "thinking",
        }).map((line) => `  ${line}`),
      );
  } else if (message.kind === "tool") {
    return renderToolGroup([message], width, theme, options);
  } else if (message.kind === "session") {
    lines = [theme.muted(`◇ ${message.text}`)];
  } else {
    const symbol =
      message.status === "success"
        ? theme.success("✓")
        : message.status === "error"
          ? theme.error("×")
          : message.status === "cancelled"
            ? theme.warning("−")
            : theme.focus("●");
    const identity = message.agentKind === "teammate" ? (message.teammateId ?? "teammate") : "task";
    const lane = message.lane ? ` · lane ${message.lane}` : "";
    const preferred =
      message.preferredModel && message.preferredModel !== message.model
        ? ` · preferred ${message.preferredModel}`
        : "";
    const fallback = message.fallbackReason ? ` · fallback ${message.fallbackReason}` : "";
    const context = message.contextMode ? ` · ${message.contextMode}` : "";
    const agentRole = message.agentRole ? ` · ${message.agentRole}` : "";
    const metadata = `${symbol} ${identity}${agentRole} · ${theme.blue(message.model)}${preferred} · ${effortLabel(message.effort)}${context}${lane}${fallback}`;
    // C19 P0-5：运行中的进度行——当前工具、轮次、最近活动、耗时。
    const running = message.status === "running" || message.status === "queued";
    const progress = running
      ? [
          "Progress",
          `  ${message.currentTool ? `tool ${message.currentTool}` : "thinking"} · turn ${(message.usageTurns ?? 0) + 1}${message.lastActivityAt ? ` · 活动于 ${message.lastActivityAt.slice(11, 19)}` : ""}${message.elapsedSeconds !== undefined ? ` · 已运行 ${formatSubagentDuration(message.elapsedSeconds)}` : ""}`,
        ]
      : message.elapsedSeconds !== undefined
        ? ["Progress", `  用时 ${formatSubagentDuration(message.elapsedSeconds)} · ${message.status}`]
        : undefined;
    const usageLine =
      message.runTokensUsed !== undefined && message.runTokensMax !== undefined
        ? `  run ${formatSubagentTokens(message.runTokensUsed)} / ${formatSubagentTokens(message.runTokensMax)}${message.warnRunTokens ? " ⚠ 超警戒线" : ""}${message.treeTokensUsed !== undefined && message.treeTokensMax !== undefined ? ` · tree ${formatSubagentTokens(message.treeTokensUsed)} / ${formatSubagentTokens(message.treeTokensMax)}${message.warnTreeTokens ? " ⚠ 超警戒线" : ""}` : ""}`
        : undefined;
    const bodyWidth = Math.max(1, width - 2);
    const body = [
      padLine(metadata, bodyWidth),
      ...wrapTextWithAnsi(message.task, bodyWidth).slice(0, 2),
      ...(progress
        ? [theme.focus(progress[0] as string), theme.focus(truncateToWidth(progress[1] as string, bodyWidth, "…"))]
        : []),
      ...(usageLine
        ? [
            message.warnRunTokens || message.warnTreeTokens
              ? theme.warning(truncateToWidth(usageLine, bodyWidth, "…"))
              : theme.muted(truncateToWidth(usageLine, bodyWidth, "…")),
          ]
        : []),
      ...(message.outputPreview
        ? [theme.muted(truncateToWidth(message.outputPreview, bodyWidth, "…"))]
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
  return lines.map((line) => (visibleWidth(line) > width ? padLine(line, width) : line));
}

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const OSC133_ZONE = new RegExp(`${ESCAPE}\\]133;[ABC](?:${BELL}|${ESCAPE}\\\\)`, "gu");

type OfficialAssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;

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
  while (normalized.length > 0 && stripAnsi(normalized[0] ?? "").trim() === "") normalized.shift();
  return normalized;
}

function renderOfficialAssistant(
  message: Extract<TranscriptMessage, { kind: "text" }>,
  width: number,
  theme: VspiTheme,
  options: Pick<TranscriptRenderOptions, "wrapCode" | "mermaidRendering">,
): string[] {
  const component = new AssistantMessageComponent(undefined, false, theme.markdown, "Thinking...", 0, [
    createVspiMarkdownTransformer({ ...options, unicode: theme.capabilities.unicode }),
  ]);
  component.updateContent(toOfficialAssistantMessage(message.text), message.streaming ?? false);
  return postprocessMarkdownLines(normalizeOfficialAssistantLines(component.render(width)), width, theme);
}

function formatSubagentTokens(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value / 1_000)}K`;
}

/** C19 P0-5：秒数格式化为人类可读时长。 */
function formatSubagentDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function collapsedThinkingPreview(text: string, width: number): string | undefined {
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

function parseDiff(value: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return value.split("\n").map((text) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      return { kind: "meta", text };
    }
    if (text.startsWith("+")) return { kind: "add", newLine: newLine++, text: text.slice(1) };
    if (text.startsWith("-")) return { kind: "remove", oldLine: oldLine++, text: text.slice(1) };
    const result: DiffLine = { kind: "context", oldLine, newLine, text: text.replace(/^ /, "") };
    oldLine += 1;
    newLine += 1;
    return result;
  });
}

export function renderTranscript(
  messages: TranscriptMessage[],
  width: number,
  theme: VspiTheme,
  options: TranscriptRenderOptions = {},
): string[] {
  const output: string[] = [];
  const visible = messages.filter((message) => !isQueuedTranscriptMessage(message));
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
    const message = visible[index];
    if (!message) break;
    if (message.kind === "tool") {
      const group = [message];
      let cursor = index + 1;
      while (cursor < visible.length) {
        const candidate = visible[cursor];
        if (candidate?.kind !== "tool" || !sameToolGroup(message, candidate)) break;
        group.push(candidate);
        cursor += 1;
      }
      const key = toolGroupNodeId(message);
      retainedCacheKeys.add(key);
      const state = `${cacheState}:${group.map((tool) => (tool.expanded ? "1" : "0")).join("")}`;
      output.push(
        ...(options.cache?.render(key, group, state, () => renderToolGroup(group, width, theme, options)) ??
          renderToolGroup(group, width, theme, options)),
      );
      index = cursor;
    } else {
      const key = `message:${message.id}`;
      retainedCacheKeys.add(key);
      const mutableState = message.kind === "thinking" ? (message.collapsed ? "collapsed" : "expanded") : "";
      output.push(
        ...(options.cache?.render(key, [message], `${cacheState}:${mutableState}`, () =>
          renderTranscriptMessage(message, width, theme, options),
        ) ?? renderTranscriptMessage(message, width, theme, options)),
      );
      index += 1;
    }
    if (index < visible.length && stripAnsi(output.at(-1) ?? "") !== "") output.push("");
  }
  options.cache?.retain(retainedCacheKeys, visible);
  return output;
}

function sameToolGroup(
  first: Extract<TranscriptMessage, { kind: "tool" }>,
  candidate: Extract<TranscriptMessage, { kind: "tool" }>,
): boolean {
  if (first.groupId || candidate.groupId) return first.groupId === candidate.groupId;
  return true;
}

function toolGroupNodeId(message: Extract<TranscriptMessage, { kind: "tool" }>): string {
  return `tool-group:${message.groupId ?? message.id}`;
}

function renderToolGroup(
  messages: Extract<TranscriptMessage, { kind: "tool" }>[],
  width: number,
  theme: VspiTheme,
  options: TranscriptRenderOptions,
): string[] {
  const nodeId = toolGroupNodeId(messages[0] as Extract<TranscriptMessage, { kind: "tool" }>);
  const childSelected = messages.some(
    (message) => message.id === options.selectedToolId || message.id === options.inspectedId,
  );
  const expanded = !options.collapseCompletedTools || messages.some((message) => message.expanded) || childSelected;
  const summary = `◇ 工具调用 · ${messages.length} 项 · ${toolGroupStatus(messages)}`;
  if (options.collapseCompletedTools && allToolsTerminal(messages) && !expanded) {
    const line = fitLine(theme.muted(summary), width);
    return options.selectedNodeId === nodeId ? renderSelectedLines([line], width, theme) : [line];
  }
  const header = fitLine(theme.muted(summary), width);
  const lines =
    options.selectedNodeId === nodeId && !childSelected ? renderSelectedLines([header], width, theme) : [header];
  const labelLimit = Math.max(4, Math.floor(width / 4));
  const labelWidth = Math.min(
    labelLimit,
    Math.max(...messages.map((message) => visibleWidth(toolLabel(message.name)))),
  );
  messages.forEach((message, index) => {
    lines.push(...renderToolEntry(message, index === messages.length - 1, labelWidth, width, theme, options));
  });
  return lines;
}

function renderToolEntry(
  message: Extract<TranscriptMessage, { kind: "tool" }>,
  last: boolean,
  labelWidth: number,
  width: number,
  theme: VspiTheme,
  options: TranscriptRenderOptions,
): string[] {
  const symbol =
    message.status === "success"
      ? theme.success("✓")
      : message.status === "error"
        ? theme.error("×")
        : message.status === "cancelled"
          ? theme.warning("−")
          : theme.focus("●");
  const state =
    message.status === "error"
      ? "失败"
      : message.status === "cancelled"
        ? "已取消"
        : message.status === "queued"
          ? "等待中"
          : message.status === "running"
            ? "运行中"
            : "";
  const summary = message.summary.replace(/\s+/g, " ").trim();
  const label = padLine(truncateToWidth(toolLabel(message.name), labelWidth, "…"), labelWidth);
  const detail = state ? `${summary} · ${state}` : summary;
  const lines = [
    fitLine(`${theme.muted(treeConnector(last, theme))} ${symbol} ${theme.bold(label)}  ${theme.muted(detail)}`, width),
  ];
  const legacyRestricted = options.inspectedId !== undefined && options.selectedToolId === undefined;
  if (message.expanded && message.output && (!legacyRestricted || options.inspectedId === message.id)) {
    const continuation = last ? "   " : theme.muted(theme.capabilities.unicode ? "│  " : "|  ");
    if (message.name === "edit" && message.output.startsWith("@@")) {
      lines.push(
        ...renderDiff(parseDiff(message.output), Math.max(1, width - 6), theme).map((line) =>
          fitLine(`${continuation}   ${line}`, width),
        ),
      );
    } else {
      lines.push(
        ...wrapTextWithAnsi(message.output, Math.max(1, width - 6)).map((line) =>
          fitLine(`${continuation}   ${line}`, width),
        ),
      );
    }
  }
  if (options.selectedToolId === message.id || options.inspectedId === message.id) {
    return renderSelectedLines(lines, width, theme);
  }
  return lines;
}

function renderSelectedLines(lines: string[], width: number, theme: VspiTheme): string[] {
  return lines.map((line, index) => {
    const content = truncateToWidth(line, Math.max(1, width - 2), "…");
    return theme.selected(padLine(`${index === 0 ? theme.focus("▌ ") : "  "}${content}`, width));
  });
}

function toolGroupStatus(messages: Extract<TranscriptMessage, { kind: "tool" }>[]): string {
  if (messages.some((message) => message.status === "running" || message.status === "queued")) return "执行中";
  const errors = messages.filter((message) => message.status === "error").length;
  const cancelled = messages.filter((message) => message.status === "cancelled").length;
  if (errors > 0 || cancelled > 0) {
    return [errors > 0 ? `${errors} 失败` : "", cancelled > 0 ? `${cancelled} 已取消` : ""].filter(Boolean).join(" · ");
  }
  return "已完成";
}

function allToolsTerminal(messages: Extract<TranscriptMessage, { kind: "tool" }>[]): boolean {
  return messages.every((message) => ["success", "error", "cancelled"].includes(message.status));
}

function treeConnector(last: boolean, theme: VspiTheme): string {
  if (theme.capabilities.unicode) return last ? "└─" : "├─";
  return last ? "\\-" : "|-";
}

function fitLine(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}
