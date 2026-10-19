import { Input, Key, matchesKey } from '@moonshot-ai/pi-tui';
import type { ProviderOption } from '../domain/types.js';
import { sourceHealthLabel } from '../domain/canonical-models.js';
import { padLine, truncateToWidth } from './ansi.js';
import type { VspiTheme } from './theme.js';

export const PROVIDER_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI Chat Completions' },
  { id: 'openai_responses', label: 'OpenAI Responses' },
  { id: 'anthropic', label: 'Anthropic Messages' },
  { id: 'google-genai', label: 'Google Generative AI' },
] as const;

export function providerProtocolLabel(protocol: string): string {
  return PROVIDER_PROTOCOLS.find(item => item.id === protocol)?.label ?? protocol;
}

export interface ProviderManagerDetail {
  authLabel?: string;
  account?: string;
  expiresAt?: string;
  lastCheck?: string;
  defaultModel?: string;
  models?: readonly string[];
}

export interface ProviderManagerState {
  selected: number;
  query: string;
  searching: boolean;
  detail: boolean;
  modelFocus: boolean;
  modelOffset: number;
  showCustom?: boolean;
}

export function renderProviderManager(
  providers: readonly ProviderOption[],
  state: ProviderManagerState,
  width: number,
  height: number,
  theme: VspiTheme,
  details: ReadonlyMap<string, ProviderManagerDetail> = new Map(),
): string[] {
  const narrow = width < 96;
  const selected = providers[state.selected];
  const detail = selected ? details.get(selected.id) ?? {
    models: selected.models, account: selected.localCredential?.account, expiresAt: selected.localCredential?.expiresAt,
  } : undefined;
  const search = `${theme.muted('/ 搜索 Provider  ')}${state.query || theme.muted('输入名称筛选')}${state.searching ? theme.inverse(' ') : ''}`;
  const available = Math.max(1, height - 3 - Number(providers.some(provider => provider.localCredential)));
  const leftWidth = narrow ? width : Math.min(40, Math.floor(width * 0.38));
  const row = (text: string, active = false): string => {
    const value = padLine(truncateToWidth(`${active ? '› ' : '  '}${text}`, leftWidth), leftWidth);
    return active ? theme.selected(value) : value;
  };
  const list: string[] = [];
  let selectedRow = 0;
  for (const connected of [true, false]) {
    const entries = providers.map((provider, index) => ({ provider, index }))
      .filter(({ provider }) => (provider.status !== '未配置') === connected);
    if (!entries.length) continue;
    list.push(theme.bold(theme.muted(`  ${connected ? '已连接' : '可添加'} · ${entries.length}`)));
    for (const { provider, index } of entries) {
      if (index === state.selected) selectedRow = list.length;
      const status = provider.status === '已配置' || provider.status === '已验证'
        ? theme.success('✓ 可用') : provider.status === '未配置' ? '' : theme.warning(`⚠ ${provider.status}`);
      const count = details.get(provider.id)?.models?.length ?? provider.models?.length;
      list.push(row(`${provider.label}  ${status}${connected && count !== undefined ? theme.muted(`  ${count}`) : ''}`, index === state.selected));
    }
    list.push('');
  }
  if (state.showCustom !== false) {
    list.push(row('+ 添加自定义中转站', state.selected === providers.length));
    if (state.selected === providers.length) selectedRow = list.length - 1;
  }
  const start = Math.max(0, Math.min(selectedRow - Math.floor(available / 2), list.length - available));
  const visible = list.slice(start, start + available);
  const rightWidth = narrow ? width : width - leftWidth - 3;
  const detailRows: string[] = [];
  if (selected) {
    const field = (label: string, value: string) => `${padLine(theme.muted(label), 12)}${value}`;
    const latest = selected.modelHealth;
    const checkedAt = latest ? Math.max(latest.health.lastSuccess ?? 0, latest.health.lastFailure?.at ?? 0) : 0;
    detailRows.push(theme.bold(theme.focus(selected.label)), '', theme.bold('认证与连接'),
      field('认证方式', detail?.authLabel ?? (selected.storedCredential === 'oauth' ? '订阅账号' : selected.storedCredential === 'api_key' ? 'API Key' : '未连接')),
      field('账号', detail?.account ?? '未提供'),
      field('凭据到期', detail?.expiresAt ?? '未提供'), '',
      field('Endpoint', selected.baseUrl ?? '由 Provider 管理'),
      field('协议', providerProtocolLabel(selected.protocol)),
      field('上次检查', latest && checkedAt > 0 ? sourceHealthLabel(latest) : '尚未测试'),
      ...latest && checkedAt > 0 ? [field('模型请求', latest.model), field('检查时间', new Date(checkedAt).toLocaleString())] : [],
      ...detail?.lastCheck ? [field('配置检查', detail.lastCheck)] : [], '',
      field('默认模型', detail?.defaultModel ?? '未设置'), '',
      theme.bold(`${state.modelFocus ? '› ' : ''}模型 · ${detail?.models?.length ?? 0}`));
    const modelRows = Math.max(1, available - detailRows.length - 1);
    detailRows.push(...(detail?.models ?? []).slice(state.modelOffset, state.modelOffset + modelRows)
      .map(model => `  ${model}`));
    if ((detail?.models?.length ?? 0) > state.modelOffset + modelRows) detailRows.push(theme.muted('↓ 更多模型 · Tab 聚焦后 ↑↓ 滚动'));
  } else detailRows.push(theme.focus('添加自定义中转站'), '', '为兼容 API 的网关配置名称、Endpoint、协议与凭据。');
  const body = narrow
    ? state.detail ? detailRows.slice(0, available) : visible
    : Array.from({ length: available }, (_, index) => `${padLine(visible[index] ?? '', leftWidth)} ${theme.border('│')} ${padLine(truncateToWidth(detailRows[index] ?? '', rightWidth), rightWidth)}`);
  const local = providers.filter(provider => provider.localCredential);
  const banner = local.length ? theme.success(`检测到本机凭据 · ${local.map(provider => provider.localCredential!.name).join(' / ')} · R 一键复用，无需复制 Token`) : '';
  return [truncateToWidth(banner || search, width), ...(banner ? [truncateToWidth(search, width)] : []), ...body.map(line => truncateToWidth(line, width)), '',
    truncateToWidth(theme.muted(narrow ? '↑↓选择 L登录 T测试 E编辑 D移除 /搜索 Tab模型 Enter详情 Esc返回' : '↑↓ 选择  L 登录/切换方式  T 测试  E 编辑  D 移除  / 搜索  Tab 模型  Enter 详情  Esc 返回'), width)].slice(0, height);
}

export type ProviderManagerAction =
  | { type: 'login'; provider: ProviderOption; credential: 'api_key' | 'oauth' }
  | { type: 'local' | 'test' | 'remove'; provider: ProviderOption }
  | { type: 'save'; provider?: ProviderOption; value: GatewayFormValue }
  | { type: 'close' };

export class ProviderManagerController {
  readonly state: ProviderManagerState = { selected: 0, query: '', searching: false, detail: false, modelFocus: false, modelOffset: 0 };
  private providers: ProviderOption[] = [];
  private readonly search = new Input();
  private menu?: { label: string; action: ProviderManagerAction }[];
  private menuSelected = 0;
  private form?: ProviderGatewayForm;
  private pending?: ProviderManagerAction;
  private readonly checks = new Map<string, string>();

  constructor(showCustom = true) { this.state.showCustom = showCustom; }

  setProviders(providers: readonly ProviderOption[]): void {
    const selected = this.visible()[this.state.selected]?.id;
    this.providers = [...providers].sort((a, b) => Number(b.status !== '未配置') - Number(a.status !== '未配置'));
    const index = this.visible().findIndex(provider => provider.id === selected);
    this.state.selected = index < 0 ? Math.min(this.state.selected, Math.max(0, this.visible().length - 1)) : index;
  }

  selectProvider(id: string): void {
    this.state.query = ''; this.search.setValue(''); this.state.searching = false;
    this.state.selected = Math.max(0, this.providers.findIndex(provider => provider.id === id));
    this.state.modelOffset = 0;
  }

  private visible(): ProviderOption[] {
    const query = this.state.query.trim().toLowerCase();
    return this.providers.filter(provider => `${provider.id} ${provider.label}`.toLowerCase().includes(query));
  }

  recordCheck(id: string, diagnostic: string): void { this.checks.set(id, diagnostic); }
  finishSave(error?: string): void { if (error) this.form?.setError(error); else this.form = undefined; }

  handleInput(data: string): ProviderManagerAction | undefined {
    if (this.form) { this.form.handleInput(data); const action = this.pending; this.pending = undefined; return action; }
    if (matchesKey(data, Key.escape)) {
      if (this.menu) this.menu = undefined;
      else if (this.state.searching) this.state.searching = false;
      else if (this.state.modelFocus) this.state.modelFocus = false;
      else if (this.state.detail) this.state.detail = false;
      else if (this.state.query) { this.state.query = ''; this.search.setValue(''); this.state.selected = 0; }
      else return { type: 'close' };
      return;
    }
    if (this.menu) {
      if (matchesKey(data, Key.up)) this.menuSelected = Math.max(0, this.menuSelected - 1);
      else if (matchesKey(data, Key.down)) this.menuSelected = Math.min(this.menu.length - 1, this.menuSelected + 1);
      else if (matchesKey(data, Key.enter)) { const action = this.menu[this.menuSelected]?.action; this.menu = undefined; return action; }
      return;
    }
    if (this.state.searching) {
      if (matchesKey(data, Key.enter)) this.state.searching = false;
      else { this.search.handleInput(data); this.state.query = this.search.getValue(); this.state.selected = 0; this.state.modelOffset = 0; }
      return;
    }
    if (data === '/') { this.state.searching = true; return; }
    if (matchesKey(data, Key.tab)) { this.state.modelFocus = !this.state.modelFocus; this.state.detail = true; return; }
    const providers = this.visible();
    const provider = providers[this.state.selected];
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      if (this.state.modelFocus) this.state.modelOffset = Math.max(0, Math.min((provider?.models?.length ?? 1) - 1, this.state.modelOffset + delta));
      else { this.state.selected = Math.max(0, Math.min(providers.length - Number(this.state.showCustom === false), this.state.selected + delta)); this.state.modelOffset = 0; }
      return;
    }
    if (!provider) {
      if (this.state.showCustom !== false && (matchesKey(data, Key.enter) || /^[eElL]$/.test(data))) this.edit();
      return;
    }
    if (matchesKey(data, Key.enter)) { this.state.detail = true; return; }
    if (/^[eE]$/.test(data)) { this.edit(provider); return; }
    if (/^[tT]$/.test(data)) return { type: 'test', provider };
    if (/^[rR]$/.test(data) && provider.localCredential) return { type: 'local', provider };
    if (/^[dD]$/.test(data) && provider.storedCredential) {
      this.menu = [{ label: `确认移除 ${provider.label} 的凭据（不删除外部 CLI 文件）`, action: { type: 'remove', provider } }];
      this.menuSelected = 0;
    }
    if (/^[lL]$/.test(data)) {
      this.menu = (provider.authMethods ?? [{ type: 'api_key' as const, label: 'API Key' }]).map(method => ({ label: method.label, action: { type: 'login', provider, credential: method.type } }));
      this.menuSelected = 0;
      if (this.menu.length === 1) { const action = this.menu[0]!.action; this.menu = undefined; return action; }
    }
  }

  private edit(provider?: ProviderOption): void {
    this.form = new ProviderGatewayForm(value => {
      this.form?.setBusy(true);
      this.pending = { type: 'save', provider, value };
    }, () => { this.form = undefined; }, provider ? { name: provider.label, baseUrl: provider.baseUrl, protocol: provider.protocol } : undefined);
  }

  render(width: number, height: number, theme: VspiTheme): string[] {
    if (this.form) return this.form.render(width, theme);
    if (this.menu) return [theme.bold('Provider 操作'), '', ...this.menu.map((item, index) => index === this.menuSelected ? theme.selected(`› ${item.label}`) : `  ${item.label}`), '', theme.muted('↑↓ 选择 · Enter 确认 · Esc 返回')].map(line => truncateToWidth(line, width));
    return renderProviderManager(this.visible(), this.state, width, height, theme, new Map(this.providers.map(provider => [provider.id, {
      models: provider.models, account: provider.localCredential?.account, expiresAt: provider.localCredential?.expiresAt,
      authLabel: provider.authLabel, defaultModel: provider.defaultModel, lastCheck: this.checks.get(provider.id),
    }])));
  }
}

export interface GatewayFormValue {
  name: string;
  baseUrl: string;
  protocol: string;
  apiKey: string;
}

export class ProviderGatewayForm {
  private readonly inputs = [new Input(), new Input(), new Input()];
  private field = 0;
  private protocolIndex = 0;
  private error = '';
  private busy = false;

  constructor(
    private readonly submit: (value: GatewayFormValue) => void,
    private readonly cancel: () => void,
    initial?: Partial<GatewayFormValue>,
  ) {
    this.inputs[0]!.setValue(initial?.name ?? '');
    this.inputs[1]!.setValue(initial?.baseUrl ?? '');
    this.inputs[2]!.setValue(initial?.apiKey ?? '');
    this.protocolIndex = Math.max(0, PROVIDER_PROTOCOLS.findIndex(item => item.id === initial?.protocol));
  }

  setBusy(value: boolean): void { this.busy = value; }
  setError(value: string): void { this.error = value; this.busy = false; }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { if (!this.busy) this.cancel(); return; }
    if (this.busy) return;
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) this.field = (this.field + 1) % 5;
    else if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.up)) this.field = (this.field + 4) % 5;
    else if (this.field === 2 && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      this.protocolIndex = (this.protocolIndex + (matchesKey(data, Key.left) ? PROVIDER_PROTOCOLS.length - 1 : 1)) % PROVIDER_PROTOCOLS.length;
    } else if (matchesKey(data, Key.ctrl('s')) || (this.field === 4 && matchesKey(data, Key.enter))) {
      const name = this.inputs[0]!.getValue().trim();
      const baseUrl = this.inputs[1]!.getValue().trim();
      const apiKey = this.inputs[2]!.getValue();
      if (!name || !baseUrl) { this.error = '名称和 Base URL 不能为空'; return; }
      try {
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      } catch { this.error = '请输入有效的 HTTP(S) Base URL，不包含账号、密码、查询或片段'; return; }
      this.error = '';
      this.submit({ name, baseUrl, protocol: PROVIDER_PROTOCOLS[this.protocolIndex]!.id, apiKey });
    } else if (matchesKey(data, Key.enter)) this.field = (this.field + 1) % 5;
    else {
      const input = this.inputs[this.field === 3 ? 2 : this.field];
      if (this.field !== 2 && this.field !== 4) input?.handleInput(data);
    }
  }

  render(width: number, theme: VspiTheme): string[] {
    const labels = ['名称', 'Base URL', '协议', 'API Key'];
    const values = [this.inputs[0]!.getValue(), this.inputs[1]!.getValue(), PROVIDER_PROTOCOLS[this.protocolIndex]!.label, '•'.repeat(Math.min(32, this.inputs[2]!.getValue().length))];
    return [theme.bold(theme.focus('自定义中转站')), '',
      ...labels.flatMap((label, index) => [theme.muted(label),
        padLine(truncateToWidth(`${index === this.field ? '› ' : '  '}${values[index] || theme.muted(index === 3 ? '留空保留现有凭据' : index === 1 ? 'https://gateway.example.com/v1' : '请输入')}${index === this.field ? theme.inverse(' ') : ''}${index === 2 ? theme.muted('  ← → 选择') : ''}`, width), width), '']),
      this.busy ? theme.muted('正在测试并保存…') : this.field === 4 ? theme.selected('› 测试并保存') : '  测试并保存',
      ...(this.error ? [theme.warning(truncateToWidth(this.error, width))] : []), '',
      truncateToWidth(theme.muted('Tab / Shift-Tab 切换字段 · Ctrl+S 测试并保存 · Esc 取消'), width)];
  }
}
