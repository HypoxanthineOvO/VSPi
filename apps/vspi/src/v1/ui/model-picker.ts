import { Input, Key, matchesKey } from '@moonshot-ai/pi-tui';
import type { ModelPicks } from '../config/settings.js';
import { canonicalModelGroups, searchCanonicalModels, sourceHealthLabel, sourceUnhealthy, type CanonicalModelGroup } from '../domain/canonical-models.js';
import { modelHasIdentity, modelIdentityKey } from '../domain/model-presentation.js';
import type { ModelOption } from '../domain/types.js';
import { alignRight, padLine, stripAnsi, truncateToWidth } from './ansi.js';
import type { PanelEvent } from './panels.js';
import type { VspiTheme } from './theme.js';

function sourcePrice(model: ModelOption): string {
  const { inputUsdPerMillion: input, outputUsdPerMillion: output } = model.price;
  return input === undefined || output === undefined ? '价格未知' : `$${input} / $${output} · ${model.price.source === 'official' ? '官方' : '渠道'}`;
}

function sourceContext(model?: ModelOption): string {
  const context = model?.contextWindow;
  return context === undefined ? '上下文未知' : context >= 1_000_000 ? `${+(context / 1_000_000).toFixed(2)}M context` : `${Math.round(context / 1024)}K context`;
}

export class ModelPicker {
  private readonly search = new Input();
  private models: readonly ModelOption[] = [];
  private picks: ModelPicks = { pinned: [], recent: [] };
  private selectedKey = '';
  private selected = 0;
  private sourceIndex = 0;
  private expanded = false;
  private showAll = false;
  private warningKey: string | undefined;

  setModels(models: readonly ModelOption[], selectedKey: string): void {
    const focused = this.groups()[this.selected]?.id;
    this.models = models;
    this.selectedKey = selectedKey;
    this.selected = Math.max(0, this.groups().findIndex(group => group.id === focused));
  }

  setPicks(picks: ModelPicks): void {
    const focused = this.groups()[this.selected]?.id;
    this.picks = picks;
    this.selected = Math.max(0, this.groups().findIndex(group => group.id === focused));
  }

  open(): void {
    this.search.setValue('');
    this.showAll = false;
    this.selected = Math.max(0, this.groups().findIndex(group => group.sources.some(source => modelHasIdentity(source, this.selectedKey))));
    this.expanded = false;
    this.warningKey = undefined;
  }

  private groups(): CanonicalModelGroup[] {
    const groups = canonicalModelGroups(this.models, this.picks.sources, this.selectedKey);
    const visible = this.showAll ? groups : groups.filter(group => group.sources.some(source => source.curated || this.picks.pinned.some(key => modelHasIdentity(source, key)) || this.picks.recent.some(key => modelHasIdentity(source, key))));
    const filtered = searchCanonicalModels(visible, this.search.getValue());
    const keys = [...this.picks.pinned, ...this.picks.recent];
    const rank = (group: CanonicalModelGroup) => {
      const index = keys.findIndex(key => group.sources.some(source => modelHasIdentity(source, key)));
      return index < 0 ? keys.length : index;
    };
    return filtered.toSorted((left, right) => rank(left) - rank(right));
  }

  handleInput(data: string): PanelEvent | undefined {
    if (matchesKey(data, Key.escape)) {
      if (this.expanded) { this.expanded = false; this.warningKey = undefined; return; }
      return { type: 'close' };
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      this.showAll = !this.showAll;
      this.selected = 0;
      this.expanded = false;
      this.warningKey = undefined;
      return;
    }
    const groups = this.groups();
    const group = groups[this.selected];
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.expanded = !!group && (matchesKey(data, Key.right) || !this.expanded);
      this.sourceIndex = Math.max(0, group?.sources.findIndex(source => source === group.defaultSource) ?? 0);
      this.warningKey = undefined;
      return;
    }
    if (matchesKey(data, Key.left)) { this.expanded = false; this.warningKey = undefined; return; }
    const movement = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.pageUp) ? -8 : matchesKey(data, Key.pageDown) ? 8 : 0;
    if (movement) {
      if (this.expanded) this.sourceIndex = Math.max(0, Math.min((group?.sources.length ?? 1) - 1, this.sourceIndex + movement));
      else this.selected = Math.max(0, Math.min(groups.length - 1, this.selected + movement));
      this.warningKey = undefined;
      return;
    }
    if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
      if (this.expanded) this.sourceIndex = matchesKey(data, Key.home) ? 0 : Math.max(0, (group?.sources.length ?? 1) - 1);
      else this.selected = matchesKey(data, Key.home) ? 0 : Math.max(0, groups.length - 1);
      this.warningKey = undefined;
      return;
    }
    if (matchesKey(data, Key.ctrl('p')) && group) {
      const pinned = group.sources.some(source => this.picks.pinned.some(key => modelHasIdentity(source, key)));
      const keys = this.picks.pinned.filter(key => !group.sources.some(source => modelHasIdentity(source, key)));
      if (!pinned) keys.push(modelIdentityKey(group.defaultSource ?? group.sources[0]));
      this.picks = { ...this.picks, pinned: keys };
      this.selected = Math.max(0, this.groups().findIndex(candidate => candidate.id === group.id));
      return { type: 'modelPin', pinned: keys };
    }
    if (matchesKey(data, Key.enter) && group) {
      const model = this.expanded ? group.sources[this.sourceIndex] : group.defaultSource;
      if (!model) {
        this.expanded = true;
        this.sourceIndex = 0;
        return { type: 'notice', tone: 'warning', text: '所有来源最近均失败；请选择具体来源，确认警告后仍可尝试。不会自动切换来源。' };
      }
      if (sourceUnhealthy(model) && this.warningKey !== modelIdentityKey(model)) {
        this.warningKey = modelIdentityKey(model);
        return { type: 'notice', tone: 'warning', text: `${model.brand}：${sourceHealthLabel(model)}；再次按 Enter 暂选，随后确认 Effort。` };
      }
      return { type: 'model', model };
    }
    const before = this.search.getValue();
    this.search.handleInput(data);
    if (this.search.getValue().length > 500) this.search.setValue(this.search.getValue().slice(0, 500));
    if (before !== this.search.getValue()) { this.selected = 0; this.expanded = false; this.warningKey = undefined; }
  }

  position(): string {
    const groups = this.groups();
    const total = this.expanded ? groups[this.selected]?.sources.length ?? 0 : groups.length;
    const index = this.expanded ? this.sourceIndex : this.selected;
    return total ? `${Math.min(index + 1, total)} / ${total}` : '0 / 0';
  }

  hint(): string {
    return this.expanded
      ? '↑↓ 来源 · Enter 暂选并确认 Effort · ←/Tab 收起 · Esc 返回'
      : `↑↓ 模型 · Enter 默认来源 · →/Tab 来源 · Ctrl+P 常用 · Ctrl+O ${this.showAll ? '常用' : '全部'} · Esc 关闭`;
  }

  render(width: number, rows: number, theme: VspiTheme): string[] {
    const groups = this.groups();
    const focused = groups[this.selected];
    const prefix = [
      `  ${theme.muted('搜索')} ${this.search.getValue() ? stripAnsi(this.search.getValue()) : theme.muted('模型名称 / ID / @provider')}${theme.inverse(' ')}`,
      theme.muted(`  ${this.showAll ? '全部模型' : '★ 常用 / ↺ 最近 / 官方常用'} · ${groups.length} 个模型 · ● 默认来源 · ⚠ 最近失败`),
      '',
    ];
    if (this.expanded && focused) return this.renderSources(focused, prefix, width, rows, theme);
    const entries: Array<{ text: string; selected?: boolean }> = [];
    let company = '';
    groups.forEach((group, index) => {
      const pinned = group.sources.some(source => this.picks.pinned.some(key => modelHasIdentity(source, key)));
      const recent = group.sources.some(source => this.picks.recent.some(key => modelHasIdentity(source, key)));
      const section = pinned || recent ? '★ 常用 / ↺ 最近' : group.company;
      if (section !== company) {
        if (company) entries.push({ text: '' });
        company = section;
        entries.push({ text: theme.bold(theme.muted(`  ${company}`)) });
      }
      const active = group.sources.some(source => modelHasIdentity(source, this.selectedKey));
      const name = `${index === this.selected ? '›' : ' '} ${pinned || group.sources.some(source => source.curated) ? '★' : recent ? '↺' : ' '} ${stripAnsi(group.label)}${active ? ' ✓' : ''}`;
      const chips = group.sources.map(source => {
        const label = `${stripAnsi(source.brand)}${sourceUnhealthy(source) ? ' ⚠' : source === group.defaultSource ? ' ●' : ''}`;
        return sourceUnhealthy(source) ? theme.muted(label) : source === group.defaultSource ? theme.focus(label) : theme.muted(label);
      }).join(theme.muted(' · '));
      const nameWidth = Math.min(34, Math.max(24, Math.floor(width * .34)));
      const hint = sourceContext(group.defaultSource);
      const main = width >= 100
        ? alignRight(`${padLine(name, nameWidth)} ${chips}`, theme.muted(hint), width)
        : `${name}  ${chips}`;
      entries.push({ text: main, selected: index === this.selected });
    });
    if (!entries.length) entries.push({ text: theme.muted('  没有匹配模型；Ctrl+O 显示全部模型') });
    const available = Math.max(1, rows - prefix.length - 2);
    const selectedRow = entries.findIndex(entry => entry.selected);
    const start = Math.max(0, Math.min(selectedRow - Math.floor(available / 2), entries.length - available));
    const body = entries.slice(start, start + available).map(entry => {
      const line = padLine(truncateToWidth(entry.text, width), width);
      return entry.selected ? theme.selected(line) : line;
    });
    while (body.length < available) body.push('');
    const footer = focused?.defaultSource ? `  ${focused.label} / ${focused.defaultSource.brand} · ${sourceContext(focused.defaultSource)} · ${sourcePrice(focused.defaultSource)}` : focused ? '  无健康默认来源 · → 选择具体来源' : '';
    return [...prefix, ...body, '', theme.muted(footer)].slice(0, rows).map(line => truncateToWidth(line, width));
  }

  private renderSources(group: CanonicalModelGroup, prefix: string[], width: number, rows: number, theme: VspiTheme): string[] {
    const header = [theme.bold(`  ${group.company} / ${stripAnsi(group.label)}`), theme.muted('  来源 · 健康 · USD / 1M 输入 / 输出 · 上次使用'), ''];
    const available = Math.max(1, rows - prefix.length - header.length - 4);
    const start = Math.max(0, Math.min(this.sourceIndex - Math.floor(available / 2), group.sources.length - available));
    const body = group.sources.slice(start, start + available).map((source, index) => {
      const key = modelIdentityKey(source);
      const used = this.picks.lastUsed?.[key];
      const lastUsed = used === undefined ? '未记录' : new Date(used).toLocaleDateString();
      const text = `  ${start + index === this.sourceIndex ? '›' : ' '} ${source === group.defaultSource ? '●' : '○'} ${stripAnsi(source.brand)}  ${sourceHealthLabel(source)}  ${sourcePrice(source)}  ${lastUsed}`;
      const line = padLine(truncateToWidth(sourceUnhealthy(source) ? theme.muted(text) : text, width), width);
      return start + index === this.sourceIndex ? theme.selected(line) : line;
    });
    while (body.length < available) body.push('');
    const source = group.sources[this.sourceIndex];
    const details = [
      theme.muted(`  ${stripAnsi(source?.alias ?? source?.id ?? '')} · ${sourceContext(source)}`),
      this.warningKey ? theme.warning('  ⚠ 再次 Enter 确认使用异常来源；不会自动切换') : theme.muted('  确认 Effort 后记住此模型的来源；Esc 不改变当前绑定'),
      theme.muted('  无手动记录时按 Provider 优先级选择，跳过异常来源'),
    ];
    return [...prefix, ...header, ...body, '', ...details].slice(0, rows).map(line => truncateToWidth(line, width));
  }
}
