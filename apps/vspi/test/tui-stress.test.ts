import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { VirtualTerminal } from '../../../packages/pi-tui/test/virtual-terminal.js';
import { VspiApp } from '../src/v1/app/vspi-app.js';
import { AttachmentService } from '../src/v1/attachments/service.js';
import type { ChatBackend, ChatBackendEvents } from '../src/v1/backend/types.js';
import { DEFAULT_SETTINGS } from '../src/v1/domain/defaults.js';
import { ScrollbackTUI } from '../src/v1/ui/scrollback-terminal.js';
import { detectTerminalCapabilities } from '../src/v1/ui/capabilities.js';
import { createTheme } from '../src/v1/ui/theme.js';
import { LIVE_TRANSCRIPT_MAX_ROWS } from '../src/v1/ui/live-markdown.js';

class MeasuredTUI extends ScrollbackTUI {
  readonly times: number[] = [];
  protected override doRender(): void {
    const started = performance.now();
    super.doRender();
    this.times.push(performance.now() - started);
  }
}

async function fixture(scrollback = 20000, shellHistory?: string, thinkingDisplay = DEFAULT_SETTINGS.thinkingDisplay) {
  const home = await mkdtemp(join(tmpdir(), 'vspi-tui-pressure-'));
  const terminal = new VirtualTerminal(80, 24, scrollback);
  const tui = new MeasuredTUI(terminal);
  const theme = createTheme(detectTerminalCapabilities({ TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8' }), 'VSPi Dark');
  let events: ChatBackendEvents | undefined;
  const backend: ChatBackend = {
    kind: 'runtime', modelId: 'example/model', modelLabel: 'Example', supportsVision: false,
    start: async listener => { events = listener; }, dispose: async () => {}, send: async () => {}, cancel: async () => {}, compact: async () => false,
    newSession: async () => {}, listSessions: async () => [], switchSession: async () => {},
    setPolicy: async policy => ({ policy, boundary: 'Host', sandboxed: false, recovery: false, sessionAllowlist: [] }),
  };
  const app = new VspiApp(tui, theme, backend, { cwd: '/workspace', home, settings: { ...DEFAULT_SETTINGS, thinkingDisplay, summarizeSessionTitleOnExit: false }, attachments: new AttachmentService('pressure-test', theme, { home }), onExit() {} });
  const heights: number[] = [];
  const render = app.render.bind(app);
  app.render = width => { const lines = render(width); heights.push(lines.length); return lines; };
  tui.addChild(app); tui.setFocus(app);
  if (shellHistory) { terminal.write(shellHistory); await terminal.flush(); }
  await app.start();
  tui.start();
  return { app, tui, terminal, theme, heights, events: events!, async close() { tui.stop(); await app.dispose(); await rm(home, { recursive: true, force: true }); } };
}

async function report(name: string, metrics: Record<string, unknown>): Promise<void> {
  if (process.env.VSPI_PRESSURE_REPORT) await appendFile(process.env.VSPI_PRESSURE_REPORT, `${JSON.stringify({ name, ...metrics })}\n`);
}

function counts(terminal: VirtualTerminal, pattern: RegExp): Map<string, number> {
  const found = new Map<string, number>();
  for (const row of terminal.getScrollBuffer()) {
    for (const match of row.matchAll(pattern)) found.set(match[0], (found.get(match[0]) ?? 0) + 1);
  }
  return found;
}

async function flushUntil(terminal: VirtualTerminal, assertion: () => void, timeout = 10000): Promise<void> {
  await vi.waitFor(async () => { await terminal.flush(); assertion(); }, { timeout, interval: 25 });
}

describe('bounded native transcript pressure', () => {
  it('prints every row of a 12000-line code reply and keeps append work independent of its frozen prefix', async () => {
    const f = await fixture();
    const source = '```text\n' + Array.from({ length: 12000 }, (_, index) => `CODE_${String(index).padStart(5, '0')} original content`).join('\n');
    const highlighter = vi.spyOn(f.theme.markdown, 'highlightCode');
    try {
      f.events.onBusy(true);
      f.events.onMessage({ id: 'code', role: 'assistant', kind: 'text', text: source, streaming: true });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('CODE_11999'));
      const found = counts(f.terminal, /CODE_\d{5}/g);
      expect(found.size).toBe(12000);
      expect([...found.values()].every(count => count === 1)).toBe(true);
      expect(Math.max(...f.heights)).toBeLessThanOrEqual(LIVE_TRANSCRIPT_MAX_ROWS + 40);
      expect(Math.max(...highlighter.mock.calls.map(([text]) => text.length))).toBeLessThanOrEqual(4096);
      const draft = '长草稿 '.repeat(10000);
      f.app.composer.setText(draft); f.tui.renderNow(); await f.terminal.flush();
      const samples: number[] = [];
      let text = source;
      for (let index = 0; index < 30; index++) {
        text += `\nAPPEND_${String(index).padStart(3, '0')}`;
        const started = performance.now();
        f.terminal.sendInput('字'); f.events.onMessageUpdate('code', { text });
        f.tui.renderNow(); samples.push(performance.now() - started);
        await f.terminal.flush();
      }
      text += '\n```';
      f.events.onMessageUpdate('code', { text, streaming: false });
      f.events.onBusy(false);
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('APPEND_029'));
      expect([...counts(f.terminal, /CODE_\d{5}/g).values()].every(count => count === 1)).toBe(true);
      expect((f.app as unknown as { messages: { id: string; text?: string }[] }).messages.find(message => message.id === 'code')?.text).toBe(text);
      samples.sort((a, b) => a - b);
      expect(samples[15]).toBeLessThan(33);
      expect(f.app.composer.getText()).toBe(draft + '字'.repeat(30));
      await report('12000-line-reply', { rows: found.size, maximumFrameRows: Math.max(...f.heights), appendMedianMs: samples[15], appendP95Ms: samples[28], draftCharacters: f.app.composer.getText().length, peakHighlightChars: Math.max(...highlighter.mock.calls.map(([value]) => value.length)) });
    } finally { highlighter.mockRestore(); await f.close(); }
  }, 30000);

  it('keeps streaming table rows unique while dictation and width/height changes overlap', async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.terminal, 'write');
    try {
      f.events.onBusy(true);
      let text = '| Item | Value |\n| --- | --- |\n' + Array.from({ length: 50 }, (_, index) => `| CELL_${String(index).padStart(3, '0')} | value |`).join('\n');
      f.events.onMessage({ id: 'table', role: 'assistant', kind: 'text', text, streaming: true });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('CELL_049'));
      let draft = '';
      for (let index = 0; index < 8; index++) {
        text += `\n| CELL_${String(index + 50).padStart(3, '0')} | ${'更长的内容 '.repeat(index + 1)} |`;
        f.events.onMessageUpdate('table', { text });
        const words = `语音输入${index}。`; draft += words; f.terminal.sendInput(words);
        await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain(`CELL_${String(index + 50).padStart(3, '0')}`));
      }
      let expectedRows = 58;
      for (const [width, height] of [[60, 24], [100, 40], [80, 12], [80, 30], [40, 24], [100, 50]]) {
        f.terminal.resize(width!, height!);
        if (width === 60) f.tui.requestRender(true);
        const marker = `CELL_${String(expectedRows).padStart(3, '0')}`;
        text += `\n| ${marker} | after resize |`;
        expectedRows++;
        f.events.onMessageUpdate('table', { text });
        await new Promise(resolve => { setTimeout(resolve, 450); });
        await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain(marker));
        const found = counts(f.terminal, /CELL_\d{3}/g);
        expect(found.size).toBe(expectedRows);
        expect([...found.values()].every(count => count === 1), `${width}x${height}`).toBe(true);
        expect(f.app.composer.getText()).toBe(draft);
      }
      expect(writes.mock.calls.some(([chunk]) => chunk.includes('\x1b[2J') || chunk.includes('\x1b[3J'))).toBe(false);
      await report('streaming-table-and-dictation', { uniqueRows: expectedRows, resizeSteps: 6, draftCharacters: draft.length, historyClears: 0 });
    } finally { writes.mockRestore(); await f.close(); }
  }, 15000);

  it('retains pre-existing shell history and all reply markers across resize bursts', async () => {
    const f = await fixture(20000, 'EXTERNAL_SHELL_HISTORY\r\n');
    try {
      f.events.onMessage({ id: 'answer', role: 'assistant', kind: 'text', text: Array.from({ length: 300 }, (_, index) => `HISTORY_${String(index).padStart(3, '0')}`).join('\n\n'), streaming: false });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('HISTORY_299'));
      const reflows = vi.spyOn(f.tui, 'reflowViewport');
      for (let index = 0; index < 30; index++) {
        f.terminal.resize(79 - index, 24 + index % 3);
        f.terminal.sendInput('a');
        await new Promise(resolve => { setTimeout(resolve, 15); });
      }
      await flushUntil(f.terminal, () => expect(reflows).toHaveBeenCalledTimes(1));
      expect(f.terminal.getScrollBuffer().join('\n')).toContain('EXTERNAL_SHELL_HISTORY');
      const found = counts(f.terminal, /HISTORY_\d{3}/g);
      expect(found.size).toBe(300);
      expect([...found.values()].every(count => count === 1), JSON.stringify([...found].filter(([,count])=>count!==1))).toBe(true);
      expect(f.app.composer.getText()).toBe('a'.repeat(30));
      await report('resize-burst', { historyRows: 300, resizeEvents: 30, viewportReflows: reflows.mock.calls.length });
    } finally { await f.close(); }
  }, 15000);

  it('drains an over-limit message burst before frontend retention removes already printed messages', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 1200; index++) f.events.onMessage({ id: `burst-${index}`, role: 'assistant', kind: 'text', text: `BURST_${String(index).padStart(4, '0')}`, streaming: false });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('BURST_1199'));
      const found = counts(f.terminal, /BURST_\d{4}/g);
      expect(found.size).toBe(1200);
      expect([...found.values()].every(count => count === 1)).toBe(true);
      expect((f.app as unknown as { messages: unknown[] }).messages.length).toBeLessThanOrEqual(1000);
      await report('message-burst', { rows: found.size, keptFrontendMessages: (f.app as unknown as { messages: unknown[] }).messages.length });
    } finally { await f.close(); }
  }, 15000);

  it('emits expanded thinking beyond the old character cap without omitting its beginning', async () => {
    const f = await fixture(20000, undefined, 'expanded');
    try {
      const text = Array.from({ length: 5000 }, (_, index) => `THINK_${String(index).padStart(5, '0')} ${'reasoning '.repeat(6)}`).join('\n\n');
      expect(text.length).toBeGreaterThan(200000);
      f.events.onMessage({ id: 'thinking', role: 'assistant', kind: 'thinking', text, effort: 'high', collapsed: false, streaming: true });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('THINK_04999'));
      const found = counts(f.terminal, /THINK_\d{5}/g);
      expect(found.size).toBe(5000);
      expect([...found.values()].every(count => count === 1)).toBe(true);
      await report('expanded-thinking', { characters: text.length, rows: found.size });
    } finally { await f.close(); }
  }, 20000);

  it('announces completion of a frozen grouped tool even while another tool remains running', async () => {
    const f = await fixture();
    try {
      f.events.onMessage({ id: 'first', role: 'assistant', kind: 'tool', name: 'Shell', groupId: 'pending', summary: 'Still running', status: 'running', expanded: true });
      f.events.onMessage({ id: 'second', role: 'assistant', kind: 'tool', name: 'Shell', groupId: 'pending', summary: 'Will finish', status: 'running', expanded: true });
      for (let index = 0; index < 80; index++) f.events.onMessage({ id: `following-${index}`, role: 'assistant', kind: 'text', text: `FOLLOWING_${index}`, streaming: false });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('FOLLOWING_79'));
      f.events.onMessageUpdate('second', { status: 'success', summary: 'GROUP_COMPLETION_MARKER' });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('GROUP_COMPLETION_MARKER'));
      for (let index = 0; index < 40; index++) {
        f.terminal.sendInput('x');
        await new Promise(resolve => { setTimeout(resolve, 5); });
      }
      await f.terminal.flush();
      expect(f.terminal.getScrollBuffer().filter(row => row.includes('GROUP_COMPLETION_MARKER'))).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('keeps frozen tool positions when an earlier stream temporarily consumes the frame budget', async () => {
    const f = await fixture();
    try {
      f.events.onMessage({ id: 'early-stream', role: 'assistant', kind: 'text', text: 'Earlier stream\n\n', streaming: true });
      f.events.onMessage({ id: 'queued-tool', role: 'assistant', kind: 'tool', name: 'Shell', summary: 'Output', expanded: true, status: 'running', output: Array.from({ length: 100 }, (_, index) => `POSITION_${String(index).padStart(3, '0')}`).join('\n') });
      f.events.onMessage({ id: 'after-position', role: 'assistant', kind: 'text', text: 'POSITION_READY', streaming: false });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('POSITION_READY'));
      f.events.onMessageUpdate('early-stream', { text: 'Earlier stream\n\n' + Array.from({ length: 1000 }, (_, index) => `EARLY_${String(index).padStart(4, '0')}`).join('\n\n'), streaming: false });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('EARLY_0999'));
      await new Promise(resolve => { setTimeout(resolve, 150); }); await f.terminal.flush();
      const found = counts(f.terminal, /POSITION_\d{3}/g);
      expect(found.size).toBe(100);
      expect([...found.values()].every(count => count === 1)).toBe(true);
    } finally { await f.close(); }
  });

  it('drains an expanded running tool without starving later output or exceeding the frame budget', async () => {
    const f = await fixture();
    try {
      f.events.onMessage({ id: 'verbose-tool', role: 'assistant', kind: 'tool', name: 'Shell', summary: 'Long output', expanded: true, status: 'running', output: Array.from({ length: 500 }, (_, index) => `TOOL_ROW_${String(index).padStart(3, '0')} ${"long output ".repeat(10)}`).join('\n') });
      for (let index = 0; index < 30; index++) f.events.onMessage({ id: `after-tool-${index}`, role: 'assistant', kind: 'text', text: `AFTER_TOOL_${index}`, streaming: false });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('AFTER_TOOL_29'));
      const found = counts(f.terminal, /TOOL_ROW_\d{3}/g);
      expect(found.size).toBe(500);
      expect([...found.values()].every(count => count === 1)).toBe(true);
      f.terminal.resize(50, 24);
      await new Promise(resolve => { setTimeout(resolve, 450); }); await f.terminal.flush();
      expect([...counts(f.terminal, /TOOL_ROW_\d{3}/g).values()].every(count => count === 1)).toBe(true);
      expect(Math.max(...f.heights)).toBeLessThanOrEqual(LIVE_TRANSCRIPT_MAX_ROWS + 40);
      await report('expanded-tool', { rows: found.size, maximumFrameRows: Math.max(...f.heights) });
    } finally { await f.close(); }
  });

  it('keeps unwritten batches when the dock exceeds a tiny viewport and the terminal grows again', async () => {
    const f = await fixture();
    try {
      f.terminal.resize(80, 4);
      const text = Array.from({ length: 800 }, (_, index) => `TINY_${String(index).padStart(3, '0')}`).join('\n\n');
      f.events.onMessage({ id: 'tiny', role: 'assistant', kind: 'text', text, streaming: true });
      await new Promise(resolve => { setTimeout(resolve, 700); });
      f.events.onMessageUpdate('tiny', { streaming: false });
      f.terminal.resize(80, 24);
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('TINY_799'));
      const found = counts(f.terminal, /TINY_\d{3}/g);
      expect(found.size).toBe(800);
      expect([...found.values()].every(count => count === 1)).toBe(true);
    } finally { await f.close(); }
  });

  it('keeps a long user message, attachment caption and delivery updates without replaying the input', async () => {
    const f = await fixture();
    try {
      const text = Array.from({ length: 500 }, (_, index) => `USER_${String(index).padStart(3, '0')}`).join('\n');
      f.events.onMessage({ id: 'user', role: 'user', kind: 'text', text, deliveryState: 'started', attachments: [{ id: 'image', alias: 'IMAGE_EXAMPLE', width: 1, height: 1, size: 1, mimeType: 'image/png', path: '/example/image.png', status: 'ready' }] });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('IMAGE_EXAMPLE'));
      expect(f.terminal.getScrollBuffer().join('\n')).toContain('已送达模型');
      f.events.onMessageUpdate('user', { deliveryState: 'completed' });
      await new Promise(resolve => { setTimeout(resolve, 100); }); await f.terminal.flush();
      const found = counts(f.terminal, /USER_\d{3}/g);
      expect(found.size).toBe(500);
      expect([...found.values()].every(count => count === 1)).toBe(true);
    } finally { await f.close(); }
  });

  it('does not treat a final whitespace normalization as a replacement of the entire reply', async () => {
    const f = await fixture();
    try {
      const text = Array.from({ length: 200 }, (_, index) => `WHITE_${String(index).padStart(3, '0')}`).join('\n\n');
      f.events.onMessage({ id: 'whitespace', role: 'assistant', kind: 'text', text: `\n\n${text}\n\n`, streaming: true });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('WHITE_199'));
      f.events.onMessageUpdate('whitespace', { text, streaming: false });
      await new Promise(resolve => { setTimeout(resolve, 100); }); await f.terminal.flush();
      const found = counts(f.terminal, /WHITE_\d{3}/g);
      expect(found.size).toBe(200);
      expect([...found.values()].every(count => count === 1)).toBe(true);
      expect(f.terminal.getScrollBuffer().join('\n')).not.toContain('内容已更新');
    } finally { await f.close(); }
  });

  it('keeps forced redraws safe by archiving the visible content once', async () => {
    const f = await fixture();
    try {
      f.events.onMessage({ id: 'fallback', role: 'assistant', kind: 'text', text: 'FALLBACK_CONTENT', streaming: false });
      await flushUntil(f.terminal, () => expect(f.terminal.getScrollBuffer().join('\n')).toContain('FALLBACK_CONTENT'));
      f.tui.requestRender(true);
      await new Promise(resolve => { setTimeout(resolve, 450); }); await f.terminal.flush();
      expect(f.terminal.getScrollBuffer().filter(row => row.includes('FALLBACK_CONTENT'))).toHaveLength(1);
      f.terminal.sendInput('continued');
      await flushUntil(f.terminal, () => expect(f.terminal.getViewport().join('\n')).toContain('continued'));
    } finally { await f.close(); }
  });
});
