import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ProviderAuthEvent, ProviderAuthInteraction, ProviderAuthPrompt } from "../backend/types.js";
import { frame, padLine, wrapTextWithAnsi } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

type PendingPrompt = {
  prompt: ProviderAuthPrompt;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  abort?: () => void;
};

export class AuthDialog implements ProviderAuthInteraction {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private messages: Array<{ text: string; tone: "text" | "muted" | "focus" | "warning" }> = [];
  private pending: PendingPrompt | undefined;
  private input = "";
  private selected = 0;
  private cancelled = false;

  constructor(
    private readonly providerName: string,
    private readonly requestRender: () => void,
    private readonly onCancel: () => void,
  ) {}

  notify(event: ProviderAuthEvent): void {
    if (event.type === "device_code") {
      this.messages = [
        { text: terminalHyperlink(event.verificationUri), tone: "focus" },
        { text: `设备码  ${event.userCode}`, tone: "warning" },
        { text: "请打开链接完成授权；设备码会自动轮询，不需要粘贴回调地址。", tone: "muted" },
        { text: "VSPi 正在等待授权结果…", tone: "muted" },
      ];
    } else if (event.type === "auth_url") {
      this.messages = [
        { text: terminalHyperlink(event.url), tone: "focus" },
        ...(event.instructions ? [{ text: event.instructions, tone: "warning" as const }] : []),
      ];
    } else if (event.type === "info") {
      this.messages.push({ text: event.message, tone: "text" });
      for (const link of event.links ?? []) {
        this.messages.push({ text: link.label ? `${link.label}: ${link.url}` : link.url, tone: "focus" });
      }
    } else {
      this.messages.push({ text: event.message, tone: "muted" });
    }
    this.messages = this.messages.slice(-8);
    this.requestRender();
  }

  prompt(prompt: ProviderAuthPrompt): Promise<string> {
    if (this.cancelled || this.signal.aborted) return Promise.reject(new Error("Login cancelled"));
    this.rejectPending(new Error("Authentication prompt replaced"));
    this.input = "";
    this.selected = 0;
    return new Promise((resolve, reject) => {
      const pending: PendingPrompt = { prompt, resolve, reject };
      if (prompt.signal) {
        const abort = () => {
          if (this.pending === pending) this.rejectPending(new Error("Login cancelled"));
        };
        pending.abort = abort;
        prompt.signal.addEventListener("abort", abort, { once: true });
      }
      this.pending = pending;
      this.requestRender();
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    this.rejectPending(new Error("Login cancelled"));
    this.onCancel();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }
    const prompt = this.pending?.prompt;
    if (!prompt) return;
    if (prompt.type === "select") {
      if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, Key.down)) this.selected = Math.min(prompt.options.length - 1, this.selected + 1);
      else if (matchesKey(data, Key.enter)) {
        const option = prompt.options[this.selected];
        if (option) this.resolvePending(option.id);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) this.input = Array.from(this.input).slice(0, -1).join("");
    else if (matchesKey(data, Key.enter)) {
      if (this.input) this.resolvePending(this.input);
      return;
    } else {
      const rawPrintable = Array.from(data).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      });
      const printable = decodeKittyPrintable(data) ?? (rawPrintable ? data : "");
      if (printable) this.input += printable;
    }
    this.requestRender();
  }

  render(width: number, theme: VspiTheme): string[] {
    const bodyWidth = Math.max(1, width - 4);
    const body: string[] = [];
    for (const message of this.messages) {
      const style =
        message.tone === "focus"
          ? theme.focus
          : message.tone === "warning"
            ? theme.warning
            : message.tone === "muted"
              ? theme.muted
              : theme.text;
      body.push(...wrapTextWithAnsi(style(message.text), bodyWidth));
    }
    const prompt = this.pending?.prompt;
    if (prompt) {
      if (body.length > 0) body.push("");
      body.push(theme.bold(prompt.message));
      if (prompt.type === "select") {
        prompt.options.forEach((option, index) => {
          const row = `${index === this.selected ? theme.focus("› ") : "  "}${option.label}`;
          body.push(index === this.selected ? theme.selected(padLine(row, bodyWidth)) : row);
          if (index === this.selected && option.description) body.push(theme.muted(`    ${option.description}`));
        });
      } else {
        const visible = prompt.type === "secret" ? "•".repeat(Array.from(this.input).length) : this.input;
        const placeholder = !visible && prompt.placeholder ? theme.muted(prompt.placeholder) : visible;
        body.push(theme.selected(padLine(`  ${placeholder}${theme.inverse(" ")}`, bodyWidth)));
      }
    } else if (body.length === 0) {
      body.push(theme.muted("正在准备认证…"));
    }
    body.push("", theme.muted(prompt ? "Enter 确认 · Esc 取消" : "Esc 取消"));
    return frame(body, width, theme, { title: `${this.providerName} · 登录`, focused: true });
  }

  private resolvePending(value: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPromptAbort(pending);
    this.pending = undefined;
    this.input = "";
    pending.resolve(value);
    this.requestRender();
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPromptAbort(pending);
    this.pending = undefined;
    this.input = "";
    pending.reject(error);
    this.requestRender();
  }

  private clearPromptAbort(pending: PendingPrompt): void {
    if (pending.abort && pending.prompt.signal) pending.prompt.signal.removeEventListener("abort", pending.abort);
  }
}

function terminalHyperlink(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return value;
    return `\u001b]8;;${url.href}\u0007${value}\u001b]8;;\u0007`;
  } catch {
    return value;
  }
}
