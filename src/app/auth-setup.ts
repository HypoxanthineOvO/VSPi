import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Key,
  matchesKey,
  ProcessTerminal,
  TuiMainScreen as TerminalUi,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AppSettings } from "../domain/types.js";
import { BUILTIN_PROVIDERS } from "../providers/builtins.js";
import {
  createProviderConfigService,
  type ProviderModelRecord,
  type SupportedProviderApi,
} from "../providers/config-service.js";
import { customProviderId, discoverProviderModels, modelsFromManualInput } from "../providers/custom-provider.js";
import { loginProviderWithoutModelNetwork, oauthAvailableInCurrentTerminal } from "../providers/login.js";
import { registerBuiltinProviders } from "../providers/runtime-registration.js";
import { alignRight, frame, padLine, wrapTextWithAnsi } from "../ui/ansi.js";
import { AuthDialog } from "../ui/auth-dialog.js";
import { applySettingsToCapabilities, detectTerminalCapabilities } from "../ui/capabilities.js";
import { createTheme, type VspiTheme } from "../ui/theme.js";

type SetupMode = "login" | "logout";

interface SetupEntry {
  providerId: string;
  providerName: string;
  type: "api_key" | "oauth" | "custom";
  label: string;
  configured: boolean;
}

class AuthSetupApp implements Component, Focusable {
  private entries: SetupEntry[] = [];
  private selected = 0;
  private dialog: AuthDialog | undefined;
  private notice = "";
  private _focused = false;
  private running = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: VspiTheme,
    private readonly runtime: ModelRuntime,
    private readonly providerConfig: ReturnType<typeof createProviderConfigService>,
    private readonly mode: SetupMode,
    private readonly finish: (message?: string) => void,
    private readonly exitAfterAction: boolean,
  ) {}

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  async load(): Promise<void> {
    if (this.mode === "logout") {
      const credentials = await this.runtime.listCredentials();
      this.entries = credentials
        .map((credential) => ({
          providerId: credential.providerId,
          providerName: this.runtime.getProvider(credential.providerId)?.name ?? credential.providerId,
          type: credential.type,
          label: credential.type === "oauth" ? "订阅账号" : "API Key",
          configured: true,
        }))
        .sort(compareEntries);
    } else {
      const credentials = new Map(
        (await this.runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]),
      );
      this.entries = this.runtime
        .getProviders()
        .flatMap((provider): SetupEntry[] => {
          const status = this.runtime.getProviderAuthStatus(provider.id);
          const configuredType =
            credentials.get(provider.id) ??
            (status.configured ? (this.runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key") : undefined);
          return [
            ...(provider.auth.oauth && oauthAvailableInCurrentTerminal(provider.id)
              ? [
                  {
                    providerId: provider.id,
                    providerName: provider.name,
                    type: "oauth" as const,
                    label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
                    configured: configuredType === "oauth",
                  },
                ]
              : []),
            ...(provider.auth.apiKey?.login
              ? [
                  {
                    providerId: provider.id,
                    providerName: provider.name,
                    type: "api_key" as const,
                    label: provider.auth.apiKey.name,
                    configured: configuredType === "api_key",
                  },
                ]
              : []),
          ];
        })
        .concat({
          providerId: "custom",
          providerName: "自定义中转站",
          type: "custom",
          label: "名称 ⋅ Base URL ⋅ API Key ⋅ 类型",
          configured: false,
        })
        .sort(compareEntries);
    }
    this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
    this.tui.requestRender();
  }

  async startInitial(providerRef?: string): Promise<void> {
    if (!providerRef) return;
    const normalized = providerRef.toLowerCase();
    const matches = this.entries.filter(
      (entry) => entry.providerId.toLowerCase() === normalized || entry.providerName.toLowerCase() === normalized,
    );
    const entry = matches.find((candidate) => candidate.type === "oauth") ?? matches[0];
    if (!entry) {
      this.notice = `未找到可配置的 Provider：${providerRef}`;
      this.tui.requestRender();
      return;
    }
    this.selected = this.entries.indexOf(entry);
    await this.activate(entry);
  }

  handleInput(data: string): void {
    if (this.dialog) {
      this.dialog.handleInput(data);
      return;
    }
    if (this.running) return;
    if (matchesKey(data, Key.escape)) {
      this.finish();
      return;
    }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.entries.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter)) {
      const entry = this.entries[this.selected];
      if (entry) void this.activate(entry);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.dialog) return this.dialog.render(width, this.theme);
    const bodyWidth = Math.max(1, width - 4);
    const maxRows = Math.max(3, (this.tui.terminal.rows ?? 24) - 5);
    if (this.entries.length === 0) {
      return frame(
        [this.theme.muted(this.mode === "logout" ? "没有已保存的凭据" : "没有可交互的认证方式")],
        width,
        this.theme,
        {
          title: this.mode === "logout" ? "移除凭据" : "VSPi Init",
          focused: true,
        },
      );
    }
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), this.entries.length - maxRows));
    const rows = this.entries.slice(start, start + maxRows).map((entry, offset) => {
      const selected = start + offset === this.selected;
      const status = entry.configured ? this.theme.success("已配置") : this.theme.muted("未配置");
      const line = alignRight(
        `${selected ? this.theme.focus("› ") : "  "}${entry.providerName} ⋅ ${entry.label}`,
        status,
        bodyWidth,
      );
      return selected ? this.theme.selected(padLine(line, bodyWidth)) : line;
    });
    if (this.notice) rows.push("", ...wrapTextWithAnsi(this.theme.warning(this.notice), bodyWidth));
    rows.push("", this.theme.muted("▴▾ 选择 ⋅ Enter 确认 ⋅ Esc 退出"));
    return frame(rows, width, this.theme, {
      title: this.mode === "logout" ? "移除凭据" : "VSPi Init ⋅ Provider 登录",
      focused: true,
    });
  }

  invalidate(): void {}

  private async activate(entry: SetupEntry): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.notice = "";
    if (this.mode === "logout") {
      try {
        await this.runtime.logout(entry.providerId);
        if (this.exitAfterAction) {
          this.finish(`${entry.providerName} 的已保存凭据已移除`);
          return;
        }
        this.notice = `${entry.providerName} 的已保存凭据已移除`;
        await this.load();
      } catch (error) {
        this.notice = `移除失败：${error instanceof Error ? error.message : "未知错误"}`;
      } finally {
        this.running = false;
        this.tui.requestRender();
      }
      return;
    }

    let cancelled = false;
    const dialog = new AuthDialog(
      entry.providerName,
      () => this.tui.requestRender(),
      () => {
        cancelled = true;
        if (this.dialog === dialog) this.dialog = undefined;
        this.running = false;
        if (this.exitAfterAction) this.finish();
        else this.tui.requestRender();
      },
      entry.type === "oauth" ? "登录" : "配置",
    );
    this.dialog = dialog;
    this.tui.requestRender();
    try {
      if (entry.type === "custom") {
        const result = await this.configureCustomProvider(dialog);
        if (cancelled || dialog.signal.aborted) return;
        this.dialog = undefined;
        const message = `${result.name} 已添加，发现 ${result.modelCount} 个模型，API Key 已保存`;
        if (this.exitAfterAction) {
          this.finish(message);
          return;
        }
        this.notice = message;
        await this.load();
        return;
      }
      dialog.notify({
        type: "progress",
        message: entry.type === "oauth" ? "正在启动账号登录..." : "正在保存 API Key...",
      });
      await loginProviderWithoutModelNetwork(this.runtime, entry.providerId, entry.type, dialog);
      if (cancelled || dialog.signal.aborted) return;
      this.dialog = undefined;
      if (this.exitAfterAction) {
        this.finish(
          entry.type === "oauth" ? `${entry.providerName} 账号已连接` : `${entry.providerName} API Key 已保存`,
        );
        return;
      }
      this.notice =
        entry.type === "oauth" ? `${entry.providerName} 账号已连接` : `${entry.providerName} API Key 已保存`;
      await this.load();
    } catch (error) {
      if (cancelled || dialog.signal.aborted) return;
      this.dialog = undefined;
      this.notice = `登录失败：${error instanceof Error ? error.message : "未知错误"}`;
    } finally {
      this.running = false;
      this.tui.requestRender();
    }
  }

  private async configureCustomProvider(dialog: AuthDialog): Promise<{ name: string; modelCount: number }> {
    const name = (
      await dialog.prompt({
        type: "text",
        message: "中转站名称",
        placeholder: "例如 My Gateway",
        signal: dialog.signal,
      })
    ).trim();
    const baseUrl = (
      await dialog.prompt({
        type: "text",
        message: "Base URL",
        placeholder: "https://gateway.example.com/v1",
        signal: dialog.signal,
      })
    ).trim();
    const protocol = (await dialog.prompt({
      type: "select",
      message: "接口类型",
      options: [
        { id: "openai-responses", label: "OpenAI Responses", description: "Responses API 中转站" },
        { id: "openai-completions", label: "OpenAI Compatible", description: "Chat Completions 兼容接口" },
        { id: "anthropic-messages", label: "Anthropic Messages", description: "Anthropic Messages 兼容接口" },
        { id: "google-generative-ai", label: "Google Generative AI", description: "Gemini generateContent 兼容接口" },
      ],
      signal: dialog.signal,
    })) as SupportedProviderApi;
    let apiKey = await dialog.prompt({
      type: "secret",
      message: "API Key",
      placeholder: "仅保存到 Pi auth.json",
      signal: dialog.signal,
    });
    if (!name || !baseUrl || !apiKey) throw new Error("名称、Base URL 和 API Key 都不能为空");
    try {
      dialog.notify({ type: "progress", message: "正在读取模型列表（最多 5 秒）..." });
      let models: ProviderModelRecord[];
      try {
        models = await discoverProviderModels({ name, baseUrl, protocol, apiKey }, { signal: dialog.signal });
      } catch (error) {
        dialog.notify({
          type: "info",
          message: `未能自动读取模型列表：${error instanceof Error ? error.message : "未知错误"}`,
        });
        const manual = await dialog.prompt({
          type: "text",
          message: "请输入至少一个模型 ID，多个可用逗号分隔",
          placeholder: "model-id",
          signal: dialog.signal,
        });
        models = modelsFromManualInput(manual);
      }
      if (models.length === 0) throw new Error("自定义 Provider 至少需要一个模型 ID");

      const providerId = customProviderId(name, baseUrl);
      await this.providerConfig.saveGlobalProvider(providerId, { name, baseUrl, protocol, models });
      await this.runtime.refresh({ allowNetwork: false, signal: dialog.signal });
      await loginProviderWithoutModelNetwork(this.runtime, providerId, "api_key", {
        signal: dialog.signal,
        notify: (event) => dialog.notify(event),
        prompt: async (prompt) => (prompt.type === "secret" ? apiKey : dialog.prompt(prompt)),
      });
      return { name, modelCount: models.length };
    } finally {
      apiKey = "";
    }
  }
}

function compareEntries(left: SetupEntry, right: SetupEntry): number {
  const priority = [
    "vsplab",
    "custom",
    "kimi-coding",
    "openai-codex",
    "anthropic",
    "deepseek",
    "minimax",
    "minimax-cn",
    "qwen-token-plan",
    "qwen-token-plan-cn",
    "xiaomi",
    "zai",
    "zai-coding-cn",
  ];
  const leftPriority = priority.indexOf(left.providerId);
  const rightPriority = priority.indexOf(right.providerId);
  const priorityDifference =
    (leftPriority < 0 ? priority.length : leftPriority) - (rightPriority < 0 ? priority.length : rightPriority);
  return priorityDifference || left.providerName.localeCompare(right.providerName) || (left.type === "oauth" ? -1 : 1);
}

export async function runAuthSetup(options: {
  mode: SetupMode;
  providerRef?: string;
  settings: AppSettings;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("vspi init/login/logout 需要交互式 TTY");
  const terminal = new ProcessTerminal();
  const tui = new TerminalUi(terminal, true);
  const capabilities = applySettingsToCapabilities(detectTerminalCapabilities(), options.settings);
  const theme = createTheme(capabilities, options.settings.theme);
  const runtime = await ModelRuntime.create();
  registerBuiltinProviders(runtime, BUILTIN_PROVIDERS);
  const providerConfig = createProviderConfigService({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    trustedProject: false,
    builtins: BUILTIN_PROVIDERS,
  });
  let complete: ((message?: string) => void) | undefined;
  let resultMessage = "";
  const finished = new Promise<void>((resolve) => {
    complete = (message) => {
      resultMessage = message ?? "";
      resolve();
    };
  });
  const app = new AuthSetupApp(
    tui,
    theme,
    runtime,
    providerConfig,
    options.mode,
    (message) => complete?.(message),
    options.providerRef !== undefined,
  );
  await app.load();
  tui.addChild(app);
  tui.setFocus(app);
  terminal.setTitle("VSPi Setup");
  tui.start();
  try {
    await app.startInitial(options.providerRef);
    await finished;
  } finally {
    tui.stop();
    await terminal.drainInput();
  }
  if (resultMessage) process.stdout.write(`${resultMessage}\n`);
}
