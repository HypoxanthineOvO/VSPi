import { Input, Key, matchesKey } from '@moonshot-ai/pi-tui';
import type { ProviderOption } from '../domain/types.js';
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
    detailRows.push(theme.bold(theme.focus(selected.label)), '', theme.bold('认证与连接'),
      field('认证方式', detail?.authLabel ?? (selected.storedCredential === 'oauth' ? '订阅账号' : selected.storedCredential === 'api_key' ? 'API Key' : '未连接')),
      field('账号', detail?.account ?? '未提供'),
      field('凭据到期', detail?.expiresAt ?? '未提供'), '',
      field('Endpoint', selected.baseUrl ?? '由 Provider 管理'),
      field('协议', providerProtocolLabel(selected.protocol)),
      field('上次检查', detail?.lastCheck ?? '尚未测试'), '',
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
  const banner = local.length ? theme.success(`检测到本机凭据 · ${local.map(provider => provider.localCredential!.name).join(' / ')} · L 复用，无需复制 Token`) : '';
  return [truncateToWidth(banner || search, width), ...(banner ? [truncateToWidth(search, width)] : []), ...body.map(line => truncateToWidth(line, width)), '',
    truncateToWidth(theme.muted(narrow ? '↑↓选择 L登录 T测试 E编辑 D移除 /搜索 Tab模型 Enter详情 Esc返回' : '↑↓ 选择  L 登录/切换方式  T 测试  E 编辑  D 移除  / 搜索  Tab 模型  Enter 详情  Esc 返回'), width)].slice(0, height);
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
