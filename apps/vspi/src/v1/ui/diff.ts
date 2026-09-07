import { padLine, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

export interface DiffLine {
  kind: "context" | "add" | "remove" | "meta";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export function renderDiff(lines: DiffLine[], width: number, theme: VspiTheme): string[] {
  // gutter 宽度必须与下方 numbers 前缀的实际列数一致：宽屏 4+1+4+1+1+1=12，窄屏 3+1+1=5。
  const gutterWidth = width >= 72 ? 12 : 5;
  const contentWidth = Math.max(8, width - gutterWidth);
  const rendered: string[] = [];
  for (const line of lines) {
    if (line.kind === "meta") {
      rendered.push(theme.blue(padLine(line.text, width)));
      continue;
    }
    const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
    const numbers =
      width >= 72
        ? `${line.oldLine?.toString().padStart(4) ?? "    "} ${line.newLine?.toString().padStart(4) ?? "    "} ${marker} `
        : `${line.newLine?.toString().padStart(3) ?? "   "}${marker} `;
    const style = line.kind === "add" ? theme.success : line.kind === "remove" ? theme.error : theme.muted;
    const wrapped = wrapTextWithAnsi(line.text, contentWidth);
    wrapped.forEach((part, index) => {
      const prefix = index === 0 ? numbers : " ".repeat(visibleWidth(numbers));
      rendered.push(style(padLine(`${prefix}${part}`, width)));
    });
  }
  return rendered;
}
