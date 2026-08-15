import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { Composer } from "../src/ui/composer.js";
import { plainTheme } from "./helpers.js";

function fakeTui(rows = 60): TUI {
  return {
    terminal: { rows },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

const attachment: Attachment = {
  id: "image-1",
  alias: "登录页-修改前",
  mimeType: "image/png",
  width: 1440,
  height: 900,
  size: 120_000,
  path: "/tmp/image.png",
  status: "ready",
};

describe("composer", () => {
  it("grows to at most ten body lines and then scrolls internally", () => {
    const composer = new Composer(fakeTui(), plainTheme());
    composer.focused = true;
    composer.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    expect(composer.render(80)).toHaveLength(12);
  });

  it("treats attachment labels as selectable atomic nodes without auto-selecting on insert", () => {
    const composer = new Composer(fakeTui(), plainTheme());
    composer.addAttachment(attachment);
    expect(composer.selectedAttachment()).toBeUndefined();
    composer.handleInput("\x1b[D");
    expect(composer.selectedAttachment()).toBeUndefined();
    composer.handleInput("\x1b[D");
    expect(composer.selectedAttachment()?.id).toBe(attachment.id);
    composer.handleInput("\x1b[C");
    expect(composer.selectedAttachment()).toBeUndefined();
    composer.handleInput("\x1b[D");
    expect(composer.selectedAttachment()?.id).toBe(attachment.id);
    composer.handleInput("\x7f");
    expect(composer.attachments).toHaveLength(0);
    expect(composer.getText()).not.toContain("登录页-修改前");
  });

  it("deselects the attachment and keeps typing instead of swallowing printable input", () => {
    const composer = new Composer(fakeTui(), plainTheme());
    const submitted: string[] = [];
    composer.onSubmit = (value) => submitted.push(value);
    composer.addAttachment(attachment);
    composer.handleInput("字");
    expect(composer.getText()).toContain("字");

    composer.handleInput("\x1b[D");
    composer.handleInput("\x1b[D");
    composer.handleInput("\x1b[D");
    expect(composer.selectedAttachment()?.id).toBe(attachment.id);
    composer.handleInput("x");
    expect(composer.selectedAttachment()).toBeUndefined();
    expect(composer.getText()).toContain("x");

    composer.handleInput("\x1b[D");
    composer.handleInput("\x1b[D");
    expect(composer.selectedAttachment()?.id).toBe(attachment.id);
    composer.handleInput("\r");
    expect(submitted).toHaveLength(1);
  });

  it("keeps the selected attachment marker contiguous while the editor cursor is elsewhere", () => {
    const composer = new Composer(fakeTui(), plainTheme({ colorLevel: 3, truecolor: true }));
    composer.focused = true;
    composer.addAttachment(attachment);
    expect(composer.render(80).join("\n")).toContain("〔登录页-修改前 ⋅ 1440x900 ⋅ PNG〕");
  });

  it("renders Working styles 2 and 3 inside the top border without changing composer height", () => {
    const composer = new Composer(fakeTui(), plainTheme());
    const style2 = composer.render(80, {
      style: 2,
      frame: 3,
      elapsedSeconds: 65,
      reducedMotion: false,
    });
    const style3 = composer.render(80, {
      style: 3,
      frame: 3,
      elapsedSeconds: 65,
      reducedMotion: false,
    });
    const reduced = composer.render(80, {
      style: 3,
      frame: 5,
      elapsedSeconds: 65,
      reducedMotion: true,
    });

    expect(style2).toHaveLength(3);
    expect(style3).toHaveLength(3);
    expect(stripAnsi(style2[0] ?? "")).toContain("⬤ Working 01:05");
    expect(stripAnsi(style3[0] ?? "")).toMatch(/⬤ Working 01:05 {2}⢿⣟⣷/);
    expect(stripAnsi(reduced[0] ?? "")).toContain("⬤ Working 01:05  ⣿⣿⣿");
  });

  it.each([20, 40, 80] as const)("keeps a Working composer exactly %s columns wide", (width) => {
    const composer = new Composer(fakeTui(), plainTheme());
    const rendered = composer.render(width, {
      style: 3,
      frame: 2,
      elapsedSeconds: 3_661,
      reducedMotion: false,
    });
    expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it("uses Ctrl+J as an explicit newline without submitting", () => {
    const composer = new Composer(fakeTui(), plainTheme());
    const submitted: string[] = [];
    composer.onSubmit = (value) => submitted.push(value);
    composer.setText("第一行");
    composer.handleInput("\n");
    composer.handleInput("第二行");
    expect(composer.getText()).toBe("第一行\n第二行");
    expect(submitted).toEqual([]);
  });
});
