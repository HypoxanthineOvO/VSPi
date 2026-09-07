import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@moonshot-ai/pi-tui";
import type { VspiTheme } from "./theme.js";

export { visibleWidth, wrapTextWithAnsi, truncateToWidth };

export function stripAnsi(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 27) {
      result += text[index];
      continue;
    }
    const introducer = text[index + 1];
    if (introducer === "[") {
      index += 2;
      while (index < text.length && !/[@-~]/.test(text[index] ?? "")) index += 1;
      continue;
    }
    if (introducer === "]" || introducer === "_") {
      index += 2;
      while (index < text.length) {
        if (text.charCodeAt(index) === 7) break;
        if (text.charCodeAt(index) === 27 && text[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return result;
}

export function padLine(text: string, width: number): string {
  if (width <= 0) return "";
  const raw = truncateToWidth(text, width, "");
  const truncated = text.includes("\u001b") ? raw : stripAnsi(raw);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export function alignRight(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 1 > width) {
    // 溢出时保留右值，截断左值并加省略提示，而不是让整个右值静默丢失。
    if (rightWidth + 1 >= width) return padLine(right, width);
    const available = width - rightWidth - 1;
    const raw = truncateToWidth(left, available, "…");
    const truncated = left.includes("\u001b") ? raw : stripAnsi(raw);
    return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated) - rightWidth))}${right}`;
  }
  return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}

export function emphasizePrefix(text: string, prefix: string, theme: VspiTheme): string {
  if (!prefix || !text.toLowerCase().startsWith(prefix.toLowerCase())) return theme.blue(text);
  const start = text.startsWith("/") && prefix.startsWith("/") ? 1 : 0;
  const leading = text.slice(0, start);
  const matched = text.slice(start, prefix.length);
  const remainder = text.slice(prefix.length);
  if (!matched) return theme.blue(text);
  // 关闭序列用 \x1b[0m 全量复位：仅关属性不关颜色的重置会把 focus 颜色
  // 泄漏到后续内容（包括编辑器反白光标格）上。
  const modifiers = `\u001b[1;4;7m${theme.focus(matched)}\u001b[0m`;
  return `${theme.blue(leading)}${modifiers}${theme.blue(remainder)}`;
}

export function emphasizeVisibleRange(text: string, target: string, theme: VspiTheme): string {
  const plain = stripAnsi(text);
  const start = plain.indexOf(target);
  if (start < 0 || target.length === 0) return text;
  const rangeStart = start + (target.startsWith("/") ? 1 : 0);
  const end = start + target.length;
  if (rangeStart >= end) return text;
  let plainOffset = 0;
  let output = "";

  for (let index = 0; index < text.length; ) {
    if (text.charCodeAt(index) === 27) {
      const introducer = text[index + 1];
      let sequenceEnd = index + 2;
      if (introducer === "[") {
        while (sequenceEnd < text.length && !/[@-~]/.test(text[sequenceEnd] ?? "")) sequenceEnd += 1;
        sequenceEnd = Math.min(text.length, sequenceEnd + 1);
      } else if (introducer === "]" || introducer === "_") {
        while (sequenceEnd < text.length) {
          if (text.charCodeAt(sequenceEnd) === 7) {
            sequenceEnd += 1;
            break;
          }
          if (text.charCodeAt(sequenceEnd) === 27 && text[sequenceEnd + 1] === "\\") {
            sequenceEnd += 2;
            break;
          }
          sequenceEnd += 1;
        }
      }
      output += text.slice(index, sequenceEnd);
      index = sequenceEnd;
      continue;
    }

    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (plainOffset >= rangeStart && plainOffset < end) {
      // 按连续明文段整体包裹并在段尾用 \x1b[0m 全量复位：逐字符发
      // \x1b[27;24;22m 只关属性不关颜色，会把 focus 颜色泄漏到编辑器
      // 的反白光标格上，且高频 SGR 抖动放大重绘成本。
      output += `\u001b[1;4;7m${theme.focus(character)}\u001b[0m`;
    } else {
      output += character;
    }
    plainOffset += character.length;
    index += character.length;
  }
  return output;
}

export interface FrameOptions {
  title?: string;
  rightTitle?: string;
  footer?: string;
  footerPosition?: "left" | "right";
  focused?: boolean;
  background?: (text: string) => string;
  maxBodyLines?: number;
}

export function frame(lines: string[], width: number, theme: VspiTheme, options: FrameOptions = {}): string[] {
  const safeWidth = Math.max(4, width);
  const innerWidth = safeWidth - 2;
  const unicode = theme.capabilities.unicode;
  const chars = unicode
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const borderStyle = options.focused ? theme.focus : theme.border;
  const body = options.maxBodyLines === undefined ? lines : lines.slice(0, options.maxBodyLines);
  const rawRightTitle = options.rightTitle ? ` ${options.rightTitle} ` : "";
  const rightTitle = truncateToWidth(rawRightTitle, innerWidth, "");
  const rawTitle = options.title ? ` ${options.title} ` : "";
  const title = truncateToWidth(rawTitle, Math.max(0, innerWidth - visibleWidth(rightTitle)), "");
  const top = `${chars.tl}${title}${chars.h.repeat(
    Math.max(0, innerWidth - visibleWidth(title) - visibleWidth(rightTitle)),
  )}${rightTitle}${chars.tr}`;
  const footer = truncateToWidth(options.footer ? ` ${options.footer} ` : "", innerWidth, "");
  const bottom =
    options.footerPosition === "left"
      ? `${chars.bl}${footer}${chars.h.repeat(Math.max(0, innerWidth - visibleWidth(footer)))}${chars.br}`
      : `${chars.bl}${chars.h.repeat(Math.max(0, innerWidth - visibleWidth(footer)))}${footer}${chars.br}`;
  const rendered = [borderStyle(padLine(top, safeWidth))];
  for (const line of body.length > 0 ? body : [""]) {
    const content = padLine(line, innerWidth);
    rendered.push(
      `${borderStyle(chars.v)}${options.background ? options.background(content) : content}${borderStyle(chars.v)}`,
    );
  }
  rendered.push(borderStyle(padLine(bottom, safeWidth)));
  return rendered;
}

export function fillBackground(line: string, width: number, background: (text: string) => string): string {
  return background(padLine(line, width));
}

export function horizontalRule(width: number, theme: VspiTheme): string {
  return theme.border((theme.capabilities.unicode ? "─" : "-").repeat(Math.max(0, width)));
}
