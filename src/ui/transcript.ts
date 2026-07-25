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
}

export interface TranscriptNode {
  id: string;
  kind: "message" | "toolGroup";
  messageIndexes: number[];
}

export function buildTranscriptNodes(messages: TranscriptMessage[]): TranscriptNode[] {
  const nodes: TranscriptNode[] = [];
  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (!message) break;
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

function attachmentSummary(message: Extract<TranscriptMessage, { kind: "text" }>): string[] {
  return (message.attachments ?? []).map(
    (attachment) =>
      `〔${attachment.alias} · ${attachment.width}×${attachment.height} · ${attachment.mimeType.split("/")[1]?.toUpperCase()}〕`,
  );
}

function deliverySummary(message: Extract<TranscriptMessage, { kind: "text" }>): string {
  if (message.delivery === "steer") return "〔已插入下一次调用〕";
  if (message.delivery === "followUp") return "〔任务完成后继续〕";
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
  const selected = options.selectedNodeId === message.id || options.inspectedId === message.id;
  let lines: string[];
  if (message.kind === "text" && message.role === "user") {
    const content = [message.text, ...attachmentSummary(message), deliverySummary(message)].filter(Boolean).join(" ");
    const contentLines = wrapUserContent(content, Math.max(1, width - 4));
    lines = [
      theme.userSurface(padLine("", width)),
      ...contentLines.map((line) => theme.userSurface(padLine(`${theme.focus("▌")}  ${line || " "}`, width))),
      theme.userSurface(padLine("", width)),
    ];
  } else if (message.kind === "text") {
    const markdown = renderMarkdown(message.text, Math.max(1, width - 2), theme, {
      ...(options.wrapCode !== undefined ? { wrapCode: options.wrapCode } : {}),
    });
    lines = markdown.map((line, index) => `${index === 0 ? theme.focus("◆ ") : "  "}${line}`);
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
    lines = [
      theme.muted(
        `◇ 思考 · Effort ${effortLabel(message.effort)}${duration} · ${message.collapsed ? "已折叠" : "已展开"}`,
      ),
    ];
    if (!message.collapsed)
      lines.push(
        ...renderMarkdown(message.text, Math.max(1, width - 2), theme, {
          ...(options.wrapCode !== undefined ? { wrapCode: options.wrapCode } : {}),
          tone: "thinking",
        }).map((line) => `  ${line}`),
      );
  } else if (message.kind === "tool") {
    return renderToolGroup([message], width, theme, options);
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
  const visible = messages;
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
      output.push(...renderToolGroup(group, width, theme, options));
      index = cursor;
    } else {
      output.push(...renderTranscriptMessage(message, width, theme, options));
      index += 1;
    }
    if (index < visible.length && stripAnsi(output.at(-1) ?? "") !== "") output.push("");
  }
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
