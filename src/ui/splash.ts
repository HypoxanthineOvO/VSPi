import { alignRight, frame, padLine, visibleWidth } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

export interface StartupStatus {
  model: string;
  backend: "Pi" | "Fixture";
  policy: string;
  boundary: "Sandboxed" | "Host";
  version: string;
  recovery?: boolean;
}

const LOGO = [
  "██╗   ██╗███████╗██████╗ ██╗",
  "██║   ██║██╔════╝██╔══██╗██║",
  "██║   ██║███████╗██████╔╝██║",
  "╚██╗ ██╔╝╚════██║██╔═══╝ ██║",
  " ╚████╔╝ ███████║██║     ██║",
  "  ╚═══╝  ╚══════╝╚═╝     ╚═╝",
] as const;

export function renderSplash(width: number, theme: VspiTheme, progress = 1, status?: StartupStatus): string[] {
  const compact = width < 58 || !theme.capabilities.unicode;
  const inner = Math.max(1, width - 2);
  const body: string[] = [];
  body.push(theme.focus(` ${theme.capabilities.unicode ? "◈" : "*"} VSPi`));
  body.push("");
  if (compact) {
    body.push(theme.bold(theme.focus("   VSPi")));
  } else {
    for (const line of LOGO) body.push(theme.bold(theme.focus(`   ${line}`)));
  }

  if (status) {
    body.push("");
    if (status.recovery) body.push(theme.warning(" Recovery · 恢复模式 · global-only"));
    body.push(`${theme.muted(" Model  ")}${theme.text(status.model)}`);
    body.push(`${theme.muted(" Backend ")}${theme.focus(status.backend)}`);
    const policy = `${theme.muted(" Policy ")}${theme.focus(status.policy)}${theme.muted(" · ")}${theme.blue(status.boundary)}`;
    const version = theme.blue(`v${status.version}`);
    if (visibleWidth(policy) + visibleWidth(version) + 1 <= inner) {
      body.push(alignRight(policy, version, inner));
    } else {
      body.push(policy);
      body.push(alignRight("", version, inner));
    }
  } else if (progress < 1) {
    body.push("");
    const available = Math.max(8, inner - 4);
    const filled = Math.max(1, Math.floor(available * progress));
    const full = theme.capabilities.unicode ? "━" : "#";
    const empty = theme.capabilities.unicode ? "─" : "-";
    body.push(theme.muted(` ${full.repeat(filled)}${empty.repeat(available - filled)}`));
  }
  return frame(
    body.map((line) => padLine(line, inner)),
    width,
    theme,
    { focused: true },
  );
}

export interface StartupSequenceOptions {
  width: number;
  theme: VspiTheme;
  write: (chunk: string) => void;
  startApp: () => Promise<StartupStatus> | StartupStatus;
  startTui: () => Promise<void> | void;
  /** 返回当前终端宽度；静态帧与最终状态帧都会调用，以便响应 resize。缺省时固定为 width。 */
  getWidth?: () => number;
}

function replaceFrame(previousHeight: number, nextFrame: string[]): string {
  const moveToTop = previousHeight > 1 ? `\x1b[${previousHeight - 1}A` : "";
  return `\r${moveToTop}\x1b[J${nextFrame.join("\n")}`;
}

export async function runStartupSequence(options: StartupSequenceOptions): Promise<void> {
  const currentWidth = (): number => Math.max(1, options.getWidth?.() ?? options.width);
  const safeWidth = (): number => Math.max(4, currentWidth() - 1);
  const frame = renderSplash(safeWidth(), options.theme, 0);
  options.write(frame.join("\n"));
  const status = await options.startApp();
  const finalFrame = renderSplash(safeWidth(), options.theme, 1, status);
  options.write(`${replaceFrame(frame.length, finalFrame)}\n`);
  await options.startTui();
}
