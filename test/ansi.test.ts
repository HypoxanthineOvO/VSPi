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

  it("keeps the right value with an ellipsis hint when alignRight overflows", () => {
    const line = alignRight("原始费用超出可用宽度", "$0.0000 USD", 14);
    expect(visibleWidth(line)).toBe(14);
    expect(line).toContain("$0.0000 USD");
    expect(line).toContain("…");
  });
});
