import type { Klient } from '@moonshot-ai/klient';
import type { RuntimeConnection } from '@vsp/vsp-runtime';
import { ProcessTerminal, TuiMainScreen, type Component, type Focusable, type TUI } from '@moonshot-ai/pi-tui';
import { formatProviderDisplayName } from '../backend/klient-backend.js';
import type { ProviderAuthInteraction } from '../backend/types.js';
import type { AppSettings, ProviderOption } from '../domain/types.js';
import { loginProvider } from '../providers/provider-login.js';
import { configureProxy } from '../providers/proxy-setup.js';
import { catalogEffortCapability, effortLabel } from '../domain/effort.js';
import { frame, wrapTextWithAnsi } from '../ui/ansi.js';
import { ProviderManagerController, type ProviderManagerAction } from '../ui/provider-manager.js';
import { AuthDialog } from '../ui/auth-dialog.js';
import { applySettingsToCapabilities, detectTerminalCapabilities } from '../ui/capabilities.js';
import { createTheme, type VspiTheme } from '../ui/theme.js';
import { checkProvider, loadProviderOptions, saveProviderGateway } from '../providers/provider-management.js';

export type AuthSetupMode = 'config' | 'login' | 'logout' | 'proxy';
type CredentialType = 'api_key' | 'oauth';

export interface AuthSetupOptions {
  mode: AuthSetupMode;
  providerRef?: string;
  settings: AppSettings;
  connection: RuntimeConnection;
  stdinIsTTY?: () => boolean;
  stdoutIsTTY?: () => boolean;
}

export async function runAuthSetup(options: AuthSetupOptions): Promise<void> {
  if (!(options.stdinIsTTY?.() ?? process.stdin.isTTY) || !(options.stdoutIsTTY?.() ?? process.stdout.isTTY)) throw new Error('vspi config/login/logout/proxy 需要交互式 TTY');
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, true);
  const theme = createTheme(applySettingsToCapabilities(detectTerminalCapabilities(), options.settings), options.settings.theme);
  let complete!: () => void;
  let result = '';
  const finished = new Promise<void>(resolve => { complete = resolve; });
  const app = new AuthSetupApp(tui, theme, options.connection.klient, options.mode, message => { result = message ?? ''; complete(); }, options.providerRef !== undefined);
  await app.load();
  tui.addChild(app);
  tui.setFocus(app);
  terminal.setTitle('VSPi Setup');
  tui.start();
  try { await app.startInitial(options.providerRef); await finished; }
  finally { tui.stop(); await terminal.drainInput(); }
  if (result) process.stdout.write(`${result}\n`);
}

export class AuthSetupApp implements Component, Focusable {
  focused = false;
  private readonly manager: ProviderManagerController;
  private providers: ProviderOption[] = [];
  private dialog?: AuthDialog;
  private running = false;
  private notice = '';

  constructor(private readonly tui: TUI, private readonly theme: VspiTheme, private readonly klient: Klient,
    private readonly mode: AuthSetupMode, private readonly finish: (message?: string) => void, private readonly exitAfterAction: boolean) {
    this.manager = new ProviderManagerController(mode !== 'logout');
  }

  async load(): Promise<void> {
    if (this.mode === 'proxy') return;
    this.providers = await loadProviderOptions(this.klient, formatProviderDisplayName);
    if (this.mode === 'logout') this.providers = this.providers.filter(provider => provider.storedCredential).map(provider => ({ ...provider, label: `${provider.label} · ${provider.storedCredential === 'api_key' ? 'API Key' : '订阅账号'}` }));
    this.manager.setProviders(this.providers);
    this.tui.requestRender();
  }

  async startInitial(providerRef?: string): Promise<void> {
    if (this.mode === 'proxy') {
      const dialog = this.makeDialog('代理');
      try { await configureProxy(this.klient, dialog); if (!dialog.signal.aborted) this.finish('代理配置已保存。'); }
      finally { this.dialog = undefined; }
      return;
    }
    if (!providerRef) return;
    const provider = this.providers.find(item => [item.id, item.label].some(value => value.toLowerCase() === providerRef.toLowerCase()));
    if (!provider) throw new Error(`未找到可配置的 Provider：${providerRef}`);
    await this.perform(this.mode === 'logout' ? { type: 'remove', provider } : { type: 'login', provider, credential: provider.authMethods?.some(method => method.type === 'oauth') ? 'oauth' : 'api_key' });
  }

  handleInput(data: string): void {
    if (this.dialog) { this.dialog.handleInput(data); return; }
    if (this.running) return;
    const action = this.manager.handleInput(data);
    if (action) void this.perform(action);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.dialog) return this.dialog.render(width, this.theme);
    const rows = this.manager.render(Math.max(1, width - 4), Math.max(1, this.tui.terminal.rows - 4 - Number(Boolean(this.notice)) * 2), this.theme);
    if (this.notice) rows.push(...wrapTextWithAnsi(this.theme.warning(this.notice), Math.max(1, width - 4)));
    return frame(rows, width, this.theme, { title: this.mode === 'logout' ? '移除凭据' : 'VSPi Config · 管理连接', focused: true, paddingX: 1 });
  }

  invalidate(): void {}

  private makeDialog(name: string): AuthDialog {
    const dialog = new AuthDialog(name, () => this.tui.requestRender(), () => { if (this.exitAfterAction) this.finish(); }, '配置');
    this.dialog = dialog;
    return dialog;
  }

  private async perform(action: ProviderManagerAction): Promise<void> {
    if (action.type === 'close') { this.finish(); return; }
    this.running = true;
    this.notice = '';
    try {
      if (action.type === 'save') {
        await saveProviderGateway(this.klient, action.value, action.provider);
        this.manager.finishSave();
        this.notice = 'Provider 已测试并原子保存';
      } else if (action.type === 'test') {
        const result = await checkProvider(this.klient, action.provider.id);
        this.manager.recordCheck(action.provider.id, result.diagnostic);
        this.notice = result.diagnostic;
      } else if (action.type === 'remove') {
        await logoutProvider(this.klient, action.provider.id, action.provider.storedCredential ?? 'api_key');
        this.notice = '已保存凭据已移除；外部 CLI 凭据未修改';
      } else {
        const dialog = this.makeDialog(action.provider.label);
        if (action.type === 'local') {
          if (!action.provider.localCredential) throw new Error('本机凭据已失效');
          await this.klient.global.auth.useLocalCredential(action.provider.localCredential.id, dialog.signal);
        } else if (action.type === 'login') await loginProvider(this.klient, action.provider.id, action.credential, dialog);
        dialog.signal.throwIfAborted();
        if (this.mode === 'config') await configureDefaultModel(this.klient, action.provider.id, dialog);
        this.notice = 'Provider 已连接';
      }
      await this.load();
      if (this.exitAfterAction) this.finish(this.notice);
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败';
      if (action.type === 'save') this.manager.finishSave(message);
      else this.notice = message;
    } finally {
      this.dialog = undefined;
      this.running = false;
      this.tui.requestRender();
    }
  }
}

export async function configureDefaultModel(klient: Klient, providerId: string, interaction: ProviderAuthInteraction): Promise<void> {
  const [catalog, providers] = await Promise.all([klient.global.kosong.listModels(), klient.global.kosong.listProviders()]);
  const models = catalog.filter(model => model.provider === providerId);
  const provider = providers.find(item => item.id === providerId);
  if (!models.length) throw new Error('Provider 已登录，但没有可选择的模型，请检查配置');
  const modelId = await interaction.prompt({ type: 'select', message: '默认模型', options: models.map(model => ({ id: model.model, label: model.display_name ?? model.model })), signal: interaction.signal });
  const model = models.find(item => item.model === modelId);
  if (!model) throw new Error('模型选择无效');
  const capability = catalogEffortCapability({ ...model.thinking, efforts: model.support_efforts ?? model.thinking.efforts, default_effort: model.default_effort ?? model.thinking.default_effort }, { type: provider?.type, identity: providerId });
  const order = ['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max'];
  const descriptions: Record<string, string> = { low: '快速响应，适合简单任务', medium: '均衡速度与推理深度', high: '深入推理，适合复杂任务', max: '最高推理预算，响应较慢' };
  const efforts = capability.options.filter(effort => effort !== 'off');
  const effort = efforts.length > 1 ? await interaction.prompt({ type: 'select', message: '默认 Effort', options: efforts.toSorted((a, b) => order.indexOf(a) - order.indexOf(b)).map(id => ({ id, label: `${effortLabel(id)}${descriptions[id] ? ` · ${descriptions[id]}` : ''}` })), signal: interaction.signal }) : efforts[0] ?? 'off';
  if (efforts.length > 0 && !efforts.some(option => option === effort)) throw new Error('Effort 选择无效');
  interaction.signal?.throwIfAborted();
  const thinking = await klient.global.config.inspect<Record<string, unknown> & { modelEfforts?: Record<string, string> }>('thinking');
  await klient.global.config.replaceSections({ sections: { defaultModel: modelId, thinking: { ...thinking.userValue, enabled: effort !== 'off', effort: effort === 'off' || effort === 'on' ? undefined : effort, modelEfforts: { ...thinking.userValue?.modelEfforts, [modelId]: effort } } } });
}

export { loginProvider } from '../providers/provider-login.js';

async function logoutProvider(klient: Klient, providerId: string, type: CredentialType): Promise<void> {
  if (type === 'oauth') { await klient.global.auth.logout(providerId); return; }
  const inspection = await klient.global.config.inspect<Record<string, Record<string, unknown>>>('providers');
  const current = inspection.userValue?.[providerId];
  if (!current) throw new Error(`Provider ${providerId} 不存在`);
  await klient.global.config.replace({ domain: 'providers', value: { ...inspection.userValue, [providerId]: { ...current, apiKey: undefined, apiKeyEnv: undefined } } });
}
