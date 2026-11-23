import type { Klient } from '@moonshot-ai/klient';
import { padLine, stripAnsi, truncateToWidth } from './ansi.js';
import type { VspiTheme } from './theme.js';

export type QuotaSnapshot = Awaited<ReturnType<Klient['global']['quota']['list']>>;
export type QuotaItem = QuotaSnapshot['items'][number];
type QuotaWindow = QuotaItem['windows'][number];
type QuotaBalance = QuotaItem['balances'][number];

const GROUPS = [
  ['subscription', '订阅窗口'], ['cpa', 'CPA 网关（逐账号）'], ['balance', '账户余额'],
] as const;

export function quotaLabel(value: string): string {
  return stripAnsi(value).replaceAll(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').trim();
}

export function formatQuotaCountdown(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms <= 0) return '即将刷新';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function countdown(window: QuotaWindow, now: number, snapshotNow: number): string {
  return formatQuotaCountdown(window.resetAt !== undefined ? window.resetAt - now
    : window.resetsInMs === undefined ? undefined : window.resetsInMs - Math.max(0, now - snapshotNow));
}

function percent(window: QuotaWindow): number {
  return Math.round(Math.max(0, Math.min(100, window.remainingPercent)));
}

function windowText(window: QuotaWindow, now: number, snapshotNow: number, markStale = true): string {
  const value = percent(window);
  const filled = Math.round(value / 10);
  const time = countdown(window, now, snapshotNow);
  return `${padLine(quotaLabel(window.label || window.id), 6).trimEnd()} [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${String(value).padStart(3)}%${time ? ` (${time})` : ''}${markStale && window.stale ? ' (旧)' : ''}`;
}

function amountText(amount: number, currency: string): string {
  const value = amount.toFixed(2);
  return currency === 'CNY' ? `¥${value}` : currency === 'USD' ? `$${value}` : `${value} ${quotaLabel(currency)}`;
}

function balanceText(balance: QuotaBalance, compact = false, markStale = true): string {
  if (balance.unlimited) return `不限额${markStale && balance.stale ? ' (旧)' : ''}`;
  const amount = amountText(balance.amount, balance.currency);
  const equivalent = balance.equivalentAmount;
  return `${compact ? '' : `${balance.label ? quotaLabel(balance.label) : '余额'} `}${amount}${compact || balance.multiplier === undefined || equivalent === undefined ? '' : ` (×${balance.multiplier} 折合 ${amountText(equivalent, balance.currency)})`}${markStale && balance.stale ? ' (旧)' : ''}`;
}

function isStale(item: QuotaItem): boolean {
  return item.stale || item.status === 'stale';
}

function hasStaleReading(item: QuotaItem): boolean {
  return isStale(item) || item.windows.some(window => window.stale) || item.balances.some(balance => balance.stale);
}

function quotaStatus(item: QuotaItem): string {
  if (item.status === 'auth_error') return '鉴权失败 · 请重新登录或检查密钥';
  if (item.status === 'network_error') return '查询失败';
  if (item.status === 'unconfigured') return '未配置查询';
  return '';
}

function quotaItemLabel(item: QuotaItem): string {
  return quotaLabel(item.accountLabel ?? item.providerLabel ?? item.providerId);
}

function primaryWindows(item: QuotaItem): QuotaWindow[] {
  return [...item.windows].toSorted((a, b) => (a.id === '5h' ? 0 : a.id === '7d' ? 1 : 2) - (b.id === '5h' ? 0 : b.id === '7d' ? 1 : 2));
}

export function summarizeQuota(items: readonly QuotaItem[], now: number, snapshotNow: number): string {
  const readings = items.filter(item => item.status === 'ok' || item.status === 'stale');
  if (items.some(item => item.status === 'auth_error') || readings.length === 0 && items.some(item => item.status === 'network_error')) return '⚠ 额度';
  const cpa = items.filter(item => item.category === 'cpa' && item.status !== 'unconfigured');
  const candidates = readings.flatMap(item => primaryWindows(item).slice(0, 1).map(window => ({ item, window })));
  const first = cpa.length > 0 ? candidates.toSorted((a, b) => percent(a.window) - percent(b.window))[0] : candidates[0];
  if (first) {
    const { item, window } = first;
    const time = cpa.length > 0 ? '' : countdown(window, now, snapshotNow);
    return `${cpa.length > 0 ? `${cpa.length}卡 · ` : ''}${quotaLabel(window.label || window.id)} ${percent(window)}%${time ? ` ${time}` : ''}${isStale(item) || window.stale ? ' (旧)' : ''}`;
  }
  const item = readings.find(card => card.balances.length > 0);
  const balance = item?.balances[0];
  return item && balance ? `${balanceText(balance, true, false)}${isStale(item) || balance.stale ? ' (旧)' : ''}` : '';
}

export function quotaDetailLines(item: QuotaItem, now: number, snapshotNow: number): string[] {
  const status = quotaStatus(item);
  if (status) return [status, ...(item.errorMessage ? [quotaLabel(item.errorMessage)] : [])];
  return [...primaryWindows(item).map(window => windowText(window, now, snapshotNow, !isStale(item))),
    ...item.balances.map(balance => balanceText(balance, false, !isStale(item)))];
}

export function orderQuotaItems(items: readonly QuotaItem[]): QuotaItem[] {
  return GROUPS.flatMap(([category]) => items.filter(item => item.category === category));
}

export function renderProviderTabs(tab: 'source' | 'quota', theme: VspiTheme): string {
  return `${tab === 'source' ? theme.focus('[1 来源]') : ' 1 来源 '} ${theme.muted('|')} ${tab === 'quota' ? theme.focus('[2 额度]') : ' 2 额度 '}`;
}

export function renderQuotaView(options: {
  items: readonly QuotaItem[]; selected: number; detail: boolean; detailOffset: number;
  snapshotNow: number; now: number; status?: string;
}, width: number, height: number, theme: VspiTheme, viewportWidth = width): string[] {
  const { items, selected, now, snapshotNow } = options;
  const narrow = viewportWidth < 88;
  const focus = items[selected];
  const header = [renderProviderTabs('quota', theme) + theme.muted('  ·  5 分钟缓存')];
  if (options.status) header.push(theme.muted(options.status));
  const footer = theme.muted(options.detail ? '↑↓ 查看 · Esc 返回列表' : '↑↓ 选择 · Enter 详情 · r 刷新 · c 配置 · Esc 返回');
  const available = Math.max(1, height - header.length - 1);
  const finish = (lines: string[]) => [...header, ...lines, footer].map(line => truncateToWidth(line, width)).slice(0, height);
  if (options.detail && focus) {
    const details = quotaDetailLines(focus, now, snapshotNow);
    const offset = Math.min(options.detailOffset, Math.max(0, details.length - 1));
    return finish([theme.bold(quotaItemLabel(focus) + (isStale(focus) ? ' (旧)' : '')), ...details.slice(offset, offset + Math.max(0, available - 1))]);
  }
  if (items.length === 0) return finish([options.status ? '' : '暂无额度记录 · 按 1 管理来源']);
  const chunks: string[][] = [];
  let selectedChunk = 0;
  for (const [category, title] of GROUPS) {
    const group = items.filter(item => item.category === category);
    if (group.length === 0) continue;
    chunks.push([theme.bold(title)]);
    for (const item of group) {
      const active = item === focus;
      if (active) selectedChunk = chunks.length;
      const name = `${active ? '› ' : '  '}${quotaItemLabel(item)}${hasStaleReading(item) ? ' (旧)' : ''}`;
      const label = active ? theme.selected(name) : name;
      const status = quotaStatus(item);
      const windows = status ? [] : primaryWindows(item).slice(0, 2).map(window => windowText(window, now, snapshotNow, false));
      const balance = status ? undefined : item.balances[0];
      if (narrow) {
        chunks.push([`${label}${status ? `  ${theme.warning(status)}` : balance && windows.length === 0 ? `  ${balanceText(balance, true, false)}` : ''}`,
          `    ${windows.length > 0 ? windows.map(window => padLine(window, Math.max(1, Math.floor((width - 6) / 2)))).join('  ').trimEnd() : balance?.multiplier !== undefined ? balanceText(balance, false, false) : status === '未配置查询' ? '按 c 配置' : ''}`]);
      } else {
        const nameWidth = Math.max(8, Math.min(30, Math.floor(width / 4), width - 68));
        const metricWidth = Math.floor((width - nameWidth - 4) / 2);
        const metrics = windows.length > 0 ? windows.map(window => padLine(window, metricWidth)).join('  ').trimEnd() : status ? theme.warning(status) : balance ? balanceText(balance, false, false) : '';
        chunks.push([`${padLine(label, nameWidth)}  ${metrics}`]);
      }
    }
  }
  let start = 0;
  let used = 0;
  for (let index = 0; index <= selectedChunk; index++) {
    used += chunks[index]!.length;
    while (start < index && used > available) used -= chunks[start++]!.length;
  }
  const rows: string[] = [];
  for (let index = start; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    if (rows.length + chunk.length > available && rows.length > 0) break;
    rows.push(...chunk);
  }
  return finish(rows.slice(0, available));
}
