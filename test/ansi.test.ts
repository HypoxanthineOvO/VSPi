import { describe, expect, it } from "vitest";
import { alignRight, frame, padLine, stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { plainTheme } from "./helpers.js";

describe("width-safe terminal primitives", () => {
  it("pads East Asian text to exact terminal columns", () => {
    const line = padLine("你好 VSPi", 12);
    expect(visibleWidth(line)).toBe(12);
  });

  it("never lets framed content exceed its width", () => {
    const lines = frame(["很长的中文内容会被安全截断"], 18, plainTheme(), { title: "测试" });
    expect(lines.every((line) => visibleWidth(line) === 18)).toBe(true);
    expect(stripAnsi(lines[0] ?? "")).toContain("测试");
  });

  it("preserves all frame corners when titles and a left footer overflow", () => {
    const lines = frame(["body"], 24, plainTheme(), {
      title: "Sessions with a long title",
      rightTitle: "999 个会话",
      footer: "↑↓ 选择 Enter 打开 Shift+F 创建分支 Esc 返回",
      footerPosition: "left",
    }).map(stripAnsi);
    expect(lines[0]).toMatch(/^╭.*╮$/u);
    expect(lines.at(-1)).toMatch(/^╰.*╯$/u);
    expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
  });

  it("keeps the right value with an ellipsis hint when alignRight overflows", () => {
    const line = alignRight("原始费用超出可用宽度", "$0.0000 USD", 14);
    expect(visibleWidth(line)).toBe(14);
    expect(line).toContain("$0.0000 USD");
    expect(line).toContain("…");
  });
});
