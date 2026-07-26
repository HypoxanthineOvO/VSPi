import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE, FX, MODEL_GROUPS, MODELS } from "../src/domain/fixtures.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";
const TAB = "\t";

function render(panel: PanelController, width: number, rows = 22): string[] {
  const lines = panel.render(width, rows, plainTheme(), DEFAULT_USAGE).map(stripAnsi);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  return lines;
}

function splitPanes(lines: string[], minimumRows = 3) {
  const rows = lines.slice(1, -1).map((line) => line.slice(1, -1));
  const splitRows = rows.flatMap((line) => {
    const divider = line.indexOf("│");
    if (divider < 0) return [];
    return [
      { left: line.slice(0, divider), right: line.slice(divider + 1), column: visibleWidth(line.slice(0, divider)) },
    ];
  });
  expect(splitRows.length).toBeGreaterThanOrEqual(minimumRows);
  expect(new Set(splitRows.map((row) => row.column)).size).toBe(1);
  return {
    rows: splitRows,
    left: splitRows.map((row) => row.left).join("\n"),
    right: splitRows.map((row) => row.right).join("\n"),
  };
}

describe("model panel responsive layout", () => {
  it.each([80, 100])("keeps the model list left and selected detail right at width %i", (width) => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels(MODELS, MODEL_GROUPS, "kimi-k3");
    panel.open("models");
    const firstLines = render(panel, width);
    const first = splitPanes(firstLines);
    const firstRendered = firstLines.join("\n");

    expect(first.left).toContain("DeepSeek V3.2");
    for (const value of ["DeepSeek V3.2", "Provider", "Model ID", "能力", "Effort", "发布", "输入 ¥", "输出 ¥"]) {
      expect(first.right).toContain(value);
    }
    expect(first.left).not.toMatch(/Provider|Model ID|能力|Effort|发布|¥/);
    expect(firstRendered).not.toMatch(new RegExp(`${FX.source}|USD/CNY|${FX.asOf}`));

    const initialLeftModelCount = MODELS.filter((model) => first.left.includes(model.label)).length;
    panel.handleInput(DOWN);
    const second = splitPanes(render(panel, width));
    expect(second.right).toContain("Kimi K3");
    expect(second.right).not.toContain("DeepSeek V3.2");
    expect(MODELS.filter((model) => second.left.includes(model.label))).toHaveLength(initialLeftModelCount);
    expect(second.rows).toHaveLength(first.rows.length);
  });

  it("keeps wrapped Effort and price visible in the 64-column, 24-row panel budget", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels(
      MODELS.filter((model) => model.id === "gpt-5.4"),
      [],
      "gpt-5.4",
    );
    panel.open("models");
    const rendered = render(panel, 64, 9).join("\n");

    expect(rendered).toContain("Xhigh /");
    expect(rendered).toContain("Max");
    expect(rendered).toContain("输入 ¥");
    expect(rendered).toContain("输出 ¥");
    expect(rendered).not.toMatch(/\d+-\d+ \/ \d+/);
  });

  it.each([80, 100])("shows model-group roles only in the right pane at width %i", (width) => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels(MODELS, MODEL_GROUPS, "kimi-k3");
    panel.open("models");
    panel.handleInput(TAB);
    const lines = render(panel, width);
    const panes = splitPanes(lines);

    expect(panes.left).toContain("auto/safe");
    for (const role of ["默认", "复杂代码", "总结"]) expect(panes.right).toContain(role);
    expect(lines.join("\n")).not.toContain("¥");
  });

  it("groups runtime models by provider and hides the unavailable preset-group view", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels([
      {
        id: "z-last",
        provider: "z-provider",
        brand: "Z Provider",
        label: "Zeta",
        vision: false,
        efforts: ["off"],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      },
      {
        id: "a-second",
        provider: "a-provider",
        brand: "A Provider Name That Is Much Too Long For The List",
        label: "Alpha Two",
        vision: false,
        efforts: ["off"],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      },
      {
        id: "a-first",
        provider: "a-provider",
        brand: "A Provider Name That Is Much Too Long For The List",
        label: "Alpha One",
        vision: false,
        efforts: ["off"],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      },
    ]);
    panel.open("models");

    const lines = render(panel, 60, 16);
    const panes = splitPanes(lines);
    expect(panes.left).toMatch(/A Provider.*…\s+2/);
    expect(panes.left.indexOf("Alpha One")).toBeLessThan(panes.left.indexOf("Alpha Two"));
    expect(panes.left.indexOf("Alpha Two")).toBeLessThan(panes.left.indexOf("Z Provider"));
    expect(lines[1]).not.toContain("模型组");
    expect(stripAnsi(panel.renderHint(60, plainTheme()))).not.toContain("Tab 切换视图");

    panel.handleInput(TAB);
    expect(render(panel, 60, 16).join("\n")).not.toContain("没有匹配的模型组");
  });

  it("uses explicit list/detail navigation at 40 columns without leaking price into the list", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels(MODELS, MODEL_GROUPS, "kimi-k3");
    panel.open("models");

    const list = render(panel, 40, 16).join("\n");
    expect(list).toContain("选择模型");
    expect(list).not.toContain("¥");

    panel.handleInput(RIGHT);
    const detail = render(panel, 40, 16).join("\n");
    expect(detail).toContain("DeepSeek V3.2");
    expect(detail).toContain("输入 ¥");
    expect(detail).toContain("输出 ¥");
    expect(detail).not.toMatch(new RegExp(`${FX.source}|USD/CNY|${FX.asOf}`));

    panel.handleInput(LEFT);
    const returnedList = render(panel, 40, 16).join("\n");
    expect(returnedList).toContain("选择模型");
    expect(returnedList).not.toContain("¥");
  });
});
