import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderDiff } from "../src/ui/diff.js";
import { plainTheme } from "./helpers.js";

describe("diff rendering", () => {
  it("keeps line numbers and wraps long changes within the viewport", () => {
    const lines = renderDiff(
      [
        { kind: "meta", text: "@@ -1,2 +1,2 @@" },
        { kind: "remove", oldLine: 1, text: "const oldValue = aVeryLongFunctionName();" },
        { kind: "add", newLine: 1, text: "const newValue = aVeryLongFunctionName();" },
      ],
      30,
      plainTheme(),
    );
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    expect(lines.map(stripAnsi).join("\n")).toContain("+");
  });

  it("aligns narrow-screen wrapped content with the 5-column number gutter", () => {
    const lines = renderDiff([{ kind: "add", newLine: 7, text: "x".repeat(40) }], 30, plainTheme()).map(stripAnsi);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const firstContent = line.search(/x/);
      expect(firstContent).toBe(5);
    }
  });

  it("aligns wide-screen wrapped content with the 12-column dual-number gutter", () => {
    const lines = renderDiff(
      [{ kind: "context", oldLine: 12, newLine: 34, text: "y".repeat(120) }],
      80,
      plainTheme(),
    ).map(stripAnsi);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("  12   34   ")).toBe(true);
    for (const line of lines) {
      expect(line.search(/y/)).toBe(12);
    }
  });
});
