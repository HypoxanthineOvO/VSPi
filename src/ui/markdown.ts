import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { fillBackground, padLine, stripAnsi, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

function normalizeHeadings(source: string): string {
  // pi-tui already renders H1 bold + underlined. VSPi intentionally gives H2 the same treatment.
  return source.replace(/^##(?!#)\s+/gm, "# ");
}

function listSymbol(depth: number, unicode: boolean): string {
  if (!unicode) return depth % 3 === 0 ? "*" : depth % 3 === 1 ? "o" : ">";
  return ["•", "◦", "▪"][depth % 3] ?? "•";
}

function replaceListMarker(line: string, theme: VspiTheme): string {
  const plain = stripAnsi(line);
  const match = /^(\s*)- (?:\[[ xX]\] )?/.exec(plain);
  if (!match) return line;
  const depth = Math.floor((match[1]?.length ?? 0) / 4);
  const source = theme.markdown.listBullet("- ");
  const replacement = theme.markdown.listBullet(`${listSymbol(depth, theme.capabilities.unicode)} `);
  return line.replace(source, replacement);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC-8 framing is defined by ESC and BEL controls.
const OSC8_LINK = /\x1b]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b]8;;(?:\x07|\x1b\\)/g;

function showLinkTargets(line: string, theme: VspiTheme): string {
  return line.replace(OSC8_LINK, (link, href: string, label: string) => {
    const comparableHref = href.startsWith("mailto:") ? href.slice(7) : href;
    if (stripAnsi(label) === comparableHref) return link;
    return `${link}${theme.markdown.linkUrl(` (${href})`)}`;
  });
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
    private readonly options: { wrapCode?: boolean } = {},
  ) {
    this.text = text;
    this.tokenizedSource = normalizeHeadings(text);
    this.renderer = new Markdown(this.tokenizedSource, paddingX, 0, theme.markdown, { color: theme.text });
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
    for (const line of rendered) {
      const trimmed = stripAnsi(line).trimStart();
      const fence = trimmed.startsWith("```");
      if (fence) insideCode = !insideCode;
      if (insideCode || fence) {
        output.push(fillBackground(line, width, this.theme.codeBlock));
      } else {
        const withTargets = showLinkTargets(line.trimEnd(), this.theme);
        output.push(...wrapTextWithAnsi(withTargets, width).map((part) => padLine(part, width)));
      }
    }
    return output;
  }
}

export function renderMarkdown(
  text: string,
  width: number,
  theme: VspiTheme,
  options: { wrapCode?: boolean } = {},
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
