import { Key } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE, MODEL_GROUPS, MODELS, PROVIDERS } from "../src/domain/fixtures.js";
import type { Question } from "../src/domain/types.js";
import type { StoredGoal } from "../src/goals/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { cellsForText, plainTheme, sgrCells } from "./helpers.js";

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
  it.each([40, 80, 120])("renders Goal status without overflow at %i columns", (width) => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    const goal: StoredGoal = {
      id: "goal-panel",
      revision: 7,
      semanticHash: "a".repeat(64),
      contract: {
        objective: "整理完整小说，并让跨轮执行保持可恢复且不会在阶段总结后静默停止",
        completionCriteria: ["完成全部章节"],
      },
      planId: "plan-novel",
      limits: { maxAutoRounds: 24, maxNoProgressRounds: 3, maxTokens: 500_000 },
      owner: { sessionId: "session-1", processId: "process-1", acquiredAt: "2026-07-31T00:00:00.000Z" },
      initialTokens: 0,
      state: "executing",
      autoRounds: 6,
      noProgressRounds: 0,
      consumedTokens: 42_000,
      markers: [
        {
          sequence: 2,
          recordedAt: "2026-07-31T00:10:00.000Z",
          currentItem: "第八章人物与事件索引",
          completedWork: ["已整理第一章至第七章"],
          evidence: ["index/chapter-01.md ... chapter-07.md"],
          nextItem: "整理第八章",
        },
      ],
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:10:00.000Z",
    };
    panel.setGoalSnapshot(goal, "OpenAI / GPT-5");
    panel.open("goal");
    const lines = panel.render(width, 22, plainTheme(), DEFAULT_USAGE);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    const rendered = lines.map(stripAnsi).join("\n");
    expect(rendered).toContain("执行中");
    expect(rendered).toContain("6/24 rounds");
    expect(rendered).toContain("OpenAI / GPT-5");
  });

  it.each([
    [0, 20, 20],
    [1, 20, 20],
    [6, 20, 20],
    [7, 20, 20],
    [20, 20, 20],
    [1, 5, 5],
    [20, 7, 7],
  ] as const)("sizes a %i-Session surface within %i rows to %i rows", (count, available, expected) => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.setSessions(
      Array.from({ length: count }, (_, index) => ({
        id: `session-${index}`,
        label: `Session ${index}`,
        relativeTime: "刚刚",
        branchDepth: 0,
      })),
    );

    expect(panel.sessionsSurfaceHeight(available)).toBe(expected);
    expect(panel.renderSessionsSurface(80, expected, plainTheme())).toHaveLength(expected);
  });

  it("spaces Resume Session entities and scrolls by entity rows", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.setSessions(
      Array.from({ length: 8 }, (_, index) => ({
        id: `session-${index}`,
        label: `Session ${index}`,
        relativeTime: `${index} 分钟前`,
        branchDepth: 0,
      })),
    );
    panel.open("sessions");

    const initial = panel.renderSessionsSurface(60, 7, plainTheme()).map(stripAnsi);
    const first = initial.findIndex((line) => line.includes("Session 0"));
    const second = initial.findIndex((line) => line.includes("Session 1"));
    expect(second).toBe(first + 2);
    expect(initial[first + 1]?.slice(1, -1).trim()).toBe("");

    for (let index = 0; index < 7; index += 1) panel.handleInput(DOWN);
    const scrolled = panel.renderSessionsSurface(60, 7, plainTheme()).map(stripAnsi).join("\n");
    expect(scrolled).toContain("› Session 7");
  });

  it("renders and filters the external history picker without overflowing", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.setExternalSessions([
      {
        id: "codex:one",
        source: "codex",
        sourceId: "one",
        title: "发布 VSPi 0.2.5",
        cwd: "/home/heyx/VSPi",
        updatedAt: "2026-07-26T12:00:00.000Z",
      },
      {
        id: "claude:two",
        source: "claude",
        sourceId: "two",
        title: "Question 交互修改",
        cwd: "/home/heyx/VSPi",
        updatedAt: "2026-07-25T12:00:00.000Z",
      },
    ]);
    panel.open("externalImport");
    expect(text(panel)).toContain("Codex  1");
    expect(text(panel)).toContain("发布 VSPi 0.2.5");
    expect(text(panel)).toContain("原始历史始终保持不变");

    panel.handleInput("\t");
    expect(text(panel)).toContain("Question 交互修改");
    panel.handleInput("Q");
    expect(panel.handleInput(ENTER)).toMatchObject({
      type: "externalImport",
      session: { id: "claude:two" },
    });
  });

  it("marks a Session owned by another TUI without exposing lease internals", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.setSessions([
      {
        id: "shared-session",
        label: "发布 0.2.5",
        relativeTime: "刚刚",
        branchDepth: 0,
        owner: { hostname: "genesis", pid: 18421, heartbeatAt: new Date().toISOString() },
      },
    ]);
    panel.open("sessions");
    expect(text(panel)).toContain("发布 0.2.5");
    expect(text(panel)).toContain("使用中");
    expect(text(panel)).not.toContain("18421");
  });

  it("flattens multi-line Session labels onto one physical row with run state", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.setSessions([
      {
        id: "multiline",
        label: "排查一下中转站目前的 GLM 代理报错\n\n开始测试账号：GLM-Pro-贺云翔\n\nAPI returned 404",
        relativeTime: "刚刚",
        branchDepth: 0,
        current: true,
      },
      {
        id: "leased",
        label: "单行会话",
        relativeTime: "17 小时前",
        branchDepth: 0,
        owner: { hostname: "genesis", pid: 42, heartbeatAt: new Date().toISOString() },
      },
    ]);
    panel.open("sessions");

    const height = panel.sessionsContentHeight(80, plainTheme());
    const rendered = panel.renderSessionsSurface(80, height, plainTheme());
    // visibleWidth 把 \n 当 0 宽，行内夹带换行时面板行数与物理行数不一致，会撑破框架与滚动对齐。
    expect(rendered).toHaveLength(height);
    expect(rendered.every((line) => !line.includes("\n"))).toBe(true);
    const plain = rendered.map(stripAnsi);
    const first = plain.findIndex((line) => line.includes("排查一下中转站"));
    expect(first).toBeGreaterThan(-1);
    // 标签压平后仍在同一行内展示，超出部分由右对齐截断省略，不再撑出额外物理行。
    expect(plain[first]).toContain("GLM 代理报错 开始测试账号");
    expect(plain[first]).toMatch(/… {0,2}当前│$/);
    expect(plain[first]).toContain("当前");
    expect(plain.findIndex((line) => line.includes("单行会话"))).toBe(first + 2);
    expect(plain.join("\n")).toContain("● 使用中");
  });

  it("returns all five structured approval decisions and layers Escape inside reason input", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    const request = {
      action: { kind: "network" as const, category: "ssh" as const, target: "ssh build-host" },
      category: "ssh" as const,
      policy: "Standard" as const,
      requiredPolicy: "YOLO" as const,
    };

    panel.openApproval(request);
    expect(text(panel)).toContain("允许本次");
    expect(panel.handleInput(ENTER)).toEqual({ type: "approval", response: { type: "allow-once" } });

    panel.openApproval(request);
    panel.handleInput(DOWN);
    expect(panel.handleInput(ENTER)).toEqual({
      type: "approval",
      response: { type: "allow-session", category: "ssh" },
    });

    panel.openApproval(request);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    expect(panel.handleInput(ENTER)).toEqual({
      type: "approval",
      response: { type: "elevate", level: "YOLO" },
    });

    panel.openApproval(request);
    for (let index = 0; index < 4; index += 1) panel.handleInput(DOWN);
    expect(panel.handleInput(ENTER)).toBeUndefined();
    panel.handleInput("不要连接生产环境");
    expect(panel.handleInput("\u001b")).toBeUndefined();
    expect(panel.kind).toBe("approval");
    for (let index = 0; index < 4; index += 1) panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    panel.handleInput("不要连接生产环境");
    expect(panel.handleInput(ENTER)).toEqual({
      type: "approval",
      response: { type: "deny", reason: "不要连接生产环境" },
    });
  });

  it.each([40, 80, 120] as const)("gives approval content and choices stable gutters at %s columns", (width) => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.openApproval({
      action: { kind: "process", category: "destructive", risk: "high", target: "rm -rf build/output" },
      category: "destructive",
      policy: "Standard",
      requiredPolicy: "Auto",
    });

    const lines = panel.render(width, 16, plainTheme(), DEFAULT_USAGE);
    const plain = lines.map(stripAnsi);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    expect(plain[1]).toContain("Standard");
    expect(plain[1]).toContain("删除或覆盖文件");
    expect(plain[2]).toContain("rm -rf build/output");
    expect(plain.join("\n")).toContain("提升到 Auto 并执行");
    expect(plain.some((line) => /^│\s{4,}› 1\. 允许本次/.test(line))).toBe(true);
    for (const option of [
      "1. 允许本次",
      "2. 本会话允许同类命令",
      "3. 提升到 Auto 并执行",
      "4. 拒绝",
      "5. 拒绝并说明",
    ]) {
      expect(plain.join("\n")).toContain(option);
    }
  });

  it.each(["Safe", "Standard", "YOLO", "Auto"] as const)(
    "renders %s as an eight-cell Policy badge beside the category",
    (policy) => {
      const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
      panel.openApproval({
        action: { kind: "network", category: "ssh", target: "ssh build-host" },
        category: "ssh",
        policy,
        ...(policy === "Auto" ? {} : { requiredPolicy: "Auto" as const }),
      });
      const lines = panel.render(80, 16, plainTheme({ colorLevel: 3, truecolor: true }), DEFAULT_USAGE);
      const badgeLine = lines[1] ?? "";
      const expectedBackground = {
        Safe: "rgb(36,74,49)",
        Standard: "rgb(84,69,31)",
        YOLO: "rgb(90,53,28)",
        Auto: "rgb(85,39,43)",
      }[policy];
      const backgroundCells = sgrCells(badgeLine).filter((cell) => cell.background === expectedBackground);
      expect(backgroundCells).toHaveLength(8);
      expect(cellsForText(badgeLine, policy).every((cell) => cell.background === expectedBackground)).toBe(true);
      expect(stripAnsi(lines[1] ?? "")).toContain("SSH 连接");
    },
  );

  it("edits Effort explicitly instead of cycling and immediately persisting", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openEffort("medium", ["off", "low", "medium", "high", "xhigh", "max"]);
    expect(text(panel)).toContain("✓ Medium");
    panel.handleInput(DOWN);
    expect(panel.handleInput(ENTER)).toEqual({ type: "effort", effort: "high" });
  });

  it("keeps Global and Project settings drafts separate until Ctrl+S applies", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.setSettingsLayers({
      global: { ...DEFAULT_SETTINGS, scope: "global", reducedMotion: false },
      project: { ...DEFAULT_SETTINGS, scope: "project", reducedMotion: true },
      projectInherited: false,
    });
    panel.open("settings");
    expect(text(panel)).toContain("减少动效  关");
    panel.handleInput(DOWN);
    expect(panel.handleInput(ENTER)).toBeUndefined();
    expect(text(panel)).toContain("未应用");
    expect(panel.handleInput("\u001b")).toEqual({ type: "close" });

    panel.open("settings");
    expect(text(panel)).toContain("减少动效  关");
    panel.handleInput("\t");
    expect(text(panel)).toContain("减少动效  开");
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    expect(panel.handleInput("\u0013")).toMatchObject({
      type: "settings",
      settings: { scope: "project", reducedMotion: false },
    });
  });

  it("cycles the three persisted Working styles and defaults to style 3", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.open("settings");
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    expect(text(panel, 80, 18)).toContain("Working 样式  3");
    panel.handleInput(ENTER);
    expect(text(panel, 80, 18)).toContain("Working 样式  1");
    panel.handleInput(ENTER);
    expect(text(panel, 80, 18)).toContain("Working 样式  2");
    panel.handleInput(ENTER);
    expect(text(panel, 80, 18)).toContain("Working 样式  3");
    expect(panel.handleInput("\u0013")).toMatchObject({
      type: "settings",
      settings: { workingStyle: 3 },
    });
  });

  it("keeps completed-tool collapse low-emphasis, enabled by default, and explicitly applicable", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.open("settings");
    expect(text(panel, 80, 18)).toContain("完成后收起工具  开");
    for (let index = 0; index < 6; index += 1) panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    expect(text(panel, 80, 18)).toContain("完成后收起工具  关");
    expect(panel.handleInput("\u0013")).toMatchObject({
      type: "settings",
      settings: { collapseTools: false },
    });
  });

  it("cycles the thinking display through hidden, collapsed, and expanded before Apply", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global", thinkingDisplay: "hidden" });
    panel.open("settings");
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    expect(text(panel, 80, 18)).toContain("thinking 显示模式  隐藏");
    panel.handleInput(ENTER);
    expect(text(panel, 80, 18)).toContain("thinking 显示模式  折叠");
    panel.handleInput(ENTER);
    expect(text(panel, 80, 18)).toContain("thinking 显示模式  展开");
    panel.handleInput(ENTER);
    expect(text(panel, 80, 18)).toContain("thinking 显示模式  隐藏");
    expect(panel.handleInput("\u0013")).toMatchObject({
      type: "settings",
      settings: { thinkingDisplay: "hidden" },
    });
  });

  it("edits and pastes a Thinking translation endpoint without losing the Settings draft", () => {
    const panel = new PanelController({ ...DEFAULT_SETTINGS, scope: "global" });
    panel.open("settings");
    for (let index = 0; index < 4; index += 1) panel.handleInput(DOWN);
    expect(text(panel, 90, 20)).toContain("思考翻译服务  关");

    panel.handleInput(ENTER);
    panel.handleInput("127.0.0.1:5000");
    expect(text(panel, 90, 20)).toContain("127.0.0.1:5000");
    panel.handleInput("\u001b");
    expect(text(panel, 90, 20)).toContain("思考翻译服务  关");

    panel.handleInput(ENTER);
    panel.handleInput("translate.local:8080");
    panel.handleInput(ENTER);
    expect(panel.handleInput("\u0013")).toMatchObject({
      type: "settings",
      settings: { thinkingTranslationEndpoint: "translate.local:8080" },
    });
  });

  it("renders the fresh plan as one compact empty-state row without demo content", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    const lines = panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi);
    const rendered = lines.join("\n");
    const body = lines
      .slice(1, -1)
      .map((line) => line.slice(1, -1).trim())
      .filter(Boolean);

    expect.soft(lines).toHaveLength(3);
    expect.soft(body).toEqual([]);
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
    expect(rendered).toContain("查看当前计划");
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
    expect(rendered).toContain("最近 Cache Hit Rate");
    expect(rendered).toContain("unknown");
    expect(rendered).not.toContain("0%");
  });

  it("renders cache accounting and separates catalog estimates from billed cost", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.open("usage");
    const rendered = panel
      .render(80, 20, plainTheme(), {
        ...DEFAULT_USAGE,
        inputTokens: 2_000,
        outputTokens: 500,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 1_000,
        recentCacheHitPercent: 80,
        sessionCacheHitPercent: 73,
        cacheMissTokens: 3_000,
        cacheMissCostUsd: 0.002,
      })
      .map(stripAnsi)
      .join("\n");

    expect(rendered).toContain("Cached");
    expect(rendered).toContain("8,000");
    expect(rendered).toContain("Cache miss 重复计费");
    expect(rendered).toContain("catalogEstimateCny");
    expect(rendered).toContain("providerBilledCny");
    expect(rendered).toContain("unknown");
    expect(rendered).toContain("1 USD = ¥6.80");
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

  it("edits Unicode free text at the cursor without switching questions", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openQuestions([
      { id: "note", title: "补充", prompt: "输入说明", kind: "freeText" },
      {
        id: "confirm",
        title: "确认",
        prompt: "确认答案",
        kind: "singleChoice",
        options: [{ id: "yes", label: "是" }],
      },
    ]);

    for (const character of "中文（）") panel.handleInput(character);
    panel.handleInput("\u001b[D");
    panel.handleInput("补");
    panel.handleInput("\u001b[C");
    panel.handleInput("充");
    panel.handleInput(Key.enter);

    expect(text(panel)).toContain("Question 2 / 2");
    panel.handleInput(Key.enter);
    const result = panel.handleInput(Key.enter);
    expect(result?.type).toBe("questions");
    if (result?.type === "questions") {
      expect(result.questions[0]?.answer).toBe("中文（补）充");
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

  it("groups Question metadata and prompt with space, then renders options as consecutive undecorated rows", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openQuestions([
      {
        id: "spacing",
        title: "Question spacing",
        prompt: "Choose a readable option",
        kind: "singleChoice",
        options: [
          { id: "first", label: "First option" },
          { id: "second", label: "Second option" },
        ],
      },
    ]);
    const lines = panel.render(80, 22, plainTheme(), DEFAULT_USAGE).map(stripAnsi);
    const blankBetween = (start: string, end: string) => {
      const startRow = lines.findIndex((line) => line.includes(start));
      const endRow = lines.findIndex((line) => line.includes(end));
      expect(startRow).toBeGreaterThan(0);
      expect(endRow).toBeGreaterThan(startRow);
      expect(lines.slice(startRow + 1, endRow).some((line) => line.slice(1, -1).trim() === "")).toBe(true);
    };

    blankBetween("Question 1 / 1", "Question spacing");
    blankBetween("Choose a readable option", "First option");
    const first = lines.findIndex((line) => line.includes("First option"));
    const second = lines.findIndex((line) => line.includes("Second option"));
    const other = lines.findIndex((line) => line.includes("其他"));
    expect(second).toBe(first + 1);
    expect(other).toBe(second + 1);
    expect(lines.find((line) => line.includes("Question spacing"))).toMatch(/^│\s{2,}/);
    expect(lines.join("\n")).toContain("› (●) First option");
    expect(lines.join("\n")).toContain("  ( ) Second option");
    expect(lines.join("\n")).not.toContain("┃");
    expect(lines.slice(first, other + 1).join("\n")).not.toMatch(/[┌┐└┘]|─{8,}/u);
    expect(lines[other + 1]?.slice(1, -1).trim()).toBe("");
    expect(lines[other + 2]).toContain("Enter 确认");
  });

  it("renders explicit multi-choice, ranking, and Question-local input affordances", () => {
    const multi = new PanelController(DEFAULT_SETTINGS);
    multi.openQuestions([
      {
        id: "multi",
        title: "Signals",
        prompt: "Choose signals",
        kind: "multiChoice",
        options: [
          { id: "context", label: "Context" },
          { id: "cost", label: "Cost" },
        ],
      },
    ]);
    expect(text(multi, 80, 22)).toContain("› [ ] Context");
    multi.handleInput(SPACE);
    expect(text(multi, 80, 22)).toContain("› [✓] Context");

    const ranking = new PanelController(DEFAULT_SETTINGS);
    ranking.openQuestions([
      {
        id: "ranking",
        title: "Priority",
        prompt: "Rank",
        kind: "ranking",
        options: [
          { id: "model", label: "Model" },
          { id: "provider", label: "Provider" },
        ],
      },
    ]);
    expect(text(ranking, 80, 22)).toContain("› 1. Model");
    expect(text(ranking, 80, 22)).toContain("  2. Provider");

    const freeText = new PanelController(DEFAULT_SETTINGS);
    freeText.openQuestions([{ id: "note", title: "Note", prompt: "Add details", kind: "freeText" }]);
    freeText.handleInput("A");
    const input = freeText.render(80, 22, plainTheme({ colorLevel: 3, truecolor: true }), DEFAULT_USAGE);
    expect(input.map(stripAnsi).join("\n")).toContain("› A");
    expect(input.map(stripAnsi).join("\n")).not.toContain("┃");
    expect(input.join("\n")).toContain("\u001b[7m");
  });

  it("keeps every wrapped row of the selected item visible when a long Question scrolls", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.openQuestions([
      {
        id: "boxed-scroll",
        title: "Box scrolling",
        prompt: "Choose the last entity",
        kind: "singleChoice",
        options: Array.from({ length: 8 }, (_, index) => ({
          id: `option-${index}`,
          label: `Option ${index}`,
          ...(index === 7 ? { description: "Last selected description ".repeat(5) } : {}),
        })),
      },
    ]);
    for (let index = 0; index < 7; index += 1) panel.handleInput(DOWN);
    const lines = panel.render(60, 18, plainTheme(), DEFAULT_USAGE).map(stripAnsi);
    expect(lines.join("\n")).toContain("Box scrolling");
    const selected = lines.findIndex((line) => line.includes("› (●) Option 7"));
    expect(selected).toBeGreaterThan(0);
    expect(lines.slice(selected + 1).join("\n")).toContain("Last selected description");
    expect(lines.at(-2)?.slice(1, -1).trim()).toBe("");
    expect(lines.at(-1)).toContain("Enter 确认");
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
    expect(text(panel)).toContain("Question 1 / 4");
    panel.handleInput(ENTER);
    expect(text(panel)).toContain("Question 2 / 4");
    panel.handleInput(SPACE);
    panel.handleInput(DOWN);
    panel.handleInput(SPACE);
    panel.handleInput(ENTER);
    expect(text(panel)).toContain("Question 3 / 4");
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
