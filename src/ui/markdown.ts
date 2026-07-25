import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { fillBackground, padLine, stripAnsi, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

function normalizeHeadings(source: string): string {
  // pi-tui exposes literal hashes for H3+. Keep H1 distinct and use one clean subordinate style for H2+.
  return source.replace(/^#{3,6}(?!#)\s+/gm, "## ");
}

function listSymbol(depth: number): string {
  return ["•", "◦", "▪"][depth % 3] ?? "•";
}

function replaceListMarker(line: string, theme: VspiTheme): string {
  const plain = stripAnsi(line);
  const match = /^(\s*)- (?:\[([ xX])\] )?/.exec(plain);
  if (!match) return line;
  const indent = match[1] ?? "";
  const task = match[2];
  const depth = Math.floor(indent.length / 4);
  const sourceMarker = task === undefined ? "- " : `- [${task}] `;
  const replacementMarker = task === undefined ? `${listSymbol(depth)} ` : `${task === " " ? "○" : "✓"} `;
  const source = `${indent}${theme.markdown.listBullet(sourceMarker)}`;
  const replacement = `${indent}${theme.markdown.listBullet(replacementMarker)}`;
  return line.replace(source, replacement);
}

function styleTableBorders(line: string, theme: VspiTheme): string {
  return line.replace(/[┌┬┐├┼┤└┴┘─│]+/g, (border) => theme.border(border));
}

function codeLabel(fence: string): string {
  const language = fence.slice(3).trim().split(/\s+/, 1)[0];
  return (language || "CODE").toUpperCase();
}

function codeHeader(label: string, width: number, theme: VspiTheme): string {
  const prefix = theme.capabilities.colorLevel === 0 ? `${theme.capabilities.unicode ? "│" : "|"} ` : "  ";
  return fillBackground(theme.markdown.codeBlockBorder(`${prefix}${label}`), width, theme.codeBlock);
}

function codeBody(line: string, width: number, theme: VspiTheme): string {
  if (theme.capabilities.colorLevel > 0) return fillBackground(line, width, theme.codeBlock);
  const border = theme.capabilities.unicode ? "│" : "|";
  return fillBackground(`${border} ${line.replace(/^ {0,2}/, "")}`, width, theme.codeBlock);
}

function pushBlank(output: string[], width: number): void {
  if (output.length === 0 || stripAnsi(output.at(-1) ?? "").trim() === "") return;
  output.push(padLine("", width));
}

export class VspiMarkdown implements Component {
  private readonly renderer: Markdown;
  private text: string;
  // renderer.setText 会全量重新 tokenize；文本（含 wrapCode/宽度处理后的形态）未变时跳过。
  private tokenizedSource: string;

  constructor(
    text: string,
    private readonly theme: VspiTheme,
    paddingX = 0,
    private readonly options: { wrapCode?: boolean; tone?: "default" | "thinking" } = {},
  ) {
    this.text = text;
    this.tokenizedSource = normalizeHeadings(text);
    this.renderer = new Markdown(this.tokenizedSource, paddingX, 0, theme.markdown, {
      color: options.tone === "thinking" ? theme.thinking : theme.text,
    });
  }

  setText(text: string): void {
    this.text = text;
    this.tokenizedSource = normalizeHeadings(text);
    this.renderer.setText(this.tokenizedSource);
  }

  invalidate(): void {
    this.renderer.invalidate();
  }

  render(width: number): string[] {
    const codeWidth = Math.max(1, width - 4);
    const source = normalizeHeadings(
      this.options.wrapCode ? wrapFencedCode(this.text, codeWidth) : truncateFencedCode(this.text, codeWidth),
    );
    if (source !== this.tokenizedSource) {
      this.tokenizedSource = source;
      this.renderer.setText(source);
    }
    const rendered = this.renderer.render(width).map((line) => replaceListMarker(line, this.theme));
    const output: string[] = [];
    let insideCode = false;
    let insideTable = false;
    let codeClosingBlank = false;
    for (const line of rendered) {
      const trimmed = stripAnsi(line).trimStart();
      const fence = trimmed.startsWith("```");
      if (fence && !insideCode) {
        pushBlank(output, width);
        output.push(codeHeader(codeLabel(trimmed), width, this.theme));
        insideCode = true;
        codeClosingBlank = false;
        continue;
      }
      if (fence) {
        insideCode = false;
        pushBlank(output, width);
        codeClosingBlank = true;
        continue;
      }
      if (insideCode) {
        output.push(codeBody(line, width, this.theme));
        continue;
      }
      if (codeClosingBlank && trimmed === "") {
        codeClosingBlank = false;
        continue;
      }
      codeClosingBlank = false;
      const plain = stripAnsi(line).trimStart();
      if (plain.startsWith("┌")) insideTable = true;
      const styled = insideTable ? styleTableBorders(line.trimEnd(), this.theme) : line.trimEnd();
      output.push(...wrapTextWithAnsi(styled, width).map((part) => padLine(part, width)));
      if (insideTable && plain.startsWith("└")) insideTable = false;
    }
    return output;
  }
}

export function renderMarkdown(
  text: string,
  width: number,
  theme: VspiTheme,
  options: { wrapCode?: boolean; tone?: "default" | "thinking" } = {},
): string[] {
  return new VspiMarkdown(text, theme, 0, options).render(width);
}

function wrapFencedCode(source: string, width: number): string {
  let insideFence = false;
  const output: string[] = [];
  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) {
      insideFence = !insideFence;
      output.push(line);
    } else if (insideFence && visibleWidth(line) > width) {
      output.push(...splitVisibleLine(line, width));
    } else {
      output.push(line);
    }
  }
  return output.join("\n");
}

function truncateFencedCode(source: string, width: number): string {
  let insideFence = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      return insideFence ? truncateToWidth(line, width, "…") : line;
    })
    .join("\n");
}

function splitVisibleLine(line: string, width: number): string[] {
  const output: string[] = [];
  let current = "";
  for (const character of line) {
    if (current && visibleWidth(`${current}${character}`) > width) {
      output.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  output.push(current);
  return output;
}
