import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderStatusLines } from "../src/ui/status.js";
import { plainTheme } from "./helpers.js";

const LABELS = ["Model", "Effort", "Context", "Token", "Cost"] as const;
const LONG_CWD = "/home/heyx/workspaces/a-very-long-project-directory/with/deeply/nested/source-packages/vspi";

function input() {
  return {
    cwd: LONG_CWD,
    usage: DEFAULT_USAGE,
    modelLabel: "DeepSeek / DeepSeek V3.2",
    effort: "high" as const,
    busy: true,
    mode: "Inspect",
  };
}

function expectExactWidths(lines: string[], width: number): void {
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localizedLabelStyle(rendered: string, label: string): string | undefined {
  const match = rendered.match(new RegExp(`((?:\\u001b\\[[0-9;]*m)+)${escapeRegExp(label)}(?:\\u001b\\[[0-9;]*m)+`));
  return match?.[1];
}

describe("status rendering", () => {
  it("shows every labeled field and an unlabeled cwd at 120 columns with exact-width output", () => {
    const lines = renderStatusLines(input(), 120, plainTheme());
    const rendered = lines.map(stripAnsi).join("\n");

    expectExactWidths(lines, 120);
    for (const label of LABELS) expect(rendered).toContain(label);
    expect(stripAnsi(lines[1] ?? "")).toMatch(/^\/home\/heyx/);
    expect(rendered).not.toMatch(/\bPath\b/);
  });

  it("keeps all fields within two exact-width lines at 80 columns and truncates only the long path", () => {
    const lines = renderStatusLines(input(), 80, plainTheme());
    const rendered = lines.map(stripAnsi).join("\n");

    expectExactWidths(lines, 80);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const label of LABELS) expect(rendered).toContain(label);
    expect(stripAnsi(lines[1] ?? "")).toMatch(/^\/home\/heyx/);
    expect(rendered).not.toMatch(/\bPath\b/);
    expect(rendered).not.toContain(LONG_CWD);
    expect(rendered).toContain("…");
  });

  it("retains the emergency identity fields at 40 columns", () => {
    const lines = renderStatusLines(input(), 40, plainTheme());
    const rendered = lines.map(stripAnsi).join("\n");

    expectExactWidths(lines, 40);
    for (const label of LABELS) expect(rendered).toContain(label);
    expect(stripAnsi(lines[1] ?? "")).toMatch(/^\//);
    expect(rendered).not.toMatch(/\bPath\b/);
  });

  it("renders a visible working indicator and queue count at wide and compact widths", () => {
    for (const width of [40, 80, 120]) {
      const lines = renderStatusLines(
        { ...input(), working: { indicator: "◐", steering: 2, followUp: 1 } },
        width,
        plainTheme(),
      );
      const rendered = lines.map(stripAnsi).join("\n");
      expectExactWidths(lines, width);
      if (width < 60) expect(rendered).toContain("W◐3");
      else {
        expect(rendered).toContain("Working ◐");
        expect(rendered).toContain("插入 2");
        expect(rendered).toContain("后续 1");
      }
    }
  });

  it("styles labels locally with more than one truecolor ANSI treatment", () => {
    const lines = renderStatusLines(input(), 120, plainTheme({ colorLevel: 3, truecolor: true }));
    const rendered = lines.join("\n");
    const styles = LABELS.map((label) => localizedLabelStyle(rendered, label));

    expect(styles.every(Boolean)).toBe(true);
    expect(new Set(styles).size).toBeGreaterThan(1);
  });
});
