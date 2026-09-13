import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from '@moonshot-ai/pi-tui';
import type { VspiTheme } from '../ui/theme.js';
import type { FeedbackBundle } from './bundle.js';

export class FeedbackPreview implements Component {
  private offset = 0;
  private width = 0;
  private lines: string[] = [];
  private confirm = false;
  private uploading = false;
  private status = '';
  constructor(
    private readonly bundle: FeedbackBundle,
    private readonly theme: VspiTheme,
    private readonly height: () => number,
    private readonly action: (action: 'upload' | 'close') => void,
  ) {}
  invalidate(): void {
    this.width = 0;
  }
  setUploading(value: boolean, status = ''): void {
    this.uploading = value;
    this.status = status;
    this.confirm = false;
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.action('close');
      return;
    }
    if (this.uploading) return;
    if (data === 'u' || data === 'U') {
      this.confirm = true;
      return;
    }
    if (this.confirm && (data === '\r' || data === '\n')) {
      this.action('upload');
      return;
    }
    if (data === 'e' || data === 'E') {
      this.action('close');
      return;
    }
    if (matchesKey(data, 'down') || data === 'j') this.offset++;
    if (matchesKey(data, 'up') || data === 'k') this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, 'pageDown')) this.offset += Math.max(1, this.height() - 4);
    if (matchesKey(data, 'pageUp'))
      this.offset = Math.max(0, this.offset - Math.max(1, this.height() - 4));
  }
  render(width: number): string[] {
    const bodyRows = Math.max(1, this.height() - 4);
    if (width !== this.width) {
      this.lines = JSON.stringify(this.bundle, null, 2)
        .split('\n')
        .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
      this.width = width;
    }
    this.offset = Math.max(0, Math.min(this.offset, this.lines.length - bodyRows));
    const hint = this.uploading
      ? '上传中，Esc 取消；本地包保留'
      : this.confirm
      ? '确认分享全部预览内容给维护者（Eden/Hermes）？Enter 上传；Esc 取消'
      : 'U 确认上传 · E 仅导出 · Esc 取消 · ↑↓/PgUp/PgDn 查看';
    return [
      this.theme.focus(truncateToWidth(`Feedback 预览 · ${this.bundle.id}`, width)),
      this.theme.warning(
        truncateToWidth(
          this.bundle.truncated
            ? '上下文有截断；请检查遗漏范围及未识别的秘密'
            : '请检查对话与中间输出中是否仍有未识别的秘密',
          width,
        ),
      ),
      ...this.lines.slice(this.offset, this.offset + bodyRows),
      this.theme.muted(
        truncateToWidth(
          this.status ||
            `${this.offset + 1}–${Math.min(this.lines.length, this.offset + bodyRows)}/${
              this.lines.length
            } 行`,
          width,
        ),
      ),
      this.theme.blue(truncateToWidth(hint, width)),
    ];
  }
}
