import { Key } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { Question } from "../src/domain/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

const SINGLE_QUESTION: Question = {
  id: "layout",
  title: "布局",
  prompt: "选择布局",
  kind: "singleChoice",
  options: [
    { id: "dense", label: "紧凑", description: "sk-live-PRIVATE_OPTION_DETAIL" },
    { id: "calm", label: "舒展" },
  ],
};
const MULTI_QUESTION: Question = {
  id: "features",
  title: "功能",
  prompt: "选择功能",
  kind: "multiChoice",
  options: [
    { id: "search", label: "搜索" },
    { id: "export", label: "导出" },
  ],
};
const RANKING_QUESTION: Question = {
  id: "priority",
  title: "优先级",
  prompt: "排列优先级",
  kind: "ranking",
  options: [
    { id: "quality", label: "质量" },
    { id: "speed", label: "速度" },
  ],
};
const FREE_TEXT_QUESTION: Question = {
  id: "note",
  title: "补充",
  prompt: "补充说明 /home/private/project/PRIVATE_PROMPT",
  kind: "freeText",
};
const QUESTIONS: Question[] = [SINGLE_QUESTION, MULTI_QUESTION, RANKING_QUESTION, FREE_TEXT_QUESTION];

interface QuestionToolModule {
  UserQuestionCancelledError?: new (message?: string) => Error;
  createQuestionToolDefinition(options: {
    request: (questions: Question[], signal?: AbortSignal) => Promise<Question[]>;
  }): {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: unknown;
    execute(
      callId: string,
      params: { questions: Question[] },
      signal?: AbortSignal,
    ): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
  };
}

async function loadQuestionTool(): Promise<QuestionToolModule | undefined> {
  const modulePath = "../src/questions/tool.js";
  return import(modulePath).catch(() => undefined) as Promise<QuestionToolModule | undefined>;
}

function openQuestions(panel: PanelController, questions: Question[]): void {
  const contract = panel as unknown as { openQuestions?: (input: Question[]) => void };
  expect(contract.openQuestions, "PanelController must accept questions supplied by the active tool call").toBeTypeOf(
    "function",
  );
  contract.openQuestions?.(structuredClone(questions));
}

function panelText(panel: PanelController): string {
  return panel.render(80, 18, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
}

describe("M5 Question ToolDefinition", () => {
  it("exports a real Question tool schema covering all four question kinds", async () => {
    const module = await loadQuestionTool();
    expect(module, "src/questions/tool.ts must export createQuestionToolDefinition").toBeDefined();
    if (!module) return;

    const tool = module.createQuestionToolDefinition({ request: vi.fn(async (questions) => questions) });
    const schema = JSON.stringify(tool.parameters);

    expect(tool).toMatchObject({ name: "question", label: "Question" });
    expect(tool.description).toMatch(/whenever progress requires a user answer/i);
    expect(tool.promptSnippet).toMatch(/Do not replace approvals with question/i);
    for (const kind of ["singleChoice", "multiChoice", "ranking", "freeText"]) expect(schema).toContain(kind);
    for (const field of ["questions", "id", "title", "prompt", "options", "description"])
      expect(schema).toContain(field);
  });

  it("waits for the app bridge and returns answer-only redacted details", async () => {
    let resolveAnswers: ((questions: Question[]) => void) | undefined;
    const request = vi.fn(
      async () =>
        new Promise<Question[]>((resolve) => {
          resolveAnswers = resolve;
        }),
    );
    const module = await loadQuestionTool();
    expect(module).toBeDefined();
    if (!module) return;
    const tool = module.createQuestionToolDefinition({ request });
    const execution = tool.execute("question-1", { questions: QUESTIONS });

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    let settled = false;
    void execution.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveAnswers?.([
      { ...SINGLE_QUESTION, answer: "dense" },
      { ...MULTI_QUESTION, answer: ["search", "export"] },
      { ...RANKING_QUESTION, answer: ["speed", "quality"] },
      { ...FREE_TEXT_QUESTION, skipped: true },
    ]);
    const result = await execution;
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("dense");
    expect(serialized).toContain("speed");
    expect(serialized).toContain("skipped");
    expect(serialized).not.toContain("PRIVATE_PROMPT");
    expect(serialized).not.toContain("PRIVATE_OPTION_DETAIL");
    expect(serialized).not.toContain("/home/private/project");
    expect(serialized).not.toContain("sk-live-");
    expect(Object.keys((result.details ?? {}) as object)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/path|secret/i)]),
    );
  });

  it("returns a cancellable ToolResult with a continuation hint when the user closes the UI", async () => {
    const module = await loadQuestionTool();
    expect(module).toBeDefined();
    if (!module) return;
    const request = vi.fn(async () => {
      const Cancelled = module.UserQuestionCancelledError;
      if (!Cancelled) throw new Error("UserQuestionCancelledError export is missing");
      throw new Cancelled("Question cancelled by user");
    });
    const tool = module.createQuestionToolDefinition({ request });
    const result = await tool.execute("question-user-cancel", { questions: QUESTIONS });
    const serialized = JSON.stringify(result);

    expect(result.details).toMatchObject({
      cancelledByUser: true,
      continuationHint: expect.stringMatching(/plain assistant text|continue/i),
      answers: QUESTIONS.map((question) => ({ id: question.id, skipped: true })),
    });
    expect(serialized).toContain("cancelledByUser");
    expect(serialized).toContain("continuationHint");
    expect(serialized).not.toContain("AbortError");
    expect(serialized).not.toContain("PRIVATE_PROMPT");
    expect(serialized).not.toContain("PRIVATE_OPTION_DETAIL");
  });

  it("forwards AbortSignal to the pending request and stops with AbortError", async () => {
    const request = vi.fn(
      async (_questions: Question[], signal?: AbortSignal) =>
        new Promise<Question[]>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("question cancelled");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    const module = await loadQuestionTool();
    expect(module).toBeDefined();
    if (!module) return;

    const controller = new AbortController();
    const execution = module
      .createQuestionToolDefinition({ request })
      .execute("question-abort", { questions: QUESTIONS }, controller.signal);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]?.[1]).toBe(controller.signal);
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("M5 dynamic Question panel", () => {
  it("renders caller-supplied questions instead of fixture content and switches with Left/Right", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    openQuestions(panel, QUESTIONS);

    expect(panelText(panel)).toMatch(/Question 1 \/ 4[\s\S]*布局/);
    panel.handleInput(Key.right);
    expect(panelText(panel)).toMatch(/Question 2 \/ 4[\s\S]*功能/);
    panel.handleInput(Key.left);
    expect(panelText(panel)).toMatch(/Question 1 \/ 4[\s\S]*布局/);
  });

  it("reorders ranking options with Ctrl/Alt arrows without changing questions", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    openQuestions(panel, [RANKING_QUESTION]);

    panel.handleInput(Key.down);
    panel.handleInput(Key.ctrl("up"));
    expect(panelText(panel)).toMatch(/1\. 速度[\s\S]*2\. 质量/);
    panel.handleInput(Key.alt("down"));
    expect(panelText(panel)).toMatch(/1\. 质量[\s\S]*2\. 速度/);
  });

  it("supports direct, other, free-text, skip and final review for dynamic questions", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    openQuestions(panel, [
      { ...SINGLE_QUESTION, id: "direct", title: "直接" },
      { ...SINGLE_QUESTION, id: "other", title: "其他" },
      FREE_TEXT_QUESTION,
      { ...SINGLE_QUESTION, id: "skip", title: "跳过" },
    ]);

    panel.handleInput(Key.tab);
    panel.handleInput("直接文本");
    panel.handleInput(Key.enter);
    panel.handleInput(Key.down);
    panel.handleInput(Key.down);
    panel.handleInput(Key.enter);
    panel.handleInput("其他文本");
    panel.handleInput(Key.enter);
    // freeText 输入态下 Shift+S 是字面大写 "S"（真实终端发送的就是 "S"），不触发跳过。
    panel.handleInput("S");
    panel.handleInput("自由文本");
    panel.handleInput(Key.enter);
    // 跳过键在选择导航态生效。
    panel.handleInput(Key.shift("s"));
    expect(panelText(panel)).toContain("最终检查");
    expect(panelText(panel)).toContain("直接文本");
    expect(panelText(panel)).toContain("其他文本");
    expect(panelText(panel)).toContain("S自由文本");
    expect(panelText(panel)).toContain("已跳过");
    expect(panel.handleInput(Key.enter)).toMatchObject({ type: "questions" });
  });

  it("renders only actions available for the current question state", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    openQuestions(panel, [SINGLE_QUESTION, FREE_TEXT_QUESTION]);
    const choiceHint = stripAnsi(panel.renderHint(80, plainTheme()));

    expect(choiceHint).toContain("←→ 切题");
    expect(choiceHint).toContain("↑↓ 选择");
    expect(choiceHint).toContain("Tab 直接回答");
    expect(choiceHint).toContain("Shift+S 跳过");
    expect(choiceHint).not.toContain("Space 多选");

    panel.handleInput(Key.right);
    const freeTextHint = stripAnsi(panel.renderHint(80, plainTheme()));
    expect(freeTextHint).toContain("Enter 确认");
    expect(freeTextHint).toContain("←→ 移动光标");
    expect(freeTextHint).not.toContain("←→ 切题");
    expect(freeTextHint).not.toContain("Shift+S");
    expect(freeTextHint).not.toMatch(/↑↓ 选择|Tab 直接回答|Space/);

    const multi = new PanelController(DEFAULT_SETTINGS);
    openQuestions(multi, [MULTI_QUESTION]);
    expect(stripAnsi(multi.renderHint(80, plainTheme()))).toContain("Space 多选");

    const ranking = new PanelController(DEFAULT_SETTINGS);
    openQuestions(ranking, [RANKING_QUESTION]);
    const rankingHint = stripAnsi(ranking.renderHint(80, plainTheme()));
    expect(rankingHint).toMatch(/Ctrl\/(?:Alt|Option)\+↑↓ 重排/);
    expect(rankingHint).toContain("Tab 直接回答");
    expect(rankingHint).toContain("Shift+S 跳过");

    ranking.handleInput(Key.shift("s"));
    const reviewHint = stripAnsi(ranking.renderHint(80, plainTheme()));
    expect(reviewHint).toMatch(/Enter .*提交/);
    expect(reviewHint).toMatch(/← .*返回/);
    expect(reviewHint).not.toMatch(/选择|直接回答|跳过|重排|Space/);
  });

  it("keeps the aligned layout when every option fits and never truncates text", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    openQuestions(panel, [SINGLE_QUESTION]);
    const rendered = panelText(panel);
    expect(rendered).toContain("紧凑");
    expect(rendered).not.toContain("…");
    expect(panel.hintRenderedInline()).toBe(false);
  });

  it("wraps long option labels and descriptions as whole selected blocks without truncation", () => {
    const longLabel = `超长选项标签 ${"需要完整换行展示而不是被截断".repeat(6)}`;
    const longDescription = `说明 ${"这段描述也必须完整保留".repeat(8)}`;
    const panel = new PanelController(DEFAULT_SETTINGS);
    openQuestions(panel, [
      {
        id: "long",
        title: "长选项",
        prompt: "选择一项",
        kind: "singleChoice",
        options: [
          { id: "a", label: longLabel, description: longDescription },
          { id: "b", label: "短" },
        ],
      },
    ]);

    const raw = panel.render(80, 18, plainTheme(), DEFAULT_USAGE);
    const rendered = raw.map(stripAnsi).join("\n");
    expect(rendered).not.toContain("…");
    for (const fragment of ["需要完整换行展示而不是被截断", "这段描述也必须完整保留"]) {
      expect(rendered).toContain(fragment);
    }
    // 选中块的所有行共享选中标记（›），滚动定位以块为单位
    const selectedRows = raw.map(stripAnsi).filter((line) => line.includes("› "));
    expect(selectedRows.length).toBeGreaterThan(1);
    expect(selectedRows.join("\n")).toContain("需要完整换行");
  });

  it("moves the key hint into the scrollable body when question content overflows", () => {
    const manyOptions = Array.from({ length: 12 }, (_, index) => ({
      id: `opt-${index}`,
      label: `选项 ${index} ${"内容".repeat(10)}`,
      description: `描述 ${index} ${"细节".repeat(12)}`,
    }));
    const panel = new PanelController(DEFAULT_SETTINGS);
    openQuestions(panel, [{ id: "many", title: "多选项", prompt: "选择", kind: "singleChoice", options: manyOptions }]);

    panel.render(80, 10, plainTheme(), DEFAULT_USAGE);
    expect(panel.hintRenderedInline()).toBe(true);

    const roomy = new PanelController(DEFAULT_SETTINGS);
    openQuestions(roomy, [SINGLE_QUESTION]);
    roomy.render(80, 18, plainTheme(), DEFAULT_USAGE);
    expect(roomy.hintRenderedInline()).toBe(false);
  });
});
