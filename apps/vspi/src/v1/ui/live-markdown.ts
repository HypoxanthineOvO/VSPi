import { performance } from 'node:perf_hooks';
import { codeBody, codeHeader, renderMarkdown } from './markdown.js';
import { padLine, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from './ansi.js';
import type { TranscriptMessage } from '../domain/types.js';
import { attachmentSummary, deliveryStatus } from './transcript.js';
import type { TranscriptRenderOptions } from './transcript.js';
import type { VspiTheme } from './theme.js';

export const LIVE_TRANSCRIPT_MAX_ROWS = 200;
const SOURCE_BATCH_CHARS = 8192;
const BLOCK_CHARS = 4096;
const FRAME_LAYOUT_MS = 8;

type TextMessage = Extract<TranscriptMessage, { kind: 'text' | 'thinking' }>;

/** Native scrollback owns frozen rows. This cache retains only unwritten and visible rows. */
export class LiveMarkdown {
  private source = '';
  private offset = 0;
  private block = '';
  private line = '';
  private continuation = false;
  private fence: string | undefined;
  private fenceHeaderShown = false;
  private table: string | undefined;
  private tableHasRows = false;
  private tableHeaderPending = false;
  private continuationColumn = 0;
  private rows: string[] = [];
  private preview: string[] = [];
  private headerShown = false;
  private separatorSet = false;
  private width = 0;
  private message: TextMessage | undefined;
  private theme: VspiTheme | undefined;
  private options: TranscriptRenderOptions = {};
  private finalized = false;
  private footerKey: string | undefined;
  private footer: string[] = [];
  pending = false;
  version = 0;

  render(message: TextMessage, width: number, theme: VspiTheme, options: TranscriptRenderOptions, maxRows: number, previewRows: number): string[] {
    const source = message.kind === 'thinking' ? message.translatedText || message.text : message.role === 'assistant' ? message.text.trimStart() : message.text;
    const whitespaceTrim = source.length < this.source.length && this.source.startsWith(source) && !this.source.slice(source.length).trim();
    if (whitespaceTrim) this.offset = Math.min(this.offset, source.length);
    if (this.message && source !== this.source && !source.startsWith(this.source) && !whitespaceTrim) {
      this.version++;
      this.rows = [theme.muted(message.kind === 'thinking' ? '↳ 思考内容已更新' : '↳ 回复内容已更新')];
      this.offset = 0;
      this.block = '';
      this.line = '';
      this.fence = undefined;
      this.fenceHeaderShown = false;
      this.table = undefined;
      this.continuation = false;
      this.tableHasRows = false;
      this.finalized = false;
      this.footerKey = undefined;
      this.footer = [];
    }
    if (source !== this.source) this.finalized = false;
    this.message = message;
    this.source = source;
    this.theme = theme;
    this.options = options;
    if (this.width !== width) {
      const reflow = (row: string) => {
        const used = visibleWidth(stripAnsi(row).trimEnd());
        return wrapTextWithAnsi(truncateToWidth(row, used, ''), Math.max(1, width));
      };
      this.rows = this.rows.flatMap(reflow);
      this.footer = this.footer.flatMap(reflow);
      this.width = width;
    }
    const started = performance.now();
    const end = Math.min(this.source.length, this.offset + SOURCE_BATCH_CHARS);
    while (this.offset < end && this.rows.length < maxRows && performance.now() - started < FRAME_LAYOUT_MS) {
      const newline = this.source.indexOf('\n', this.offset);
      let stop = Math.min(newline < 0 ? this.source.length : newline, end, this.offset + BLOCK_CHARS - this.line.length);
      if (stop > this.offset && /[\uD800-\uDBFF]/u.test(this.source[stop - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(this.source[stop] ?? '')) stop--;
      if (message.streaming && stop === this.source.length && /[\uD800-\uDBFF]/u.test(this.source[stop - 1] ?? '')) stop--;
      if (stop === this.offset && this.line.length < BLOCK_CHARS - 1 && newline !== this.offset) break;
      this.line += this.source.slice(this.offset, stop);
      this.offset = stop;
      if (this.offset === newline) {
        this.offset++;
        this.consumeLine(this.line);
        this.line = '';
        this.continuation = false;
      } else if (this.line.length >= BLOCK_CHARS - 1) {
        this.flushBlock();
        this.ensureCodeHeader();
        this.append(this.renderFragment(this.line));
        this.line = '';
        this.continuation = true;
      }
    }
    if (!message.streaming && this.offset === this.source.length && !this.finalized) {
      if (this.line) this.consumeLine(this.line);
      this.line = '';
      this.flushBlock();
      this.closeTable();
      this.finalized = true;
    }
    this.preview = this.renderPreview();
    if (message.kind === 'text' && message.role === 'user' && this.offset === this.source.length) {
      const status = deliveryStatus(message);
      const labels = [...attachmentSummary(message), ...status ? [`↳ ${status}`] : []];
      const key = labels.join('\n');
      if (key !== this.footerKey) {
        this.footerKey = key;
        this.footer = [...this.decorate(labels), theme.userSurface(padLine('', width))];
        if (labels.length) this.headerShown = true;
      }
    }
    if (this.preview.length > Math.max(1, previewRows)) {
      this.promotePreview();
      this.preview = [];
    }
    const lines = [...this.rows.slice(0, maxRows)];
    if (lines.length < maxRows) lines.push(...this.preview.slice(0, maxRows - lines.length));
    if (lines.length < maxRows) lines.push(...this.footer.slice(0, maxRows - lines.length));
    this.pending = this.offset < this.source.length || this.rows.length + this.preview.length + this.footer.length > maxRows;
    if (message.streaming && !this.pending && lines.length) {
      const last = lines.at(-1)!;
      lines[lines.length - 1] = `${truncateToWidth(last, Math.max(0, width - 1), '')}${theme.focus('▋')}`;
    }
    return lines;
  }

  beginSection(gap: boolean): boolean {
    if (this.separatorSet) return false;
    this.separatorSet = true;
    if (gap) this.rows.unshift('');
    return gap;
  }

  freeze(count: number): void {
    if (count > this.rows.length && this.preview.length) this.promotePreview();
    const body = Math.min(count, this.rows.length);
    this.rows.splice(0, body);
    this.footer.splice(0, count - body);
  }

  beginViewport(): void {
    if (this.table) this.tableHeaderPending = true;
  }

  private append(lines: string[]): void {
    this.rows.push(...this.decorate(lines));
    if (lines.length) this.headerShown = true;
  }

  private decorate(lines: string[]): string[] {
    const theme = this.theme!;
    const first = !this.headerShown;
    const message = this.message!;
    if (message.kind === 'thinking') {
      const duration = message.durationMs === undefined ? '' : ` · ${(message.durationMs / 1000).toFixed(1)}s`;
      return [...first && lines.length ? [theme.muted(`◇  思考${duration}`)] : [], ...lines.map(line => `   ${line}`)];
    }
    const marker = message.presentation === 'formal' ? theme.focus(theme.capabilities.unicode ? '✦' : '*') : theme.muted(message.presentation === 'intermediate' ? '·' : '•');
    lines = lines.map(line => truncateToWidth(line, visibleWidth(stripAnsi(line).trimEnd()), ''));
    if (message.role === 'user') {
      const body = lines.map(line => theme.userSurface(padLine(`${theme.focus('▌')} ${line}`, this.width)));
      if (first && lines.length) body.unshift(theme.userSurface(padLine('', this.width)));
      return body;
    }
    const decorated = lines.map((line, index) => `${first && index === 0 ? `${marker} ` : '  '}${line}`);
    if (first && message.presentation === 'formal' && lines.length) decorated.unshift(theme.muted((theme.capabilities.unicode ? '─' : '-').repeat(this.width)));
    return decorated;
  }

  private renderFragment(text: string): string[] {
    const width = Math.max(1, this.width - 2);
    const theme = this.theme!;
    if (this.message?.role === 'user') return wrapTextWithAnsi(text, Math.max(1, this.width - 4));
    if (this.fence) {
      const language = this.fence.replace(/^\s*[`~]+/u, '').trim();
      const styled = this.message?.kind === 'thinking' ? text.split('\n').map(theme.thinking) : theme.markdown.highlightCode?.(text, language) ?? text.split('\n').map(theme.markdown.codeBlock);
      const lines = styled.flatMap(line => this.options.wrapCode === false ? [truncateToWidth(line, width, '')] : wrapTextWithAnsi(line, width));
      return lines.map(line => codeBody(line, width, theme, this.message?.kind === 'thinking' ? 'thinking' : undefined));
    }
    return renderMarkdown(text, width, theme, { wrapCode: this.options.wrapCode, streaming: this.message?.streaming, mermaidRendering: this.options.mermaidRendering, fixedTables: true, tone: this.message?.kind === 'thinking' ? 'thinking' : undefined });
  }

  private consumeLine(line: string): void {
    if (this.message?.role === 'user') { this.append(this.renderFragment(line)); return; }
    if (this.block && this.block.length + line.length + 1 > BLOCK_CHARS) this.flushBlock();
    if (this.continuation && this.table) {
      if (line.trim()) { this.ensureTableHeader(); this.block += `${this.tableContinuation(line)}\n`; this.flushBlock(); }
      return;
    }
    if (this.continuation) {
      this.ensureCodeHeader();
      this.append(this.renderFragment(line));
      return;
    }
    if (this.fence) {
      const marker = /^\s*([`~]{3,})/u.exec(this.fence)?.[1] ?? '```';
      if (new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`, 'u').test(line)) {
        if (!this.fenceHeaderShown && /^(?:`{3,}|~{3,})mermaid\s*$/iu.test(this.fence.trim()) && this.options.mermaidRendering !== 'off') {
          this.append(renderMarkdown(`${this.fence}\n${this.block}${line}`, Math.max(1, this.width - 2), this.theme!, { wrapCode: this.options.wrapCode, mermaidRendering: this.options.mermaidRendering }));
          this.block = '';
        } else { this.ensureCodeHeader(); this.flushBlock(); }
        this.fence = undefined;
        this.append(['']);
      } else {
        this.block += `${line}\n`;
        if (this.block.length >= BLOCK_CHARS / 2) this.flushBlock();
      }
      return;
    }
    if (this.table) {
      if (line.includes('|') && line.trim()) {
        this.ensureTableHeader();
        this.block += `${line}\n`;
        if (this.block.split('\n').length >= 5 || this.block.length >= BLOCK_CHARS / 2) this.flushBlock();
        return;
      }
      this.flushBlock();
      this.closeTable();
    }
    if (/^\s{0,3}([`~])\1{2,}/u.test(line)) {
      this.flushBlock();
      this.fence = line;
      this.fenceHeaderShown = false;
      return;
    }
    if (this.block.includes('|') && !this.block.trimEnd().includes('\n') && /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/u.test(line)) {
      this.table = `${this.block}${line}\n`;
      this.block = '';
      const table = this.renderTable('');
      this.append(table.head);
      this.tableHasRows = false;
      return;
    }
    this.block += `${line}\n`;
    if (!line.trim() || this.block.length >= BLOCK_CHARS) this.flushBlock();
  }

  private renderTable(body: string): { head: string[]; body: string[]; separator: string; bottom: string } {
    const lines = renderMarkdown(`${this.table}${body}`, Math.max(1, this.width - 2), this.theme!, { fixedTables: true, tone: this.message?.kind === 'thinking' ? 'thinking' : undefined });
    const middle = lines.findIndex(line => stripAnsi(line).trimStart().startsWith('├'));
    const bottom = lines.findLastIndex(line => stripAnsi(line).trimStart().startsWith('└'));
    if (middle < 0 || bottom < 0) return { head: this.renderFragment(this.table ?? ''), body: this.renderFragment(body), separator: '', bottom: '' };
    return { head: lines.slice(0, middle + 1), body: lines.slice(middle + 1, bottom), separator: lines[middle]!, bottom: lines[bottom]! };
  }

  private ensureTableHeader(): void {
    if (!this.tableHeaderPending) return;
    this.append(this.renderTable('').head);
    this.tableHeaderPending = false;
    this.tableHasRows = false;
  }

  private tableContinuation(text: string): string {
    const count = (this.table?.split('\n')[0]?.replace(/^\s*\||\|\s*$/gu, '').split('|').length ?? 1);
    const cells = Array<string>(count).fill('');
    cells[Math.min(count - 1, this.continuationColumn)] = text.replace(/\|\s*$/u, '');
    return `| ${cells.join(' | ')} |`;
  }

  private closeTable(): void {
    if (!this.table) return;
    const table = this.renderTable('');
    this.append([table.bottom, ''].filter(Boolean));
    this.table = undefined;
    this.tableHasRows = false;
  }

  private ensureCodeHeader(): void {
    if (this.fence && !this.fenceHeaderShown) {
      this.append([codeHeader(this.fence, Math.max(1, this.width - 2), this.theme!, this.message?.kind === 'thinking' ? 'thinking' : undefined)]);
      this.fenceHeaderShown = true;
    }
  }

  private flushBlock(): void {
    if (!this.block) return;
    this.ensureCodeHeader();
    if (this.table) {
      const table = this.renderTable(this.block);
      this.append([...this.tableHasRows && table.separator ? [table.separator] : [], ...table.body]);
      this.tableHasRows = true;
    } else {
      this.append(this.renderFragment(this.block.replace(/\n$/u, '')));
      if (!this.fence && /\n\s*\n$/u.test(this.block)) this.append(['']);
    }
    this.block = '';
  }

  private renderPreview(): string[] {
    const text = this.block + this.line;
    if (this.table) {
      if (this.tableHeaderPending && !text) return [];
      const table = this.renderTable(this.continuation ? this.tableContinuation(text) : text);
      return this.decorate([...this.tableHeaderPending ? table.head : [], ...this.tableHasRows && text && table.separator ? [table.separator] : [], ...table.body, table.bottom].filter(Boolean));
    }
    if (this.fence) return this.decorate([...this.fenceHeaderShown ? [] : [codeHeader(this.fence, Math.max(1, this.width - 2), this.theme!, this.message?.kind === 'thinking' ? 'thinking' : undefined)], ...text ? this.renderFragment(text) : []]);
    return text ? this.decorate(this.renderFragment(text)) : [];
  }

  private promotePreview(): void {
    if (this.fence) this.fenceHeaderShown = true;
    if (this.table) {
      const last = (this.block + this.line).trimEnd().split('\n').at(-1) ?? '';
      this.continuationColumn = Math.max(0, last.replace(/^\s*\|/u, '').split(/(?<!\\)\|/u).length - 1);
      this.tableHeaderPending = false;
      const table = this.renderTable('');
      if (this.preview.at(-1)?.includes(table.bottom.trimEnd())) this.preview.pop();
      this.tableHasRows = true;
    }
    this.rows.push(...this.preview);
    if (this.preview.length) this.headerShown = true;
    this.block = '';
    this.line = '';
    this.continuation = true;
    this.preview = [];
  }
}
