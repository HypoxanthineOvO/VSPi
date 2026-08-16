import { Input, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ProviderAuthEvent, ProviderAuthInteraction, ProviderAuthPrompt } from "../backend/types.js";
import { isRemoteTerminal } from "../providers/login.js";
import { frame, padLine, wrapTextWithAnsi } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

type PendingPrompt = {
  prompt: ProviderAuthPrompt;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  abort?: () => void;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI-u encodes pasted control bytes with ESC.
const CSI_U_CONTROL = /\u001b\[(\d+);5u/g;

export class AuthDialog implements ProviderAuthInteraction {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private messages: Array<{ text: string; tone: "text" | "muted" | "focus" | "warning" }> = [];
  private pending: PendingPrompt | undefined;
  private input = "";
  private readonly textInput = new Input();
  private pasteBuffer = "";
  private inBracketedPaste = false;
  private selected = 0;
  private cancelled = false;

  constructor(
    private readonly providerName: string,
    private readonly requestRender: () => void,
    private readonly onCancel: () => void,
    private readonly purpose: "登录" | "配置" = "登录",
  ) {}

  notify(event: ProviderAuthEvent): void {
    if (event.type === "device_code") {
      this.messages = [
        { text: terminalHyperlink(event.verificationUri), tone: "focus" },
        { text: `设备码  ${event.userCode}`, tone: "warning" },
        { text: "请在任意设备打开链接完成授权；远程终端会自动轮询，不需要 localhost 回调。", tone: "muted" },
        { text: "VSPi 正在等待授权结果…", tone: "muted" },
      ];
    } else if (event.type === "auth_url") {
      this.messages = [
        { text: terminalHyperlink(event.url), tone: "focus" },
        ...(event.instructions ? [{ text: event.instructions, tone: "warning" as const }] : []),
        ...(isRemoteTerminal()
          ? [
              {
                text: "已检测到 SSH：请在本地浏览器打开链接；若下方出现输入框，可粘贴最终跳转 URL。",
                tone: "muted" as const,
              },
            ]
          : []),
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
    prompt = preferDeviceCodeInRemoteSession(prompt);
    this.resetInput();
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
    const prompt = this.pending?.prompt;
    if (prompt && prompt.type !== "select" && this.handleBracketedPaste(data)) return;
    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }
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
    if (matchesKey(data, Key.enter)) {
      if (this.input) this.resolvePending(this.input);
      return;
    }
    if (this.textInput.getValue() !== this.input) this.textInput.setValue(this.input);
    this.textInput.handleInput(data);
    this.input = this.textInput.getValue();
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
        if (this.textInput.getValue() !== this.input) this.textInput.setValue(this.input);
        const inputValue = this.input;
        const visible =
          prompt.type === "secret"
            ? `${"•".repeat(Array.from(inputValue).length)}${theme.inverse(" ")}`
            : (this.textInput.render(Math.max(1, bodyWidth - 2))[0] ?? "");
        const placeholder = !inputValue && prompt.placeholder ? theme.muted(prompt.placeholder) : visible;
        body.push(theme.selected(padLine(`  ${placeholder}`, bodyWidth)));
      }
    } else if (body.length === 0) {
      body.push(theme.muted(this.purpose === "配置" ? "正在保存配置…" : "正在建立登录…"));
    }
    body.push("", theme.muted(prompt ? "Enter 确认 · Esc 取消" : "Esc 取消"));
    return frame(body, width, theme, { title: `${this.providerName} · ${this.purpose}`, focused: true });
  }

  private resolvePending(value: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPromptAbort(pending);
    this.pending = undefined;
    this.resetInput();
    pending.resolve(value);
    this.requestRender();
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPromptAbort(pending);
    this.pending = undefined;
    this.resetInput();
    pending.reject(error);
    this.requestRender();
  }

  private clearPromptAbort(pending: PendingPrompt): void {
    if (pending.abort && pending.prompt.signal) pending.prompt.signal.removeEventListener("abort", pending.abort);
  }

  private handleBracketedPaste(data: string): boolean {
    const startMarker = "\u001b[200~";
    const endMarker = "\u001b[201~";
    if (data.includes(startMarker)) {
      this.inBracketedPaste = true;
      this.pasteBuffer = "";
      data = data.replace(startMarker, "");
    }
    if (!this.inBracketedPaste) return false;

    this.pasteBuffer += data;
    const endIndex = this.pasteBuffer.indexOf(endMarker);
    if (endIndex < 0) {
      this.requestRender();
      return true;
    }

    const pasted = sanitizeSingleLinePaste(this.pasteBuffer.slice(0, endIndex));
    if (pasted) {
      this.input += pasted;
      this.textInput.setValue(this.input);
    }
    const remaining = this.pasteBuffer.slice(endIndex + endMarker.length);
    this.pasteBuffer = "";
    this.inBracketedPaste = false;
    this.requestRender();
    if (remaining) this.handleInput(remaining);
    return true;
  }

  private resetInput(): void {
    this.input = "";
    this.textInput.setValue("");
    this.pasteBuffer = "";
    this.inBracketedPaste = false;
  }
}

function preferDeviceCodeInRemoteSession(prompt: ProviderAuthPrompt): ProviderAuthPrompt {
  if (!isRemoteTerminal() || prompt.type !== "select") return prompt;
  const deviceIndex = prompt.options.findIndex((option) => /device(?:-|_)?code|headless/iu.test(option.id));
  if (deviceIndex < 0) return prompt;
  const device = prompt.options[deviceIndex];
  if (!device) return prompt;
  const preferred = {
    ...device,
    label: /SSH/iu.test(device.label) ? device.label : `${device.label} · SSH 推荐`,
    description: device.description ?? "可在本地浏览器完成，远程终端自动接收结果",
  };
  return {
    ...prompt,
    options: [preferred, ...prompt.options.filter((_option, index) => index !== deviceIndex)],
  };
}

function sanitizeSingleLinePaste(value: string): string {
  const decoded = value.replace(CSI_U_CONTROL, (match, code: string) => {
    const codePoint = Number(code);
    if (codePoint >= 97 && codePoint <= 122) return String.fromCharCode(codePoint - 96);
    if (codePoint >= 65 && codePoint <= 90) return String.fromCharCode(codePoint - 64);
    return match;
  });
  return Array.from(decoded.replace(/\r\n|\r|\n/g, "").replaceAll("\t", "    "))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
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
