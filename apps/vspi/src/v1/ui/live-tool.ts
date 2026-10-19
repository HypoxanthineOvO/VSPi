import { performance } from 'node:perf_hooks';
import type { TranscriptMessage } from '../domain/types.js';
import { stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from './ansi.js';
import type { VspiTheme } from './theme.js';

const SOURCE_BATCH_CHARS = 8192;
const CHUNK_CHARS = 4096;
const FRAME_LAYOUT_MS = 8;
type ToolMessage = Extract<TranscriptMessage, { kind: 'tool' }>;

export interface ToolOutputPosition {
  line: number;
  continuation: boolean;
  revision: number;
}

function completeAnsiPrefix(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\x1b') continue;
    const start = index;
    const introducer = text[++index];
    if (introducer === undefined) return start;
    if (introducer === '[') {
      while (++index < text.length && !/[@-~]/.test(text[index]!)) {}
      if (index === text.length) return start;
    } else if (introducer === ']' || introducer === '_') {
      while (++index < text.length && text[index] !== '\x07' && !(text[index] === '\x1b' && text[index + 1] === '\\')) {}
      if (index === text.length) return start;
      if (text[index] === '\x1b') index++;
    }
  }
  return text.length;
}

export class LiveTool {
  private source = '';
  private offset = 0;
  private line = '';
  private rows: string[] = [];
  private preview: string[] = [];
  private header: string[] = [];
  private frozenHeaderRows = 0;
  private headerFrozen = false;
  private notices: string[] = [];
  private leading: string[] = [];
  private separatorSet = false;
  private frozen = false;
  private continuation = false;
  private sourceLine = 0;
  private discardedEscape: '[' | ']' | '_' | undefined;
  private discardedStringEscape = false;
  private width = 0;
  private status: ToolMessage['status'] | undefined;
  pending = false;
  version = 0;

  render(message: ToolMessage, width: number, theme: VspiTheme, maxRows: number, previewRows: number, header: readonly string[], formatOutput: (text: string, position: ToolOutputPosition) => string[]): string[] {
    const source = message.expanded ? message.output ?? '' : '';
    const replacement = source !== this.source && !source.startsWith(this.source);
    if (replacement) {
      this.version++;
      this.offset = 0;
      this.line = '';
      this.continuation = false;
      this.sourceLine = 0;
      this.discardedEscape = undefined;
      this.discardedStringEscape = false;
      this.rows = [];
      this.preview = [];
      if (this.frozen && message.expanded) this.notices.push(...wrapTextWithAnsi(theme.muted(`↳ ${message.name} 输出已更新`), Math.max(1, width)));
    }
    this.source = source;
    this.header = this.headerFrozen ? [] : header.slice(this.frozenHeaderRows);
    if (this.status !== undefined && this.status !== message.status && this.frozenHeaderRows > 0 && message.status !== 'running' && message.status !== 'queued') {
      const summary = truncateToWidth(`${message.name.slice(0, 100)} · ${message.summary.slice(0, Math.max(256, width * 4))}`, Math.max(1, width * 3 - 2), '…');
      const marker = message.status === 'success' ? '✓' : '↳';
      this.notices.push(...wrapTextWithAnsi(theme.muted(`${marker} ${summary}`), Math.max(1, width)).slice(0, 3));
    }
    this.status = message.status;
    if (this.width !== width) {
      const reflow = (row: string) => wrapTextWithAnsi(truncateToWidth(row, visibleWidth(stripAnsi(row).trimEnd()), ''), Math.max(1, width));
      this.rows = this.rows.flatMap(reflow);
      this.notices = this.notices.flatMap(reflow);
      this.width = width;
    }
    const available = Math.max(0, maxRows - this.leading.length - this.header.length - this.notices.length);
    const end = Math.min(source.length, this.offset + SOURCE_BATCH_CHARS);
    const started = performance.now();
    const format = (text: string) => formatOutput(text, { line: this.sourceLine, continuation: this.continuation, revision: this.version });
    while (this.offset < end && this.rows.length < available && performance.now() - started < FRAME_LAYOUT_MS) {
      if (this.discardedEscape) {
        const character = source[this.offset++]!;
        const done = this.discardedEscape === '[' ? /[@-~]/.test(character) : character === '\x07' || this.discardedStringEscape && character === '\\';
        this.discardedStringEscape = character === '\x1b';
        if (done) { this.discardedEscape = undefined; this.discardedStringEscape = false; }
        continue;
      }
      const limit = Math.min(end, this.offset + CHUNK_CHARS - this.line.length);
      const found = source.slice(this.offset, limit).indexOf('\n');
      const newline = found < 0 ? -1 : this.offset + found;
      let stop = newline < 0 ? limit : newline;
      if (stop > this.offset && /[\uD800-\uDBFF]/u.test(source[stop - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(source[stop] ?? '')) stop--;
      if (stop === source.length && (message.status === 'running' || message.status === 'queued') && /[\uD800-\uDBFF]/u.test(source[stop - 1] ?? '')) stop--;
      if (stop === this.offset && this.line.length < CHUNK_CHARS - 1 && newline !== this.offset) break;
      this.line += source.slice(this.offset, stop);
      this.offset = stop;
      if (this.offset === newline) {
        this.offset++;
        if (this.line || !this.continuation) this.rows.push(...format(this.line.slice(0, completeAnsiPrefix(this.line))));
        this.line = '';
        this.continuation = false;
        this.sourceLine++;
      } else if (this.line.length >= CHUNK_CHARS - 1) {
        const safeEnd = completeAnsiPrefix(this.line);
        if (safeEnd > 0) {
          this.rows.push(...format(this.line.slice(0, safeEnd)));
          this.line = this.line.slice(safeEnd);
          this.continuation = true;
        } else {
          this.discardedEscape = this.line[1] as '[' | ']' | '_';
          this.discardedStringEscape = this.line.endsWith('\x1b');
          this.line = '';
        }
      }
    }
    if (this.offset === source.length && message.status !== 'running' && message.status !== 'queued' && this.line && this.rows.length < available) {
      this.rows.push(...format(this.line.slice(0, completeAnsiPrefix(this.line))));
      this.line = '';
    }
    const awaitingSurrogate = this.offset === source.length - 1 && (message.status === 'running' || message.status === 'queued') && /[\uD800-\uDBFF]/u.test(source[this.offset] ?? '');
    this.preview = this.line && (this.offset === source.length || awaitingSurrogate) && this.rows.length < available ? format(this.line.slice(0, completeAnsiPrefix(this.line))) : [];
    if (this.preview.length > Math.max(1, previewRows)) this.promotePreview();
    const lines = [...this.leading, ...this.header, ...this.notices, ...this.rows, ...this.preview];
    this.pending = this.offset < source.length && !awaitingSurrogate || lines.length > maxRows || Boolean(this.line && this.preview.length === 0);
    return lines.slice(0, maxRows);
  }

  beginSection(gap: boolean): boolean {
    if (this.separatorSet) return false;
    this.separatorSet = true;
    if (gap) this.leading = [''];
    return gap;
  }

  freeze(count: number): void {
    if (count <= 0) return;
    this.frozen = true;
    const leading = Math.min(count, this.leading.length);
    this.leading.splice(0, leading);
    count -= leading;
    const header = Math.min(count, this.header.length);
    this.header.splice(0, header);
    this.frozenHeaderRows += header;
    if (header > 0 && this.header.length === 0) this.headerFrozen = true;
    count -= header;
    const notices = Math.min(count, this.notices.length);
    this.notices.splice(0, notices);
    count -= notices;
    if (count > this.rows.length && this.preview.length > 0) this.promotePreview();
    this.rows.splice(0, count);
  }

  beginViewport(): void {}

  private promotePreview(): void {
    this.rows.push(...this.preview);
    this.preview = [];
    this.line = '';
    this.continuation = true;
  }
}
