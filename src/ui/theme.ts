import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Chalk } from "chalk";
import hljs from "highlight.js";
import type { AppSettings } from "../domain/types.js";
import type { TerminalCapabilities } from "./capabilities.js";

export const PALETTE = {
  background: "#111315",
  text: "#E8EAED",
  muted: "#92989F",
  thinkingText: "#AEB4BA",
  focus: "#5FC7C7",
  blue: "#8FB7FF",
  success: "#7CCB8A",
  warning: "#E4B860",
  error: "#F07878",
  planBackground: "#182529",
  selectionBackground: "#2B3E41",
  safeBadgeBackground: "#244A31",
  safeBadgeText: "#B8F5C4",
  standardBadgeBackground: "#54451F",
  standardBadgeText: "#FFE39A",
  yoloBadgeBackground: "#5A351C",
  yoloBadgeText: "#FFC38A",
  autoBadgeBackground: "#55272B",
  autoBadgeText: "#FFB0B0",
  codeBackground: "#202428",
  userBackground: "#202428",
  userText: "#F4F7FA",
  activityBackground: "#182529",
  noticeBackground: "#252B2F",
  border: "#465058",
} as const;

const LIGHT_PALETTE = {
  text: "#202428",
  muted: "#626A72",
  thinkingText: "#4F5962",
  focus: "#087E8B",
  blue: "#2459A9",
  success: "#26753A",
  warning: "#8A5A00",
  error: "#B3261E",
  border: "#A7ADB3",
  selectionBackground: "#DDEDEF",
  planBackground: "#EEF5F5",
  codeBackground: "#EEF0F2",
  userBackground: "#E9ECEF",
  activityBackground: "#EEF5F5",
  noticeBackground: "#ECEFF1",
  userText: "#202428",
} as const;

export interface VspiTheme {
  capabilities: TerminalCapabilities;
  plain: (text: string) => string;
  text: (text: string) => string;
  muted: (text: string) => string;
  thinking: (text: string) => string;
  focus: (text: string) => string;
  blue: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  border: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  inverse: (text: string) => string;
  selected: (text: string) => string;
  policyBadge: (policy: "Safe" | "Standard" | "YOLO" | "Auto", text: string) => string;
  planSurface: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  userSurface: (text: string) => string;
  activitySurface: (text: string) => string;
  noticeSurface: (text: string) => string;
  markdown: MarkdownTheme;
}

type Styler = (text: string) => string;

function htmlDecode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function syntaxLines(
  code: string,
  language: string | undefined,
  styles: Record<string, Styler>,
  base: Styler,
): string[] {
  let highlighted: string;
  try {
    highlighted =
      language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
  } catch {
    return code.split("\n").map(base);
  }

  const stack: Styler[] = [base];
  let current = "";
  const output: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      output.push(stack[stack.length - 1]?.(htmlDecode(current)) ?? current);
      current = "";
    }
  };

  for (const token of highlighted.split(/(<span class="hljs-[^"]+">|<\/span>)/g)) {
    if (!token) continue;
    if (token === "</span>") {
      flush();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const match = /^<span class="hljs-([^"]+)">$/.exec(token);
    if (match) {
      flush();
      stack.push(styles[match[1] ?? ""] ?? base);
      continue;
    }
    current += token;
  }
  flush();

  return output.join("").split("\n");
}

export function createTheme(capabilities: TerminalCapabilities, mode: AppSettings["theme"] = "VSPi Dark"): VspiTheme {
  const chalk = new Chalk({ level: capabilities.colorLevel });
  const terminalMode = mode === "Terminal";
  const palette = mode === "VSPi Light" ? LIGHT_PALETTE : PALETTE;
  const color = (hex: string, ansi256: number): Styler =>
    terminalMode
      ? (value) => value
      : capabilities.truecolor
        ? chalk.hex(hex)
        : capabilities.colorLevel >= 2
          ? chalk.ansi256(ansi256)
          : (value) => value;
  const bg = (hex: string, ansi256: number): Styler =>
    terminalMode
      ? (value) => value
      : capabilities.truecolor
        ? chalk.bgHex(hex)
        : capabilities.colorLevel >= 2
          ? chalk.bgAnsi256(ansi256)
          : (value) => value;

  const text = color(palette.text, 255);
  const muted = terminalMode ? chalk.dim : color(palette.muted, 246);
  const thinking = terminalMode ? chalk.dim : color(palette.thinkingText, 249);
  const focus = terminalMode ? chalk.cyan : color(palette.focus, 80);
  const blue = terminalMode ? chalk.blue : color(palette.blue, 111);
  const success = terminalMode ? chalk.green : color(palette.success, 114);
  const warning = terminalMode ? chalk.yellow : color(palette.warning, 179);
  const error = terminalMode ? chalk.red : color(palette.error, 210);
  const border = terminalMode ? chalk.dim : color(palette.border, 240);
  const selectionBg = terminalMode ? chalk.inverse : bg(palette.selectionBackground, 237);
  const policyBadges = {
    Safe: (value: string) => bg(PALETTE.safeBadgeBackground, 22)(color(PALETTE.safeBadgeText, 120)(chalk.bold(value))),
    Standard: (value: string) =>
      bg(PALETTE.standardBadgeBackground, 58)(color(PALETTE.standardBadgeText, 222)(chalk.bold(value))),
    YOLO: (value: string) => bg(PALETTE.yoloBadgeBackground, 94)(color(PALETTE.yoloBadgeText, 215)(chalk.bold(value))),
    Auto: (value: string) => bg(PALETTE.autoBadgeBackground, 52)(color(PALETTE.autoBadgeText, 217)(chalk.bold(value))),
  } as const;
  const planBg = bg(palette.planBackground, 235);
  const codeBg = bg(palette.codeBackground, 236);
  const userBg = bg(palette.userBackground, 236);
  const activityBg = bg(palette.activityBackground, 235);
  const noticeBg = bg(palette.noticeBackground, 236);
  const userText = color(palette.userText, 255);
  const code = (value: string) => (terminalMode ? chalk.underline(warning(value)) : codeBg(warning(value)));
  const codeBlock = (value: string) => codeBg(text(value));

  const syntaxStyles: Record<string, Styler> = {
    keyword: terminalMode ? chalk.magenta : focus,
    string: terminalMode ? chalk.green : success,
    number: terminalMode ? chalk.yellow : warning,
    literal: warning,
    comment: terminalMode ? chalk.dim : muted,
    title: blue,
    function: blue,
    variable: text,
    attr: focus,
    type: blue,
    built_in: blue,
    meta: muted,
  };

  const markdown: MarkdownTheme = {
    heading: blue,
    link: blue,
    linkUrl: muted,
    code,
    codeBlock,
    codeBlockBorder: muted,
    quote: blue,
    quoteBorder: focus,
    hr: border,
    listBullet: focus,
    bold: chalk.bold,
    italic: chalk.italic,
    strikethrough: chalk.strikethrough,
    underline: chalk.underline,
    highlightCode: (source, language) => syntaxLines(source, language, syntaxStyles, text),
    codeBlockIndent: "  ",
  };

  return {
    capabilities,
    plain: (value) => value,
    text,
    muted,
    thinking,
    focus,
    blue,
    success,
    warning,
    error,
    border,
    bold: chalk.bold,
    italic: chalk.italic,
    underline: chalk.underline,
    inverse: chalk.inverse,
    selected: (value) => selectionBg(text(value)),
    policyBadge: (policy, value) => policyBadges[policy](value),
    planSurface: (value) => planBg(text(value)),
    code,
    codeBlock,
    userSurface: (value) => userBg(userText(value)),
    activitySurface: (value) => activityBg(text(value)),
    noticeSurface: (value) => noticeBg(text(value)),
    markdown,
  };
}
