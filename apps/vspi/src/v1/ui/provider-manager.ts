import { decodeKittyPrintable, Input, Key, matchesKey } from '@moonshot-ai/pi-tui';
import type { ProviderModelEntry, ProviderOption } from '../domain/types.js';
import { sourceHealthLabel } from '../domain/canonical-models.js';
import type { ProviderConnectivityTestResult, ProviderModelOverridePatch, ProviderQuotaConfig } from '../providers/provider-contract.js';
import { alignRight, padLine, truncateToWidth } from './ansi.js';
import { orderQuotaItems, quotaDetailLines, quotaLabel, renderProviderTabs, renderQuotaView, summarizeQuota, type QuotaSnapshot } from './quota-view.js';
import type { VspiTheme } from './theme.js';

export const PROVIDER_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI Chat Completions' },
  { id: 'openai_responses', label: 'OpenAI Responses' },
  { id: 'anthropic', label: 'Anthropic Messages' },
  { id: 'google-genai', label: 'Google Generative AI' },
] as const;
const GATEWAY_PROTOCOLS = [...PROVIDER_PROTOCOLS, { id: 'auto', label: '按模型自动选择' }] as const;

export function providerProtocolLabel(protocol: string): string {
  return GATEWAY_PROTOCOLS.find(item => item.id === protocol)?.label ?? protocol;
}

function printableChar(data: string): string { return decodeKittyPrintable(data) ?? data; }

export interface ProviderManagerOption extends ProviderOption {
  localCredentials?: readonly NonNullable<ProviderOption['localCredential']>[];
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

const SOURCE_GROUPS = ['已启用', '已停用', '可添加'] as const;
function sourceGroup(provider: ProviderOption): typeof SOURCE_GROUPS[number] {
  return provider.enabled === false || provider.status === '已停用' ? '已停用'
    : provider.status === '未配置' && !provider.storedCredential ? '可添加' : '已启用';
}

function providerModels(provider: ProviderOption, models = provider.models): readonly ProviderModelEntry[] {
  return provider.modelEntries ?? models?.map(id => ({ id, wireModel: id })) ?? [];
}

function providerLocalCredentials(provider: ProviderManagerOption) {
  return provider.localCredentials ?? (provider.localCredential ? [provider.localCredential] : []);
}

function safeEndpoint(value?: string): string {
  if (!value) return '由 Provider 管理';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? quotaLabel(`${url.origin}${url.pathname}`) : '地址不可显示';
  } catch { return '地址不可显示'; }
}

export function renderProviderManager(
  providers: readonly ProviderManagerOption[],
  state: ProviderManagerState,
  width: number,
  height: number,
  theme: VspiTheme,
  details: ReadonlyMap<string, ProviderManagerDetail> = new Map(),
  quota?: QuotaSnapshot,
  now = Date.now(),
  viewportWidth = width,
): string[] {
  const narrow = viewportWidth < 96;
  const selected = providers[state.selected];
  const snapshotNow = quota?.now ?? now;
  const quotaFor = (provider: ProviderOption) => quota?.items.filter(item => item.providerId === provider.id) ?? [];
  const local = [...new Set(providers.flatMap(provider => providerLocalCredentials(provider).map(credential => quotaLabel(credential.name))))];
  const banner = local.length > 0 ? theme.success(`  ·  R 复用本机凭据：${local.join(' / ')}`) : '';
  const header = [renderProviderTabs('source', theme) + banner,
    `${theme.muted('/ 搜索来源  ')}${state.query || theme.muted('输入名称筛选')}${state.searching ? theme.inverse(' ') : ''}`];
  const footer = [theme.muted(state.modelFocus
    ? '↑↓ 选模型 · Enter 改协议/上下文 · F 刷模型 · Tab 回来源 · Esc 返回'
    : '↑↓ 选择 · Space 启停 · L 登录 · E 编辑 · T 测试 · F 刷模型'),
    theme.muted(state.modelFocus ? '' : 'Enter 详情 · Tab 模型 · C 配额度 · R 复用 · D 移除 · Esc 返回')];
  const available = Math.max(1, height - header.length - footer.length);
  const leftWidth = narrow ? width : Math.min(54, Math.floor(width * 0.44));
  const row = (text: string, active: boolean, summary = ''): string => {
    const label = `${active ? '› ' : '  '}${text}`;
    const value = summary ? alignRight(label, summary, leftWidth) : padLine(label, leftWidth);
    return active ? theme.selected(value) : value;
  };
  const list: string[] = [];
  let selectedRow = 0;
  for (const group of SOURCE_GROUPS) {
    const entries = providers.map((provider, index) => ({ provider, index })).filter(({ provider }) => sourceGroup(provider) === group);
    const addCustom = group === '可添加' && state.showCustom !== false;
    if (entries.length === 0 && !addCustom) continue;
    list.push(theme.bold(theme.muted(`  ${group} · ${entries.length + Number(addCustom)}`)));
    for (const { provider, index } of entries) {
      if (index === state.selected) selectedRow = list.length;
      const status = group === '已停用' ? '  ○ 已停用' : provider.status === '异常' ? '  ⚠ 异常'
        : provider.status === '已配置' || provider.status === '已验证' ? '  ✓ 可用' : '';
      list.push(row(quotaLabel(provider.label) + status, index === state.selected,
        group === '已启用' ? summarizeQuota(quotaFor(provider), now, snapshotNow) : ''));
    }
    if (addCustom) {
      if (state.selected === providers.length) selectedRow = list.length;
      list.push(row('+ 添加自定义中转站 / CPA 网关', state.selected === providers.length));
    }
    if (group !== '可添加') list.push('');
  }
  const start = Math.max(0, Math.min(selectedRow - Math.floor(available / 2), list.length - available));
  const visible = list.slice(start, start + available);
  const rightWidth = narrow ? width : width - leftWidth - 3;
  const detailRows: string[] = [];
  if (selected) {
    const detail = details.get(selected.id);
    const field = (label: string, value: string) => `${padLine(theme.muted(label), 12)}${quotaLabel(value)}`;
    const latest = selected.modelHealth;
    const checkedAt = latest ? Math.max(latest.health.lastSuccess ?? 0, latest.health.lastFailure?.at ?? 0) : 0;
    const models = providerModels(selected, detail?.models ?? selected.models);
    const defaultModel = detail?.defaultModel ?? selected.defaultModel;
    const auth = detail?.authLabel ?? selected.authLabel ?? (selected.storedCredential === 'oauth' ? '订阅账号' : selected.storedCredential === 'api_key' ? 'API Key' : '未连接');
    const modelHeader = theme.bold(`${state.modelFocus ? '› ' : ''}模型 · ${models.length}`);
    detailRows.push(theme.bold(theme.focus(quotaLabel(selected.label))),
      field('认证方式', auth),
      ...detail?.account || selected.localCredential?.account ? [field('账号', detail?.account ?? selected.localCredential?.account ?? '')] : [],
      ...detail?.expiresAt || selected.localCredential?.expiresAt ? [field('凭据到期', detail?.expiresAt ?? selected.localCredential?.expiresAt ?? '')] : [],
      field('Endpoint', safeEndpoint(selected.baseUrl)),
      field('协议', providerProtocolLabel(selected.protocol)),
      field('上次请求', latest && checkedAt > 0 ? sourceHealthLabel(latest) : '尚未测试'),
      ...latest && checkedAt > 0 ? [field('模型请求', latest.model)] : [],
      ...detail?.lastCheck ? [field('连通测试', detail.lastCheck)] : [],
      field('默认模型', defaultModel ?? '未设置'));
    const cards = selected.enabled === false ? [] : quotaFor(selected);
    if (cards.length > 0) {
      const quotaRows = cards.flatMap(card => [
        ...card.accountLabel ? [quotaLabel(card.accountLabel) + (card.stale ? ' (旧)' : '')] : [],
        ...quotaDetailLines(card, now, snapshotNow).map(line => `${!card.accountLabel && card.stale ? '(旧) ' : ''}${line}`),
      ]);
      const limit = Math.max(1, Math.min(4, available - detailRows.length - 4));
      detailRows.push(theme.bold('当前额度'), ...quotaRows.slice(0, limit));
      if (quotaRows.length > limit) detailRows.push(theme.muted('按 2 查看全部额度'));
    }
    if (state.modelFocus && detailRows.length + 3 > available) detailRows.splice(1, detailRows.length - 1);
    detailRows.push(modelHeader);
    const offset = Math.min(state.modelOffset, Math.max(0, models.length - 1));
    const modelRows = Math.max(1, available - detailRows.length - 1);
    detailRows.push(...models.slice(offset, offset + modelRows).map((model, index) => {
      const active = index === 0 && state.modelFocus;
      const name = `${active ? '› ' : '  '}${quotaLabel(model.id)}${defaultModel === model.id ? ' · 默认' : ''}`;
      const meta = [model.protocol ? quotaLabel(model.protocol) : '', model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : ''].filter(Boolean).join('  ');
      const line = meta ? alignRight(name, meta, rightWidth) : name;
      return active ? theme.selected(line) : line;
    }));
    if (models.length > offset + modelRows) detailRows.push(theme.muted('↓ 更多模型 · Tab 聚焦'));
  } else detailRows.push(theme.focus('添加自定义中转站'), '', '填写名称、Endpoint、协议与凭据。');
  const body = narrow
    ? state.detail ? detailRows.slice(0, available) : visible
    : Array.from({ length: Math.min(available, Math.max(visible.length, detailRows.length)) }, (_, index) => `${padLine(visible[index] ?? '', leftWidth)} ${theme.border('│')} ${padLine(detailRows[index] ?? '', rightWidth)}`);
  return [...header, ...body, ...footer.filter(Boolean)].map(line => truncateToWidth(line, width)).slice(0, height);
}

export type ProviderQuotaPatch = Omit<ProviderQuotaConfig, 'managementKey' | 'managementKeyEnv' | 'managementKeyRef'> & { managementKey?: string | null };
export type ProviderQuotaSettings = Pick<ProviderQuotaConfig, 'mode' | 'apiProfile' | 'managementUrl' | 'userId' | 'billingMultiplier'> & { hasManagementKey?: boolean };

export function providerCheckLabel(result: ProviderConnectivityTestResult): string {
  const labels = { ok: '✓ 可用', config_error: '✗ 配置未就绪', auth_error: '✗ 鉴权失败', network_error: '✗ 代理或网络不可达', timeout: '✗ 连接超时', protocol_error: '✗ 协议或路径不匹配', unknown_error: '✗ 探测失败' };
  const details = [result.modelCount === undefined ? '' : `发现 ${result.modelCount} 个模型`, result.httpStatus === undefined ? '' : `HTTP ${result.httpStatus}`, `耗时 ${result.durationMs}ms`].filter(Boolean);
  return `${labels[result.category]}（${details.join(' · ')}）`;
}

export type ProviderManagerAction =
  | { type: 'login'; provider: ProviderOption; credential: 'api_key' | 'oauth' }
  | { [Action in 'local' | 'test' | 'remove' | 'refreshModels' | 'configureQuota']: { type: Action; provider: ProviderOption } }['local' | 'test' | 'remove' | 'refreshModels' | 'configureQuota']
  | { type: 'toggle'; provider: ProviderOption; enabled: boolean }
  | { type: 'save'; provider?: ProviderOption; value: GatewayFormValue }
  | { type: 'saveQuota'; provider: ProviderOption; value: ProviderQuotaPatch }
  | { type: 'saveModel'; provider: ProviderOption; alias: string; value: ProviderModelOverridePatch }
  | { type: 'refreshQuota' }
  | { type: 'close' };

type ProviderForm = ProviderGatewayForm | ProviderQuotaForm | ProviderModelForm;

export class ProviderManagerController {
  readonly state: ProviderManagerState = { selected: 0, query: '', searching: false, detail: false, modelFocus: false, modelOffset: 0 };
  private providers: ProviderManagerOption[] = [];
  private readonly search = new Input();
  private menu?: { label: string; action?: ProviderManagerAction }[];
  private menuSelected = 0;
  private form?: ProviderForm;
  private pending?: ProviderManagerAction;
  private readonly checks = new Map<string, string>();
  private tab: 'source' | 'quota' = 'source';
  private quota?: QuotaSnapshot;
  private quotaItems: QuotaSnapshot['items'] = [];
  private quotaIndex = 0;
  private quotaDetail = false;
  private quotaOffset = 0;
  private quotaLoading?: Promise<void>;
  private quotaRefreshing = false;
  private quotaStatus?: string;
  private quotaClockOffset = 0;
  private quotaGeneration = 0;
  private readonly showCustom: boolean;

  constructor(showCustom = true) { this.showCustom = showCustom; this.state.showCustom = showCustom; }

  open(tab: 'source' | 'quota' = 'source'): void {
    this.tab = tab;
    this.quotaDetail = false;
    this.state.detail = false;
    this.state.modelFocus = false;
    this.state.searching = false;
    this.state.query = '';
    this.state.modelOffset = 0;
    this.state.showCustom = this.showCustom;
    this.search.setValue('');
    this.menu = undefined;
    this.form = undefined;
    this.pending = undefined;
    this.state.selected = Math.min(this.state.selected, Math.max(0, this.providers.length));
  }

  setProviders(providers: readonly ProviderManagerOption[]): void {
    const previous = this.visible()[this.state.selected]?.id;
    this.providers = SOURCE_GROUPS.flatMap(group => providers.filter(provider => sourceGroup(provider) === group));
    const index = this.visible().findIndex(provider => provider.id === previous);
    this.state.selected = index < 0 ? Math.min(this.state.selected, this.sourceMaxIndex()) : index;
  }

  selectProvider(id: string): void {
    this.state.query = ''; this.search.setValue(''); this.state.searching = false;
    this.state.showCustom = this.showCustom;
    this.state.selected = Math.max(0, this.providers.findIndex(provider => provider.id === id));
    this.state.modelOffset = 0;
  }

  invalidateQuota(): void {
    this.quotaGeneration++;
    this.quotaLoading = undefined;
    this.quotaRefreshing = false;
  }

  async loadQuota(loader: () => Promise<QuotaSnapshot>, update: () => void, refresh = false): Promise<void> {
    if (this.quotaLoading) {
      if (refresh && !this.quotaRefreshing) {
        await this.quotaLoading;
        return this.loadQuota(loader, update, true);
      }
      return this.quotaLoading;
    }
    this.quotaRefreshing = refresh;
    const generation = ++this.quotaGeneration;
    this.quotaStatus = refresh ? '正在刷新额度…' : '正在读取额度…';
    const pending = Promise.resolve().then(loader).then(snapshot => {
      if (generation !== this.quotaGeneration) return;
      const selected = this.quotaItems[this.quotaIndex]?.id;
      this.quota = snapshot;
      this.quotaClockOffset = snapshot.now - Date.now();
      this.quotaItems = orderQuotaItems(snapshot.items);
      const index = this.quotaItems.findIndex(item => item.id === selected);
      this.quotaIndex = index < 0 ? Math.min(this.quotaIndex, Math.max(0, this.quotaItems.length - 1)) : index;
      this.quotaStatus = undefined;
    }, () => {
      if (generation !== this.quotaGeneration) return;
      this.quotaStatus = '额度读取失败 · 按 r 重试';
    }).finally(() => {
      if (generation === this.quotaGeneration) {
        this.quotaLoading = undefined;
        this.quotaRefreshing = false;
        update();
      }
    });
    this.quotaLoading = pending;
    update();
    return pending;
  }

  private visible(): ProviderOption[] {
    const query = this.state.query.trim().toLowerCase();
    return this.providers.filter(provider => `${provider.id} ${provider.label}`.toLowerCase().includes(query));
  }

  private sourceMaxIndex(): number { return Math.max(0, this.visible().length - Number(!this.state.showCustom)); }

  recordCheck(id: string, diagnostic: string): void { this.checks.set(id, diagnostic); }
  finishSave(error?: string): void { if (error) this.form?.setError(error); else this.form = undefined; }

  editQuota(provider: ProviderOption, settings: ProviderQuotaSettings): void {
    this.form = new ProviderQuotaForm(settings, value => {
      this.pending = { type: 'saveQuota', provider, value };
    }, () => { this.form = undefined; });
  }

  handleInput(data: string): ProviderManagerAction | undefined {
    if (this.form) { this.form.handleInput(data); const action = this.pending; this.pending = undefined; return action; }
    const char = printableChar(data).toLowerCase();
    if (matchesKey(data, Key.escape)) {
      if (this.menu) this.menu = undefined;
      else if (this.tab === 'quota') {
        if (this.quotaDetail) this.quotaDetail = false;
        else return { type: 'close' };
      }
      else if (this.state.searching) this.state.searching = false;
      else if (this.state.modelFocus) this.state.modelFocus = false;
      else if (this.state.detail) this.state.detail = false;
      else if (this.state.query) { this.state.query = ''; this.search.setValue(''); this.state.selected = 0; this.state.showCustom = this.showCustom; }
      else return { type: 'close' };
      return;
    }
    if (this.menu) {
      if (matchesKey(data, Key.up)) this.menuSelected = Math.max(0, this.menuSelected - 1);
      else if (matchesKey(data, Key.down)) this.menuSelected = Math.min(this.menu.length - 1, this.menuSelected + 1);
      else if (matchesKey(data, Key.enter)) { const action = this.menu[this.menuSelected]?.action; this.menu = undefined; return action; }
      return;
    }
    if (this.tab === 'source' && this.state.searching) {
      if (matchesKey(data, Key.enter)) this.state.searching = false;
      else {
        this.search.handleInput(data); this.state.query = this.search.getValue(); this.state.selected = 0; this.state.modelOffset = 0;
        this.state.showCustom = this.showCustom && !this.state.query.trim();
      }
      return;
    }
    if (this.showCustom && (char === '1' || matchesKey(data, Key.ctrl('left')))) { this.tab = 'source'; return; }
    if (this.showCustom && (char === '2' || matchesKey(data, Key.ctrl('right')))) { this.tab = 'quota'; return; }
    if (this.tab === 'quota') {
      if (char === 'r') return { type: 'refreshQuota' };
      const item = this.quotaItems[this.quotaIndex];
      if (!item) return;
      if (char === 'c') {
        const provider = this.providers.find(candidate => candidate.id === item.providerId);
        if (provider) return { type: 'configureQuota', provider };
      }
      if (matchesKey(data, Key.enter)) { this.quotaDetail = true; this.quotaOffset = 0; }
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        const delta = matchesKey(data, Key.up) ? -1 : 1;
        if (this.quotaDetail) {
          const count = quotaDetailLines(item, this.quota!.now, this.quota!.now).length;
          this.quotaOffset = Math.max(0, Math.min(count - 1, this.quotaOffset + delta));
        } else this.quotaIndex = Math.max(0, Math.min(this.quotaItems.length - 1, this.quotaIndex + delta));
      }
      return;
    }
    if (char === '/') { this.state.searching = true; this.state.detail = false; this.state.modelFocus = false; return; }
    const providers = this.visible();
    const provider = providers[this.state.selected];
    const models = provider ? providerModels(provider) : [];
    if (matchesKey(data, Key.tab) && provider) { this.state.modelFocus = !this.state.modelFocus; this.state.detail = this.state.modelFocus; return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      if (this.state.modelFocus) this.state.modelOffset = Math.max(0, Math.min(models.length - 1, this.state.modelOffset + delta));
      else { this.state.selected = Math.max(0, Math.min(this.sourceMaxIndex(), this.state.selected + delta)); this.state.modelOffset = 0; }
      return;
    }
    if (!provider) {
      if (this.state.showCustom && (matchesKey(data, Key.enter) || char === 'e' || char === 'l')) this.edit();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.state.modelFocus) {
        const model = models[this.state.modelOffset];
        if (model) this.form = new ProviderModelForm(model, value => {
          this.pending = { type: 'saveModel', provider, alias: model.id, value };
        }, () => { this.form = undefined; });
      } else this.state.detail = true;
      return;
    }
    if (char === 'e') { this.edit(provider); return; }
    if (char === 't') return { type: 'test', provider };
    if (sourceGroup(provider) !== '可添加') {
      if (char === ' ') return { type: 'toggle', provider, enabled: sourceGroup(provider) === '已停用' };
      if (char === 'c') return { type: 'configureQuota', provider };
      if (char === 'f') return { type: 'refreshModels', provider };
    }
    if (char === 'r') {
      const credentials = providerLocalCredentials(provider);
      if (credentials.length === 0) return;
      this.menu = [...credentials.map(localCredential => ({
        label: `复用本机 ${localCredential.name} → ${provider.label}`,
        action: { type: 'local' as const, provider: { ...provider, localCredential } },
      })), { label: '取消' }];
      this.menuSelected = credentials.length;
      return;
    }
    if (char === 'd' && provider.storedCredential) {
      this.menu = [{ label: `确认移除 ${provider.label} 的凭据（不删除外部 CLI 文件）`, action: { type: 'remove', provider } }];
      this.menuSelected = 0;
    }
    if (char === 'l') {
      this.menu = (provider.authMethods ?? [{ type: 'api_key' as const, label: 'API Key' }]).map(method => ({ label: method.label, action: { type: 'login', provider, credential: method.type } }));
      this.menuSelected = 0;
      if (this.menu.length === 1) { const action = this.menu[0]!.action; this.menu = undefined; return action; }
    }
  }

  private edit(provider?: ProviderOption): void {
    this.form = new ProviderGatewayForm(value => {
      if (this.form instanceof ProviderGatewayForm) this.form.setBusy(true);
      this.pending = { type: 'save', provider, value };
    }, () => { this.form = undefined; }, provider ? { name: provider.label, baseUrl: provider.baseUrl, protocol: provider.protocol } : undefined);
  }

  render(width: number, height: number, theme: VspiTheme, viewportWidth = width): string[] {
    if (this.form) return this.form.render(width, theme).slice(0, height);
    if (this.menu) return [theme.bold('Provider 操作'), '', ...this.menu.map((item, index) => index === this.menuSelected ? theme.selected(`› ${quotaLabel(item.label)}`) : `  ${quotaLabel(item.label)}`), '', theme.muted('↑↓ 选择 · Enter 确认 · Esc 返回')].map(line => truncateToWidth(line, width)).slice(0, height);
    const now = Date.now() + this.quotaClockOffset;
    if (this.tab === 'quota') {
      const snapshotNow = this.quota?.now ?? now;
      const cooldown = (this.quota?.cooldownRemainingMs ?? 0) - Math.max(0, now - snapshotNow);
      const labels = new Map(this.providers.map(provider => [provider.id, provider.label]));
      const items = this.quotaItems.map(item => ({ ...item, providerLabel: labels.get(item.providerId) ?? item.providerLabel }));
      return renderQuotaView({ items, selected: this.quotaIndex, detail: this.quotaDetail,
        detailOffset: this.quotaOffset, snapshotNow, now,
        status: this.quotaStatus ?? (cooldown > 0 ? `请在 ${Math.ceil(cooldown / 1_000)} 秒后刷新` : undefined) }, width, height, theme, viewportWidth);
    }
    return renderProviderManager(this.visible(), this.state, width, height, theme, new Map(this.providers.map(provider => [provider.id, {
      models: provider.models, account: provider.localCredential?.account, expiresAt: provider.localCredential?.expiresAt,
      authLabel: provider.authLabel, defaultModel: provider.defaultModel, lastCheck: this.checks.get(provider.id),
    }])), this.quota, now, viewportWidth);
  }
}

export interface GatewayFormValue {
  name: string;
  baseUrl: string;
  protocol: string;
  apiKey: string;
  modelIds?: string;
}

export class ProviderGatewayForm {
  private readonly inputs = [new Input(), new Input(), new Input(), new Input()];
  private field = 0;
  private protocolIndex = 0;
  private error = '';
  private busy = false;

  constructor(
    private readonly submit: (value: GatewayFormValue) => void,
    private readonly cancel: () => void,
    private readonly initial?: Partial<GatewayFormValue>,
  ) {
    this.inputs[0]!.setValue(initial?.name ?? '');
    this.inputs[1]!.setValue(initial?.baseUrl ?? '');
    this.inputs[2]!.setValue(initial?.apiKey ?? '');
    this.inputs[3]!.setValue(initial?.modelIds ?? '');
    this.protocolIndex = Math.max(0, GATEWAY_PROTOCOLS.findIndex(item => item.id === initial?.protocol));
  }

  setBusy(value: boolean): void { this.busy = value; }
  setError(value: string): void { this.error = value; this.busy = false; }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { if (!this.busy) this.cancel(); return; }
    if (this.busy) return;
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) this.field = (this.field + 1) % 6;
    else if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.up)) this.field = (this.field + 5) % 6;
    else if (this.field === 2 && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      this.protocolIndex = (this.protocolIndex + (matchesKey(data, Key.left) ? GATEWAY_PROTOCOLS.length - 1 : 1)) % GATEWAY_PROTOCOLS.length;
    } else if (matchesKey(data, Key.ctrl('s')) || (this.field === 5 && matchesKey(data, Key.enter))) {
      const name = this.inputs[0]!.getValue().trim();
      const baseUrl = this.inputs[1]!.getValue().trim();
      const apiKey = this.inputs[2]!.getValue();
      const modelIds = this.inputs[3]!.getValue().trim() || undefined;
      if (!name || !baseUrl) { this.error = '名称和 Base URL 不能为空'; return; }
      try {
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      } catch { this.error = '请输入有效的 HTTP(S) Base URL，不包含账号、密码、查询或片段'; return; }
      this.error = '';
      this.submit({ name, baseUrl, protocol: GATEWAY_PROTOCOLS[this.protocolIndex]!.id, apiKey, modelIds });
    } else if (matchesKey(data, Key.enter)) this.field = (this.field + 1) % 6;
    else if (this.field !== 2 && this.field !== 5) this.inputs[this.field > 2 ? this.field - 1 : this.field]?.handleInput(data);
  }

  render(width: number, theme: VspiTheme): string[] {
    const labels = ['名称', 'Base URL', '协议', 'API Key', '模型 ID（可手动填写，逗号或空格分隔）'];
    const protocol = GATEWAY_PROTOCOLS[this.protocolIndex]!;
    const values = [this.inputs[0]!.getValue(), this.inputs[1]!.getValue(), protocol.label, '•'.repeat(Math.min(32, this.inputs[2]!.getValue().length)), this.inputs[3]!.getValue()];
    const keyHint = this.initial?.baseUrl === values[1]?.trim() && this.initial?.protocol === protocol.id ? '留空保留现有凭据' : '请输入 API Key';
    const placeholders = ['请输入', 'https://gateway.example.com/v1', '', keyHint, '例如 model-a, model-b'];
    return [theme.bold(theme.focus('自定义中转站')), '',
      ...labels.flatMap((label, index) => [theme.muted(truncateToWidth(label, width)),
        padLine(truncateToWidth(`${index === this.field ? '› ' : '  '}${values[index] || theme.muted(placeholders[index]!)}${index === this.field ? theme.inverse(' ') : ''}${index === 2 ? theme.muted('  ← → 选择') : ''}`, width), width)]), '',
      this.busy ? theme.muted('正在测试并保存…') : this.field === 5 ? theme.selected('› 测试并保存') : '  测试并保存',
      ...(this.error ? [theme.warning(truncateToWidth(this.error, width))] : []), '',
      truncateToWidth(theme.muted('Tab / Shift-Tab 切换字段 · Ctrl+S 测试并保存 · Esc 取消'), width)];
  }
}

const QUOTA_MODES = [
  { id: 'off', label: '关闭' }, { id: 'auto', label: '自动' }, { id: 'newapi-token', label: 'NewAPI Token' },
  { id: 'newapi-account', label: 'NewAPI 账户' }, { id: 'cpa', label: 'CPA 网关' },
] as const;

class ProviderQuotaForm {
  private readonly url = new Input();
  private readonly userId = new Input();
  private readonly key = new Input();
  private readonly multiplier = new Input();
  private readonly fields = ['mode', 'profile', 'url', 'userId', 'keyAction', 'key', 'multiplier', 'save'] as const;
  private field = 0;
  private modeIndex: number;
  private profile: 'v8' | 'v0-compat';
  private keyAction = 0;
  private error = '';
  private busy = false;

  constructor(private readonly initial: ProviderQuotaSettings, private readonly submit: (patch: ProviderQuotaPatch) => void,
    private readonly cancel: () => void) {
    this.modeIndex = Math.max(0, QUOTA_MODES.findIndex(mode => mode.id === (initial.mode ?? 'auto')));
    this.profile = initial.apiProfile === 'v0-compat' ? 'v0-compat' : 'v8';
    this.url.setValue(initial.managementUrl ?? '');
    this.userId.setValue(initial.userId ?? '');
    this.multiplier.setValue(initial.billingMultiplier?.toString() ?? '');
  }

  setError(error: string): void { this.error = error; this.busy = false; }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, Key.escape)) { this.cancel(); return; }
    const field = this.fields[this.field];
    const last = this.fields.length - 1;
    if (matchesKey(data, Key.ctrl('s')) || field === 'save' && matchesKey(data, Key.enter)) { this.save(); return; }
    if ([Key.tab, Key.down, Key.enter].some(key => matchesKey(data, key))) this.field = (this.field + 1) % this.fields.length;
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.shift('tab'))) this.field = (this.field + last) % this.fields.length;
    else if (field === 'mode' || field === 'profile' || field === 'keyAction') {
      const delta = matchesKey(data, Key.left) ? -1 : matchesKey(data, Key.right) ? 1 : 0;
      if (!delta) return;
      if (field === 'mode') this.modeIndex = (this.modeIndex + delta + QUOTA_MODES.length) % QUOTA_MODES.length;
      else if (field === 'profile') this.profile = this.profile === 'v8' ? 'v0-compat' : 'v8';
      else { this.keyAction = (this.keyAction + delta + 3) % 3; if (this.keyAction !== 1) this.key.setValue(''); }
    } else if (field === 'url') this.url.handleInput(data);
    else if (field === 'userId') this.userId.handleInput(data);
    else if (field === 'key' && this.keyAction === 1) this.key.handleInput(data);
    else if (field === 'multiplier') this.multiplier.handleInput(data);
  }

  private save(): void {
    const mode = QUOTA_MODES[this.modeIndex]!.id;
    const managementUrl = this.url.getValue().trim();
    const userId = this.userId.getValue().trim();
    const key = this.key.getValue().trim();
    const multiplier = this.multiplier.getValue().trim();
    const billingMultiplier = multiplier ? Number(multiplier) : undefined;
    const url = managementUrl ? URL.parse(managementUrl) : undefined;
    if (managementUrl && (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)) {
      this.field = 2; this.error = '请输入不含凭据、查询或片段的 HTTP(S) 管理地址'; return;
    }
    if (this.keyAction === 1 && !key) { this.field = 5; this.error = '请输入管理密钥，或将密钥操作改为保留'; return; }
    if (billingMultiplier !== undefined && (!Number.isFinite(billingMultiplier) || billingMultiplier <= 0)) {
      this.field = 6; this.error = '计费倍率必须大于 0'; return;
    }
    this.error = '';
    this.busy = true;
    this.submit({ mode, apiProfile: mode === 'cpa' ? this.profile : mode === 'newapi-account' ? 'account' : mode === 'newapi-token' ? 'token' : undefined,
      managementUrl: managementUrl || undefined, userId: userId || undefined, billingMultiplier,
      managementKey: this.keyAction === 1 ? key : this.keyAction === 2 ? null : undefined });
  }

  render(width: number, theme: VspiTheme): string[] {
    const labels = ['模式', 'CPA 接口', '管理地址', 'NewAPI 用户 ID', '密钥操作', '管理密钥', '计费倍率'];
    const values = [QUOTA_MODES[this.modeIndex]!.label, this.profile, quotaLabel(this.url.getValue()) || (this.initial.managementUrl ? '留空保留原地址' : '沿用来源地址'),
      quotaLabel(this.userId.getValue()) || (this.initial.userId ? '留空保留原 ID' : '未指定'), [this.initial.hasManagementKey ? '保留（已配置）' : '保留', '填写新密钥', '清除'][this.keyAction],
      this.keyAction === 1 ? '•'.repeat(Math.min(this.key.getValue().length, 32)) || '请输入' : '—', quotaLabel(this.multiplier.getValue()) || (this.initial.billingMultiplier ? '留空保留原倍率' : '默认 1')];
    const rows = labels.map((label, index) => {
      const line = `${index === this.field ? '› ' : '  '}${padLine(label, 16)}${values[index]}${[0, 1, 4].includes(index) && this.field === index ? '  ← →' : ''}`;
      return this.field === index ? theme.selected(line) : line;
    });
    return [theme.bold('配置额度查询'), '', ...rows,
      this.busy ? '正在保存…' : this.field === labels.length ? theme.selected('› 保存') : '  保存',
      ...(this.error ? [theme.warning(this.error)] : []), '', theme.muted('Tab / ↑↓ 切换 · Ctrl+S 保存 · Esc 取消')].map(line => truncateToWidth(line, width));
  }
}

class ProviderModelForm {
  private readonly context = new Input();
  private field = 0;
  private protocolIndex: number;
  private readonly initialProtocolIndex: number;
  private error = '';
  private busy = false;

  constructor(private readonly model: ProviderModelEntry, private readonly submit: (patch: ProviderModelOverridePatch) => void,
    private readonly cancel: () => void) {
    const index = PROVIDER_PROTOCOLS.findIndex(protocol => protocol.id === (model.overrideProtocol ?? model.protocol));
    this.protocolIndex = this.initialProtocolIndex = index;
    this.context.setValue(model.overrideContextWindow?.toString() ?? '');
  }

  setError(error: string): void { this.error = error; this.busy = false; }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, Key.escape)) { this.cancel(); return; }
    if (matchesKey(data, Key.ctrl('s')) || this.field === 2 && matchesKey(data, Key.enter)) {
      const value = this.context.getValue().trim();
      const maxContextSize = value ? Number(value) : undefined;
      if (maxContextSize !== undefined && (!Number.isSafeInteger(maxContextSize) || maxContextSize < 1)) {
        this.field = 1; this.error = '上下文窗口须为正整数'; return;
      }
      this.busy = true;
      this.submit({ protocol: this.protocolIndex === this.initialProtocolIndex ? undefined : PROVIDER_PROTOCOLS[this.protocolIndex]?.id, maxContextSize });
    } else if ([Key.tab, Key.enter, Key.down].some(key => matchesKey(data, key))) this.field = (this.field + 1) % 3;
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.shift('tab'))) this.field = (this.field + 2) % 3;
    else if (this.field === 0 && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      this.protocolIndex = this.protocolIndex < 0 ? matchesKey(data, Key.left) ? PROVIDER_PROTOCOLS.length - 1 : 0
        : (this.protocolIndex + (matchesKey(data, Key.left) ? PROVIDER_PROTOCOLS.length - 1 : 1)) % PROVIDER_PROTOCOLS.length;
    } else if (this.field === 1) this.context.handleInput(data);
  }

  render(width: number, theme: VspiTheme): string[] {
    const rows = [
      `协议  ${PROVIDER_PROTOCOLS[this.protocolIndex]?.label ?? quotaLabel(this.model.protocol ?? '沿用来源')}${this.field === 0 ? '  ← →' : ''}`,
      `上下文窗口  ${quotaLabel(this.context.getValue()) || (this.model.contextWindow ? `当前 ${this.model.contextWindow}` : '沿用默认')}`,
      this.busy ? '正在保存…' : '保存',
    ].map((line, index) => index === this.field ? theme.selected(`› ${line}`) : `  ${line}`);
    return [theme.bold(`编辑模型 · ${quotaLabel(this.model.id)}`), '', ...rows, ...(this.error ? [theme.warning(this.error)] : []), '',
      theme.muted('Tab / ↑↓ 切换 · Ctrl+S 保存 · Esc 取消')].map(line => truncateToWidth(line, width));
  }
}
