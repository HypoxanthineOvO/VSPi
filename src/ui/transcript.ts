import type { TranscriptMessage } from "../domain/types.js";
import { frame, padLine, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import { type DiffLine, renderDiff } from "./diff.js";
import { renderMarkdown } from "./markdown.js";
import type { VspiTheme } from "./theme.js";

export interface TranscriptRenderOptions {
  inspectedId?: string;
  showThinking?: boolean;
  wrapCode?: boolean;
}

function attachmentSummary(message: Extract<TranscriptMessage, { kind: "text" }>): string[] {
  return (message.attachments ?? []).map(
    (attachment) =>
      `〔${attachment.alias} · ${attachment.width}×${attachment.height} · ${attachment.mimeType.split("/")[1]?.toUpperCase()}〕`,
  );
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
  let lines: string[];
  if (message.kind === "text" && message.role === "user") {
    const content = [message.text, ...attachmentSummary(message)].filter(Boolean).join(" ");
    const wrapped = wrapUserContent(content, Math.max(1, width - 3)).map((line) => ` ${line}`);
    lines = frame(wrapped, width, theme, { focused: true, background: theme.userSurface });
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
    const duration = message.durationMs === undefined ? "" : ` · ${(message.durationMs / 1000).toFixed(1)}s`;
    lines = [theme.muted(`◇ 思考 · effort ${message.effort}${duration} · ${message.collapsed ? "已折叠" : "已展开"}`)];
    if (!message.collapsed)
      lines.push(
        ...renderMarkdown(message.text, Math.max(1, width - 2), theme, {
          ...(options.wrapCode !== undefined ? { wrapCode: options.wrapCode } : {}),
        }).map((line) => `  ${line}`),
      );
  } else if (message.kind === "tool") {
    const symbol =
      message.status === "success"
        ? theme.success("✓")
        : message.status === "error"
          ? theme.error("×")
          : message.status === "cancelled"
            ? theme.warning("−")
            : theme.focus("●");
    lines = [`${theme.muted("├─")} ${symbol} ${theme.text(message.name)} ${theme.muted(message.summary)}`];
    if (message.expanded && message.output && (!options.inspectedId || options.inspectedId === message.id)) {
      if (message.name === "edit" && message.output.startsWith("@@")) {
        lines.push(
          ...renderDiff(parseDiff(message.output), Math.max(1, width - 4), theme).map(
            (line) => `${theme.muted("│")}   ${line}`,
          ),
        );
      } else {
        lines.push(
          ...wrapTextWithAnsi(message.output, Math.max(1, width - 5)).map((line) => `${theme.muted("│")}   ${line}`),
        );
      }
    }
  } else {
    const symbol =
      message.status === "success"
        ? theme.success("✓")
        : message.status === "error"
          ? theme.error("×")
          : theme.focus("●");
    lines = [
      `${theme.muted("└─")} ${symbol} ${theme.blue(message.model)} · ${message.effort} · ${message.task} · ${message.status}`,
    ];
  }

  if (options.inspectedId === message.id) {
    return lines.map((line) => theme.selected(padLine(line, width)));
  }
  return lines.map((line) => (visibleWidth(line) > width ? padLine(line, width) : line));
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
  messages.forEach((message, index) => {
    if (message.kind === "thinking" && options.showThinking === false && options.inspectedId !== message.id) return;
    output.push(...renderTranscriptMessage(message, width, theme, options));
    const laterVisible = messages
      .slice(index + 1)
      .some(
        (candidate) =>
          candidate.kind !== "thinking" || options.showThinking !== false || options.inspectedId === candidate.id,
      );
    if (laterVisible && stripAnsi(output.at(-1) ?? "") !== "") output.push("");
  });
  return output;
}
