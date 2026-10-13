import { Input, Key, matchesKey } from '@moonshot-ai/pi-tui';
import type { SideQuestionEvent, SideQuestionSession } from '../backend/types.js';
import { frame, wrapTextWithAnsi } from './ansi.js';
import { renderMarkdown } from './markdown.js';
import type { VspiTheme } from './theme.js';

export class SideQuestionDialog {
  private readonly input = new Input();
  private readonly messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  private session: SideQuestionSession | undefined;
  private busy = false;
  private closed = false;
  private status = '正在读取当前上下文…';
  private scroll = 0;

  constructor(private readonly requestRender: () => void, private readonly onClose: () => void) {}

  async connect(session: SideQuestionSession, question: string): Promise<void> {
    if (this.closed) { await session.close(); return; }
    this.session = session;
    this.status = '可使用 Read / Grep / Glob 查阅文件';
    if (question.trim()) await this.send(question);
    this.requestRender();
  }

  receive(event: SideQuestionEvent): void {
    if (this.closed) return;
    if (event.kind === 'answer') {
      let message = this.messages.at(-1);
      if (message?.role !== 'assistant') {
        message = { role: 'assistant', text: '' };
        this.messages.push(message);
      }
      message.text += event.delta;
    } else if (event.kind === 'tool') this.status = `查阅文件 · ${event.name}`;
    else if (event.kind === 'error') {
      this.busy = false;
      this.status = `旁路问答失败：${event.message}`;
    } else {
      this.busy = false;
      this.status = event.reason === 'completed' ? '回答完成，可继续追问' : `旁路问答 ${event.reason}`;
    }
    this.requestRender();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    await this.session?.close();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      void this.close().catch(() => {});
      return;
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (this.busy) void this.session?.cancel().catch(error => this.receive({ kind: 'error', message: String(error) }));
      else void this.close().catch(() => {});
      return;
    }
    if (matchesKey(data, Key.pageUp)) this.scroll += 8;
    else if (matchesKey(data, Key.pageDown)) this.scroll = Math.max(0, this.scroll - 8);
    else if (matchesKey(data, Key.enter)) {
      const text = this.input.getValue().trim();
      if (text && !this.busy && this.session) {
        this.input.setValue('');
        void this.send(text);
      }
    } else this.input.handleInput(data);
    this.requestRender();
  }

  private async send(text: string): Promise<void> {
    this.busy = true;
    this.scroll = 0;
    this.status = '正在回答 · 主任务继续运行';
    this.messages.push({ role: 'user', text });
    this.requestRender();
    try { await this.session!.send(text); }
    catch (error) { this.receive({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  render(width: number, theme: VspiTheme, rows: number): string[] {
    const inner = Math.max(1, width - 4);
    const content = this.messages.flatMap(message => [
      theme.muted(message.role === 'user' ? '你' : '旁路回复'),
      ...renderMarkdown(message.text, inner, theme),
      '',
    ]);
    const available = Math.max(1, rows - 9);
    this.scroll = Math.min(this.scroll, Math.max(0, content.length - available));
    const end = content.length - this.scroll;
    return frame([
      theme.muted('继承当前上下文 · 主任务独立运行'),
      ...content.slice(Math.max(0, end - available), end),
      ...wrapTextWithAnsi(theme.muted(this.status), inner),
      ...this.input.render(inner),
      theme.muted('Enter 发送 · Ctrl+C 取消旁路回复 · Esc 关闭 · PgUp/PgDn 翻页'),
    ], width, theme, { title: 'Side · 旁路问答' });
  }
}
