import { effortLabel } from "../domain/effort.js";
import type { TranscriptMessage } from "../domain/types.js";
import { padLine, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import { type DiffLine, renderDiff } from "./diff.js";
import { renderMarkdown } from "./markdown.js";
import type { VspiTheme } from "./theme.js";

export interface TranscriptRenderOptions {
  inspectedId?: string;
  selectedNodeId?: string;
  selectedToolId?: string;
  thinkingDisplay?: "hidden" | "collapsed" | "expanded";
  wrapCode?: boolean;
  collapseCompletedTools?: boolean;
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

export class TranscriptRenderCache {
  private entries = new Map<string, TranscriptCacheEntry>();
  private hits = 0;
  private misses = 0;

  render(key: string, references: TranscriptMessage[], state: string, factory: () => string[]): string[] {
    const cached = this.entries.get(key);
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
    this.entries.set(key, { references: [...references], state, lines });
    return lines;
  }

  retain(keys: Set<string>): void {
    for (const key of this.entries.keys()) {
      if (!keys.has(key)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
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
    return first.collapsed ? 3 : 2 + estimatedWrappedRows(first.translatedText || first.text, width);
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
    const markdown = renderMarkdown(message.text, Math.max(1, width - 2), theme, {
      ...(options.wrapCode !== undefined ? { wrapCode: options.wrapCode } : {}),
    });
    lines = markdown.map((line, index) => `${index === 0 ? `${theme.muted("•")} ` : "  "}${line}`);
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
    const displayText = message.translatedText || message.text;
    lines = [
      theme.muted(
        `◇ 思考 · Effort ${effortLabel(message.effort)}${duration}${translation} · ${message.collapsed ? "已折叠" : "已展开"}`,
      ),
    ];
    if (message.collapsed) {
      const preview = collapsedThinkingPreview(displayText, Math.max(1, width - 2));
      if (preview) lines.push(theme.muted(`  ${preview}`));
    } else
      lines.push(
        ...renderMarkdown(displayText, Math.max(1, width - 2), theme, {
          ...(options.wrapCode !== undefined ? { wrapCode: options.wrapCode } : {}),
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
          : theme.focus("●");
    lines = [
      `${theme.muted("└─")} ${symbol} ${theme.blue(message.model)} · ${effortLabel(message.effort)} · ${message.task} · ${message.status}`,
    ];
  }

  if (selected) return renderSelectedLines(lines, width, theme);
  return lines.map((line) => (visibleWidth(line) > width ? padLine(line, width) : line));
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
  options.cache?.retain(retainedCacheKeys);
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
