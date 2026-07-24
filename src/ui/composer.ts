import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type Focusable,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Attachment } from "../domain/types.js";
import { emphasizeVisibleRange, padLine, stripAnsi, visibleWidth } from "./ansi.js";
import { matchesInteraction } from "./interactions.js";
import type { VspiTheme } from "./theme.js";

interface EditorStateAccess {
  state: {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };
}

export type AttachmentCursorState = "left" | "selected" | "right";

function isTextInput(data: string): boolean {
  return (
    data.length > 0 &&
    !data.includes("\u001b") &&
    !Array.from(data).some((character) => {
      if (character === "\n" || character === "\r" || character === "\t") return false;
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

export class Composer implements Component, Focusable {
  readonly editor: Editor;
  attachments: Attachment[] = [];
  onAttachmentRemove?: (attachment: Attachment) => void;
  private selectedAttachmentId: string | undefined;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: VspiTheme,
  ) {
    this.editor = new Editor(
      tui,
      {
        borderColor: theme.focus,
        selectList: {
          selectedPrefix: (value) => theme.focus(value),
          selectedText: (value) => theme.selected(value),
          description: (value) => theme.muted(value),
          scrollInfo: (value) => theme.muted(value),
          noMatch: (value) => theme.warning(value),
        },
      },
      { paddingX: 1, autocompleteMaxVisible: 6 },
    );
  }

  set onSubmit(value: (text: string) => void) {
    this.editor.onSubmit = value;
  }

  set onChange(value: (text: string) => void) {
    this.editor.onChange = value;
  }

  getText(): string {
    return this.editor.getExpandedText();
  }

  setText(text: string): void {
    this.editor.setText(text);
  }

  addAttachment(attachment: Attachment): void {
    this.attachments.push(attachment);
    this.editor.insertTextAtCursor(`${this.editor.getText() ? " " : ""}${this.marker(attachment)} `);
    this.tui.requestRender();
  }

  updateAttachment(attachment: Attachment): void {
    const index = this.attachments.findIndex((item) => item.id === attachment.id);
    const current = this.attachments[index];
    if (index < 0 || !current) return;
    const previousMarker = this.marker(current);
    const nextMarker = this.marker(attachment);
    const access = this.editor as unknown as EditorStateAccess;
    access.state.lines = access.state.lines.map((line) => line.replace(previousMarker, nextMarker));
    if (access.state.cursorLine < access.state.lines.length) {
      access.state.cursorCol = Math.min(
        access.state.cursorCol,
        access.state.lines[access.state.cursorLine]?.length ?? 0,
      );
    }
    this.attachments[index] = attachment;
    this.editor.onChange?.(this.editor.getText());
    this.tui.requestRender();
  }

  removeSelectedAttachment(): Attachment | undefined {
    const attachment = this.attachments.find((item) => item.id === this.selectedAttachmentId);
    if (!attachment) return undefined;
    const access = this.editor as unknown as EditorStateAccess;
    access.state.lines = access.state.lines.map((line) =>
      line.replace(this.marker(attachment), "").replace(/ {2,}/g, " "),
    );
    access.state.cursorLine = Math.min(access.state.cursorLine, access.state.lines.length - 1);
    access.state.cursorCol = Math.min(access.state.cursorCol, access.state.lines[access.state.cursorLine]?.length ?? 0);
    this.attachments = this.attachments.filter((item) => item.id !== attachment.id);
    this.selectedAttachmentId = undefined;
    this.editor.onChange?.(this.editor.getText());
    this.tui.requestRender();
    this.onAttachmentRemove?.(attachment);
    return attachment;
  }

  clearAttachments(): Attachment[] {
    const result = this.attachments;
    this.attachments = [];
    this.selectedAttachmentId = undefined;
    return result;
  }

  restoreDraft(text: string, attachments: Attachment[]): void {
    this.attachments = [...attachments];
    this.selectedAttachmentId = undefined;
    this.editor.setText(text);
    this.tui.requestRender();
  }

  restoreAttachments(attachments: Attachment[]): void {
    const text = attachments.map((attachment) => this.marker(attachment)).join(" ");
    this.restoreDraft(text, attachments);
  }

  selectedAttachment(): Attachment | undefined {
    return this.attachments.find((item) => item.id === this.selectedAttachmentId);
  }

  attachmentCursorState(attachment: Attachment): AttachmentCursorState | undefined {
    const access = this.editor as unknown as EditorStateAccess;
    const line = access.state.lines[access.state.cursorLine] ?? "";
    const start = line.indexOf(this.marker(attachment));
    if (start < 0) return undefined;
    const end = start + this.marker(attachment).length;
    if (this.selectedAttachmentId === attachment.id) return "selected";
    if (access.state.cursorCol === start) return "left";
    if (access.state.cursorCol === end) return "right";
    return undefined;
  }

  handleInput(data: string): void {
    if (this.handleAttachmentInput(data)) return;
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const innerWidth = safeWidth - 2;
    const access = this.editor as unknown as EditorStateAccess;
    const selected = this.selectedAttachment();
    const originalCursorCol = access.state.cursorCol;
    if (selected) {
      const currentLine = access.state.lines[access.state.cursorLine] ?? "";
      const markerEnd = currentLine.indexOf(this.marker(selected)) + this.marker(selected).length;
      if (markerEnd >= this.marker(selected).length)
        access.state.cursorCol = Math.min(currentLine.length, markerEnd + 1);
    }
    const raw = this.editor.render(innerWidth);
    access.state.cursorCol = originalCursorCol;
    let body = raw.slice(1, -1);
    if (this.editor.getText() === "" && body[0]) {
      body[0] = `${body[0]}${this.theme.muted(" 输入消息…")}`;
    }
    body = body.map((line) => this.styleAttachmentMarkers(line));
    body = this.styleSlashCommand(body);

    let hiddenAbove = 0;
    let hiddenBelow = 0;
    if (body.length > 10) {
      const cursorIndex = Math.max(
        0,
        body.findIndex((line) => line.includes(CURSOR_MARKER) || line.includes("\u001b[7m")),
      );
      const start = Math.max(0, Math.min(cursorIndex - 5, body.length - 10));
      hiddenAbove = start;
      hiddenBelow = body.length - start - 10;
      body = body.slice(start, start + 10);
    }

    const chars = this.theme.capabilities.unicode
      ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
      : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
    const topLabel = hiddenAbove > 0 ? ` ↑ ${hiddenAbove} ` : "";
    const bottomLabel = hiddenBelow > 0 ? ` ↓ ${hiddenBelow} ` : "";
    const top = `${chars.tl}${topLabel}${chars.h.repeat(Math.max(0, innerWidth - visibleWidth(topLabel)))}${chars.tr}`;
    const bottom = `${chars.bl}${chars.h.repeat(Math.max(0, innerWidth - visibleWidth(bottomLabel)))}${bottomLabel}${chars.br}`;
    return [
      this.theme.focus(padLine(top, safeWidth)),
      ...body.map((line) => `${this.theme.focus(chars.v)}${padLine(line, innerWidth)}${this.theme.focus(chars.v)}`),
      this.theme.focus(padLine(bottom, safeWidth)),
    ];
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private marker(attachment: Attachment): string {
    return `〔${attachment.alias} · ${attachment.width}×${attachment.height} · ${attachment.mimeType.split("/")[1]?.toUpperCase()}〕`;
  }

  private styleAttachmentMarkers(line: string): string {
    let result = line;
    for (const attachment of this.attachments) {
      const marker = this.marker(attachment);
      const style = attachment.id === this.selectedAttachmentId ? this.theme.selected : this.theme.blue;
      result = result.replace(marker, style(marker));
    }
    return result;
  }

  private styleSlashCommand(lines: string[]): string[] {
    const token = /^\/[^\s]*/.exec(this.editor.getExpandedText())?.[0];
    if (!token) return lines;
    let styled = false;
    return lines.map((line) => {
      if (styled || !stripAnsi(line).includes(token)) return line;
      styled = true;
      return emphasizeVisibleRange(line, token, this.theme);
    });
  }

  private handleAttachmentInput(data: string): boolean {
    const selected = this.selectedAttachment();
    if (selected) {
      const access = this.editor as unknown as EditorStateAccess;
      const line = access.state.lines[access.state.cursorLine] ?? "";
      const start = line.indexOf(this.marker(selected));
      const end = start + this.marker(selected).length;
      if (matchesInteraction("composer", "attachment", "moveAttachmentLeft", data)) {
        access.state.cursorCol = Math.max(0, start);
        this.selectedAttachmentId = undefined;
        this.tui.requestRender();
        return true;
      }
      if (matchesInteraction("composer", "attachment", "moveAttachmentRight", data)) {
        access.state.cursorCol = Math.max(0, end);
        this.selectedAttachmentId = undefined;
        this.tui.requestRender();
        return true;
      }
      if (matchesInteraction("composer", "attachment", "removeAttachment", data)) {
        this.removeSelectedAttachment();
        return true;
      }
      if (isTextInput(data)) {
        this.selectedAttachmentId = undefined;
        return false;
      }
      return true;
    }

    const access = this.editor as unknown as EditorStateAccess;
    const line = access.state.lines[access.state.cursorLine] ?? "";
    for (const attachment of this.attachments) {
      const start = line.indexOf(this.marker(attachment));
      const end = start + this.marker(attachment).length;
      if (
        (matchesInteraction("composer", "attachment", "moveAttachmentRight", data) &&
          access.state.cursorCol === start) ||
        (matchesInteraction("composer", "attachment", "moveAttachmentLeft", data) && access.state.cursorCol === end)
      ) {
        this.selectedAttachmentId = attachment.id;
        this.tui.requestRender();
        return true;
      }
      if (
        matchesInteraction("composer", "attachment", "removeAttachment", data) &&
        ((matchesKey(data, Key.backspace) && access.state.cursorCol === end) ||
          (matchesKey(data, Key.delete) && access.state.cursorCol === start))
      ) {
        this.selectedAttachmentId = attachment.id;
        this.removeSelectedAttachment();
        return true;
      }
    }
    return false;
  }
}
