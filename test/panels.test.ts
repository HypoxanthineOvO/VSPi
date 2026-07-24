import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE, MODEL_GROUPS, MODELS, PROVIDERS } from "../src/domain/fixtures.js";
import type { Question } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

const ENTER = "\r";
const DOWN = "\u001b[B";
const SPACE = " ";

const QUESTIONS: Question[] = [
  {
    id: "density",
    title: "Density",
    prompt: "Choose one",
    kind: "singleChoice",
    options: [{ id: "compact", label: "Compact" }],
  },
  {
    id: "signals",
    title: "Signals",
    prompt: "Choose signals",
    kind: "multiChoice",
    options: [
      { id: "context", label: "Context" },
      { id: "cost", label: "Cost" },
    ],
  },
  {
    id: "priority",
    title: "Priority",
    prompt: "Rank items",
    kind: "ranking",
    options: [
      { id: "model", label: "Model" },
      { id: "provider", label: "Provider" },
    ],
  },
  { id: "note", title: "Note", prompt: "Add details", kind: "freeText" },
];

function text(panel: PanelController, width = 80, rows = 14): string {
  const lines = panel.render(width, rows, plainTheme(), DEFAULT_USAGE);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  return lines.map(stripAnsi).join("\n");
}

describe("panel controller", () => {
  it("renders the fresh plan as one compact empty-state row without demo content", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    const lines = panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi);
    const rendered = lines.join("\n");
    const body = lines
      .slice(1, -1)
      .map((line) => line.slice(1, -1).trim())
      .filter(Boolean);

    expect.soft(lines).toHaveLength(3);
    expect.soft(body).toEqual(["当前计划为空"]);
    expect.soft(rendered).not.toContain("›");
    expect.soft(rendered).not.toContain("TUI v1");
    expect.soft(rendered).not.toContain("2 / 5");
    expect.soft(rendered).not.toContain("启动封面");
    expect.soft(rendered).not.toContain("输入框形态");
    expect.soft(rendered).not.toContain("Provider 选择器");
  });

  it("renders the delivered Plan command as an enabled built-in action", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setCommandQuery("/plan");
    const rendered = text(panel);
    expect(rendered).toContain("VSPi");
    expect(rendered).toContain("Built-in");
    expect(rendered).toContain("查看 Workflow Plan");
    expect(rendered).not.toContain("暂未接入");
    expect(rendered).not.toContain("@vspi/fixtures");
  });

  it("renders unknown Context without leaking nullable values into the Usage panel", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.open("usage");
    const rendered = panel
      .render(80, 14, plainTheme(), {
        ...DEFAULT_USAGE,
        contextTokens: null,
        contextWindow: 128_000,
        contextPercent: null,
      })
      .map(stripAnsi)
      .join("\n");

    expect(rendered).toContain("?K / 128K ?%");
    expect(rendered).not.toContain("null%");
  });

  it("keeps the right-hand value with an ellipsis hint when the Usage panel is too narrow", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.open("usage");
    const rendered = text(panel, 16);

    expect(rendered).toContain("$0.0000 USD");
    expect(rendered).toContain("…");
  });

  it("types an uppercase S in the free-text question instead of skipping", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openQuestions([{ id: "note", title: "Note", prompt: "Add details", kind: "freeText" }]);

    panel.handleInput("S");
    panel.handleInput("kip");
    panel.handleInput(ENTER);

    const result = panel.handleInput(ENTER);
    expect(result?.type).toBe("questions");
    if (result?.type === "questions") {
      expect(result.questions[0]?.answer).toBe("Skip");
      expect(result.questions[0]?.skipped).toBeUndefined();
    }
  });

  it("wraps a long question prompt inside the frame instead of truncating it", () => {
    const prompt = `这是一段会非常长的填空提示 ${"需要换行".repeat(30)} 结尾标记`;
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openQuestions([{ id: "note", title: "Note", prompt, kind: "freeText" }]);
    const rendered = text(panel, 40, 24);

    expect(rendered).toContain("这是一段会非常长的填空提示");
    expect(rendered).toContain("结尾标记");
  });

  it("does not treat content containing › as the selected row when scrolling", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setPlanItems(
      Array.from({ length: 10 }, (_, index) => ({
        id: `item-${index}`,
        label: index === 5 ? "含有 › 符号的普通行" : `计划项 ${index}`,
        status: "pending" as const,
        depth: 0,
      })),
    );
    const rendered = text(panel, 60, 6);

    expect(rendered).toContain("1-4 / 11");
    expect(rendered).toContain("计划项 0");
    expect(rendered).not.toContain("含有 › 符号的普通行");
  });

  it("lets the composer own Tab completion while the commands panel is open", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setCommandQuery("/");

    expect(panel.acceptsInput("\t")).toBe(false);
    expect(panel.acceptsInput(DOWN)).toBe(true);
  });

  it("shows CNY price without an FX reference line and never as a model-group total", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels(MODELS, MODEL_GROUPS, "kimi-k3");
    panel.open("models");
    expect(text(panel, 100, 18)).toContain("输入 ¥");
    expect(text(panel, 100, 18)).not.toMatch(/中国外汇交易中心参考价|USD\/CNY|2026-07-23/);
    panel.handleInput("\t");
    const group = text(panel, 100, 18);
    expect(group).toContain("默认");
    expect(group).not.toContain("¥");
  });

  it("completes single, multi, ranking and free-text questions through final review", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openQuestions(QUESTIONS);
    expect(text(panel)).toContain("第 1/4");
    panel.handleInput(ENTER);
    expect(text(panel)).toContain("第 2/4");
    panel.handleInput(SPACE);
    panel.handleInput(DOWN);
    panel.handleInput(SPACE);
    panel.handleInput(ENTER);
    expect(text(panel)).toContain("第 3/4");
    panel.handleInput(ENTER);
    panel.handleInput("必须保留流式稳定性");
    panel.handleInput(ENTER);
    expect(text(panel, 80, 16)).toContain("最终检查");
    const result = panel.handleInput(ENTER);
    expect(result?.type).toBe("questions");
    if (result?.type === "questions") {
      expect(result.questions).toHaveLength(4);
      expect(result.questions[3]?.answer).toBe("必须保留流式稳定性");
    }
  });

  it("edits a custom Provider without requesting a secret", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setProviders(PROVIDERS);
    panel.open("providers");
    for (let index = 0; index < 5; index += 1) panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    panel.handleInput(ENTER);
    const editor = text(panel);
    expect(editor).toContain("Base URL");
    expect(editor.toLowerCase()).not.toContain("api key");
    expect(panel.handleInput("\u0013")).toMatchObject({ type: "providerSave" });
  });
});
