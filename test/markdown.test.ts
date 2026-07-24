import { Markdown } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderMarkdown, VspiMarkdown } from "../src/ui/markdown.js";
import { createTheme } from "../src/ui/theme.js";
import { capabilities, plainTheme } from "./helpers.js";

describe("VSPi Markdown rendering", () => {
  it("uses requested list glyphs by nesting depth and aligns ordered wraps", () => {
    const source = [
      "- 一级",
      "  - 二级",
      "    - 三级",
      "",
      "12. 这是一个会在窄终端中自动换行并与正文首列对齐的有序列表项目",
    ].join("\n");
    const lines = renderMarkdown(source, 34, plainTheme()).map(stripAnsi);
    expect(lines.some((line) => line.includes("• 一级"))).toBe(true);
    expect(lines.some((line) => line.includes("◦ 二级"))).toBe(true);
    expect(lines.some((line) => line.includes("▪ 三级"))).toBe(true);
    const ordered = lines.filter((line) => line.includes("12.") || line.includes("正文首列"));
    expect(ordered.length).toBeGreaterThan(1);
  });

  it("renders H1 and H2 with the same bold colored underline contract", () => {
    const theme = createTheme(capabilities({ colorLevel: 3, truecolor: true }));
    const [h1, , h2] = renderMarkdown("# 一级\n\n## 二级", 40, theme);
    expect(h1).toContain("\u001b[1m");
    expect(h1).toContain("\u001b[4m");
    expect(h2).toContain("\u001b[1m");
    expect(h2).toContain("\u001b[4m");
  });

  it("colors inline code and fills fenced code backgrounds without breaking partial streams", () => {
    const theme = createTheme(capabilities({ colorLevel: 3, truecolor: true }));
    const lines = renderMarkdown("值为 `const`。\n\n```ts\nconst x = 1\n``", 36, theme);
    expect(lines.join("\n")).toContain("48;2;32;36;40");
    expect(lines.map(stripAnsi).join("\n")).toContain("const x = 1");
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

  it("renders quotes with a dedicated border and color", () => {
    const lines = renderMarkdown("> 重要引用", 30, plainTheme()).map(stripAnsi);
    expect(lines[0]).toMatch(/^│ 重要引用/);
  });

  it("keeps links, task lists and tables readable at terminal width", () => {
    const source = [
      "[项目文档](https://example.com/docs)",
      "",
      "- [x] 已完成",
      "- [ ] 待处理",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| TUI | 可用 |",
    ].join("\n");
    const lines = renderMarkdown(source, 36, plainTheme());
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("项目文档 (https://example.com/docs)");
    expect(text).toContain("[x]");
    expect(text).toContain("TUI");
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

  it("reuses tokenization while text and effective code width stay unchanged", () => {
    const long = 'const value = "x".repeat(80); // 超长代码行需要按宽度处理';
    const source = ["```ts", long, "```"].join("\n");
    const setText = vi.spyOn(Markdown.prototype, "setText");
    try {
      const markdown = new VspiMarkdown(source, plainTheme(), 0, { wrapCode: true });
      markdown.render(48);
      const baseline = setText.mock.calls.length;
      markdown.render(48);
      expect(setText.mock.calls.length).toBe(baseline);
      markdown.render(120);
      expect(setText.mock.calls.length).toBe(baseline + 1);
      markdown.setText(`${source}\n\n追加`);
      expect(setText.mock.calls.length).toBe(baseline + 2);
    } finally {
      setText.mockRestore();
    }
  });
});
