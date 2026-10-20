import hljs from 'highlight.js';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptMessage } from '../src/v1/domain/types.js';
import { stripAnsi } from '../src/v1/ui/ansi.js';
import { detectTerminalCapabilities } from '../src/v1/ui/capabilities.js';
import { LiveMarkdown } from '../src/v1/ui/live-markdown.js';
import { createTheme } from '../src/v1/ui/theme.js';

const theme = createTheme(detectTerminalCapabilities({ TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8' }), 'VSPi Dark');
type Message = Extract<TranscriptMessage, { kind: 'text' }>;

function drain(layout: LiveMarkdown, message: Message, width = 80): string[] {
  const output: string[] = [];
  for (let frame = 0; frame < 1000; frame++) {
    const rows = layout.render(message, width, theme, { wrapCode: true }, 200, 4);
    output.push(...rows);
    layout.freeze(rows.length);
    if (!layout.pending) return output;
  }
  throw new Error('Markdown layout did not finish draining');
}

function content(lines: string[]): string {
  return lines.map(line => stripAnsi(line).replace(/^[•·✦] /u, '').replace(/^  /u, '').replaceAll(/[│┌┐└┘├┤┬┴─┼]/gu, '')).join('').replaceAll(/\s+/gu, '');
}

describe('native Markdown table continuations', () => {
  it.each(['Column', 'Col\\|umn'])('preserves every cell after an oversized row under %s', header => {
    const layout = new LiveMarkdown();
    const values = Array.from({ length: 1800 }, (_, index) => `TOKEN${String(index).padStart(4, '0')}`);
    const text = `| ${header} | Value |\n| --- | --- |\n| FIRST_CELL | ${values.join(' ')} |\n| LAST_ROW | LAST_VALUE |`;
    const message: Message = { id: 'table', role: 'assistant', kind: 'text', text, streaming: false };
    const rendered = content(drain(layout, message));
    for (const value of values) expect(rendered.split(value)).toHaveLength(2);
    expect(rendered.split('LAST_ROW')).toHaveLength(2);
    expect(rendered.split('LAST_VALUE')).toHaveLength(2);
    expect(message.text).toBe(text);
  });

  it('keeps an escaped pipe split across streaming updates after its cell has scrolled away', () => {
    const layout = new LiveMarkdown();
    const prefix = '| Column | Value |\n| --- | --- |\n| FIRST_CELL | ' + 'long cell '.repeat(100) + '\\';
    const message: Message = { id: 'stream', role: 'assistant', kind: 'text', text: prefix, streaming: true };
    const printed = drain(layout, message);
    layout.beginViewport();
    printed.push(...drain(layout, { ...message, text: prefix + '|ESCAPED_MARKER |\n| NEXT_ROW | NEXT_VALUE |', streaming: false }, 60));
    const rendered = content(printed);
    expect(rendered.split('ESCAPED_MARKER')).toHaveLength(2);
    expect(rendered.split('NEXT_ROW')).toHaveLength(2);
    expect(rendered.split('NEXT_VALUE')).toHaveLength(2);
  });

  it('recovers normal Markdown parsing after a long table ends', () => {
    const layout = new LiveMarkdown();
    const text = '| Key | Value |\n| --- | --- |\n| FIRST | ' + 'source '.repeat(1000) + ' |\n\n| Small | Table |\n| --- | --- |\n| SMALL_ROW | SMALL_VALUE |';
    const rows = drain(layout, { id: 'next-table', role: 'assistant', kind: 'text', text, streaming: false }).map(stripAnsi);
    expect(rows.some(row => row.includes('│ SMALL_ROW') && row.includes('SMALL_VALUE'))).toBe(true);
  });
});


describe('native Markdown code headers', () => {
  it.each(['', 'unknown-language'])('never auto-detects %s fences, including completed theme rendering', language => {
    const auto = vi.spyOn(hljs, 'highlightAuto');
    const known = vi.spyOn(hljs, 'highlight');
    try {
      const code = 'const example = "<value> & example";';
      const layout = new LiveMarkdown();
      const message: Message = { id: 'plain-code', role: 'assistant', kind: 'text', text: `\`\`\`${language}\n${code}`, streaming: true };
      expect(content(drain(layout, message))).toContain(code.replaceAll(/\s+/gu, ''));
      drain(layout, { ...message, text: message.text + '\n```', streaming: false });
      expect(theme.markdown.highlightCode?.(code, language).map(stripAnsi)).toEqual([code]);
      expect(theme.thinkingMarkdown.highlightCode?.(code, language).map(stripAnsi)).toEqual([code]);
      expect(auto).not.toHaveBeenCalled();
      expect(known).not.toHaveBeenCalled();
      theme.markdown.highlightCode?.(code, 'typescript');
      expect(known).toHaveBeenCalledOnce();
    } finally { auto.mockRestore(); known.mockRestore(); }
  });

  it.each(['', 'unknown-language'])('emits every row of a 1000-line %s fence exactly once', language => {
    const markers = Array.from({ length: 1000 }, (_, index) => `CODE_ROW_${String(index).padStart(4, '0')}`);
    const layout = new LiveMarkdown();
    const message: Message = { id: 'large-plain-fence', role: 'assistant', kind: 'text', text: `\`\`\`${language}\n${markers.join('\n')}`, streaming: true };
    const rows = drain(layout, message);
    rows.push(...drain(layout, { ...message, text: message.text + '\n```', streaming: false }));
    const rendered = content(rows);
    for (const marker of markers) expect(rendered.split(marker)).toHaveLength(2);
  });

  it('caches unchanged previews and invalidates them for source and width changes', () => {
    const localTheme = createTheme(theme.capabilities);
    const highlight = vi.spyOn(localTheme.markdown, 'highlightCode');
    const layout = new LiveMarkdown();
    const message: Message = { id: 'cached-preview', role: 'assistant', kind: 'text', text: '```typescript\nconst example = 1;', streaming: true };
    const first = layout.render(message, 80, localTheme, {}, 200, 20);
    expect(layout.render(message, 80, localTheme, {}, 200, 20)).toEqual(first);
    expect(highlight).toHaveBeenCalledOnce();
    layout.render({ ...message, text: message.text + '2' }, 80, localTheme, {}, 200, 20);
    expect(highlight).toHaveBeenCalledTimes(2);
    layout.render({ ...message, text: message.text + '2' }, 60, localTheme, {}, 200, 20);
    expect(highlight).toHaveBeenCalledTimes(3);
    const changedTheme = createTheme(theme.capabilities, 'VSPi Light');
    const changedHighlight = vi.spyOn(changedTheme.markdown, 'highlightCode');
    const updated = { ...message, text: message.text + '2' };
    layout.render(updated, 60, changedTheme, {}, 200, 20);
    expect(changedHighlight).toHaveBeenCalledOnce();
    layout.render(updated, 60, changedTheme, { wrapCode: false }, 200, 20);
    expect(changedHighlight).toHaveBeenCalledTimes(2);
    layout.render(updated, 60, changedTheme, { wrapCode: false }, 200, 20);
    expect(changedHighlight).toHaveBeenCalledTimes(2);
  });
  it.each([{ fence: '```', streaming: false }, { fence: '~~~', streaming: true }])('removes $fence from the language label while streaming=$streaming', ({ fence, streaming }) => {
    const layout = new LiveMarkdown();
    const text = `${fence}typescript\nconst value = 1;${streaming ? '' : `\n${fence}`}`;
    const rows = drain(layout, { id: 'fence', role: 'assistant', kind: 'text', text, streaming }).map(stripAnsi);
    const header = rows.find(row => row.includes('typescript'));
    expect(header).toBeDefined();
    expect(header).not.toContain(fence);
  });
});

describe('native Markdown streaming cursor', () => {
  it.each(['x'.repeat(77) + 'Z', '中'.repeat(38) + 'AZ'])('keeps the last source character on a full-width row after it freezes', text => {
    const layout = new LiveMarkdown();
    const message: Message = { id: 'full-row', role: 'assistant', kind: 'text', text, streaming: true };
    const printed = drain(layout, message);
    layout.beginViewport();
    printed.push(...drain(layout, { ...message, streaming: false }, 60));
    expect(content(printed).split('Z')).toHaveLength(2);
    expect(content(printed)).toContain(text);
  });
});
