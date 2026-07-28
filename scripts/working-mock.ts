import { type Component, Key, matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { padLine, visibleWidth } from "../src/ui/ansi.js";
import { detectTerminalCapabilities } from "../src/ui/capabilities.js";
import { createTheme, type VspiTheme } from "../src/ui/theme.js";

const BALL_FRAMES = ["○", "◉", "●", "⬤", "●", "◉"] as const;
const BRAILLE_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

class WorkingMock implements Component {
  private frame = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly theme: VspiTheme,
    private readonly quit: () => void,
  ) {}

  tick(): void {
    this.frame += 1;
  }

  render(width: number): string[] {
    const elapsed = `${Math.floor((Date.now() - this.startedAt) / 1_000)}`.padStart(2, "0");
    return [
      this.theme.bold(this.theme.focus(padLine(" Working 状态 TUI Mock", width))),
      "",
      this.theme.muted(padLine(" 1 · 小方块活动轨", width)),
      this.activityLine(width, elapsed),
      "",
      this.theme.muted(padLine(" 2 · Composer 大圆状态灯", width)),
      ...this.composerMock(width, elapsed, false),
      "",
      this.theme.muted(padLine(" 3 · Composer 大圆 + 放大思考格", width)),
      ...this.composerMock(width, elapsed, true),
      "",
      this.theme.muted(padLine(" Ctrl+C / q 退出", width)),
    ];
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, Key.ctrl("c"))) this.quit();
  }

  invalidate(): void {}

  private activityLine(width: number, elapsed: string): string {
    const square = this.frame % 2 === 0 ? "■" : "□";
    const content = `${this.theme.bold(this.theme.focus(square))} ${this.theme.bold("Working")}  00:${elapsed}`;
    return padLine(content, width);
  }

  private composerMock(width: number, elapsed: string, thinking: boolean): string[] {
    const safeWidth = Math.max(12, width);
    const inner = safeWidth - 2;
    const activity = thinking ? `  ${this.brailleCluster()}` : "";
    const title = ` ${this.largeBall()} ${this.theme.bold("Working")} 00:${elapsed}${activity} `;
    const titleWidth = visibleWidth(title);
    const top = `${this.theme.focus("╭")}${title}${this.theme.focus("─".repeat(Math.max(0, inner - titleWidth)))}${this.theme.focus("╮")}`;
    const input = padLine(this.theme.muted(" 输入消息"), inner);
    return [
      padLine(top, safeWidth),
      `${this.theme.focus("│")}${input}${this.theme.focus("│")}`,
      this.theme.focus(`╰${"─".repeat(inner)}╯`),
    ];
  }

  private largeBall(): string {
    const value = BALL_FRAMES[this.frame % BALL_FRAMES.length] ?? BALL_FRAMES[0];
    if (value === "○") return this.theme.muted(value);
    if (value === "◉") return this.theme.blue(value);
    return this.theme.bold(this.theme.focus(value));
  }

  private brailleCluster(): string {
    return Array.from({ length: 3 }, (_, offset) => {
      const value = BRAILLE_FRAMES[(this.frame + offset * 2) % BRAILLE_FRAMES.length] ?? BRAILLE_FRAMES[0];
      return offset === 1 ? this.theme.focus(value) : this.theme.blue(value);
    }).join("");
  }
}

const terminal = new ProcessTerminal();
const tui = new TUI(terminal, true);
const theme = createTheme(detectTerminalCapabilities(), "VSPi Dark");
let timer: NodeJS.Timeout | undefined;
let stopped = false;

const stop = () => {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  tui.stop();
};

const mock = new WorkingMock(theme, stop);
tui.addChild(mock);
tui.setFocus(mock);
tui.start();
timer = setInterval(() => {
  mock.tick();
  tui.requestRender();
}, 120);
timer.unref();

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
