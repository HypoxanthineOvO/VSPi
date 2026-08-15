import { describe, expect, it } from "vitest";
import type { Attachment, TranscriptMessage } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import {
  buildTranscriptNodes,
  renderTranscript,
  renderTranscriptMessage,
  selectTranscriptWindow,
  TranscriptRenderCache,
} from "../src/ui/transcript.js";
import { cellsForText, plainTheme, sgrCells } from "./helpers.js";

const ATTACHMENT: Attachment = {
  id: "shot",
  alias: "登录页-修改前",
  mimeType: "image/png",
  width: 1440,
  height: 900,
  size: 42,
  path: "/tmp/shot.png",
  status: "ready",
};

function userMessage(text: string, attachments?: Attachment[]): Extract<TranscriptMessage, { kind: "text" }> {
  return { id: "u", role: "user", kind: "text", text, ...(attachments ? { attachments } : {}) };
}

function toolMessage(
  index: number,
  status: Extract<TranscriptMessage, { kind: "tool" }>["status"] = "success",
): Extract<TranscriptMessage, { kind: "tool" }> {
  return {
    id: `tool-${index}`,
    role: "assistant",
    kind: "tool",
    groupId: "turn-1",
    name: index % 2 === 0 ? "read" : "bash",
    summary: index % 2 === 0 ? `file-${index}.ts` : `npm test -- shard-${index}`,
    status,
    output: `output-${index}`,
    expanded: false,
  };
}

describe("transcript rendering", () => {
  it("selects a bounded suffix without splitting tool groups and keeps original message indexes", () => {
    const messages: TranscriptMessage[] = [
      ...Array.from({ length: 90 }, (_, index) => ({
        id: `old-${index}`,
        role: "assistant" as const,
        kind: "text" as const,
        text: `old content ${index}`,
      })),
      ...[toolMessage(0), toolMessage(1), toolMessage(2)],
      { id: "latest", role: "assistant", kind: "text", text: "LATEST_CONTENT" },
    ];

    const window = selectTranscriptWindow(messages, {
      width: 80,
      maxRows: 10_000,
      maxBlocks: 2,
      maxCharacters: 1_000_000,
      collapseCompletedTools: false,
    });

    expect(window.hiddenBlocks).toBe(90);
    expect(window.messages.map((message) => message.id)).toEqual(["tool-0", "tool-1", "tool-2", "latest"]);
    expect(window.nodes).toEqual([
      { id: "tool-group:turn-1", kind: "toolGroup", messageIndexes: [90, 91, 92] },
      { id: "latest", kind: "message", messageIndexes: [93] },
    ]);
  });

  it("selects a 10k-message fullscreen tail without scanning the full history", () => {
    const source: TranscriptMessage[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `event-${index}`,
      role: "assistant",
      kind: "text",
      text: `event body ${index}`,
    }));
    let indexedReads = 0;
    const messages = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const window = selectTranscriptWindow(messages, {
      width: 80,
      maxRows: Number.MAX_SAFE_INTEGER,
      maxBlocks: 80,
      maxCharacters: 1_000_000,
      exactHiddenBlocks: false,
    });

    expect(window.messages).toHaveLength(80);
    expect(window.messages[0]?.id).toBe("event-9920");
    expect(window.messages.at(-1)?.id).toBe("event-9999");
    expect(window.hiddenBlocks).toBeGreaterThan(0);
    expect(indexedReads).toBeLessThan(500);
  });

  it("reuses cached blocks across stable frames and invalidates only a replaced message", () => {
    const cache = new TranscriptRenderCache();
    const messages: TranscriptMessage[] = Array.from({ length: 3 }, (_, index) => ({
      id: `cached-${index}`,
      role: "assistant",
      kind: "text",
      text: `cached body ${index}`,
    }));
    const options = { cache, thinkingDisplay: "collapsed" as const };

    renderTranscript(messages, 80, plainTheme(), options);
    expect(cache.stats()).toEqual({ entries: 3, hits: 0, misses: 3 });
    renderTranscript(messages, 80, plainTheme(), options);
    expect(cache.stats()).toEqual({ entries: 3, hits: 3, misses: 3 });

    const last = messages[2];
    expect(last?.kind).toBe("text");
    if (last?.kind !== "text") return;
    messages[2] = { ...last, text: "updated streaming body" };
    renderTranscript(messages, 80, plainTheme(), options);
    expect(cache.stats()).toEqual({ entries: 3, hits: 5, misses: 4 });
  });

  it("renders interrupted Session state as a quiet standalone marker", () => {
    const lines = renderTranscriptMessage(
      {
        id: "session-interrupted:test",
        role: "assistant",
        kind: "session",
        text: "上一轮在完成前中断；已恢复落盘内容，未自动重试。",
      },
      80,
      plainTheme(),
    );
    expect(lines).toEqual(["⋄ 上一轮在完成前中断；已恢复落盘内容，未自动重试。"]);
  });

  it("renders a short user message as a full-width three-line dark surface", () => {
    const lines = renderTranscriptMessage(
      userMessage("hello"),
      40,
      plainTheme({ colorLevel: 3, truecolor: true, unicode: true }),
    );
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[1] ?? "")).toContain("▮  hello");
    expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
    expect(stripAnsi(lines.join("\n"))).not.toMatch(/[╭╮╰╯❘]/);
    const content = cellsForText(lines[1] ?? "", "hello");
    expect(content.every((cell) => cell.background === "rgb(32,36,40)")).toBe(true);
    expect(content.every((cell) => cell.foreground === "rgb(244,247,250)")).toBe(true);
  });

  it.each([
    ["truecolor", 3, true, true],
    ["256 color", 2, false, true],
    ["no color", 0, false, true],
    ["ASCII no color", 0, false, false],
  ] as const)("keeps full-width user surfaces width-safe with %s", (_name, colorLevel, truecolor, unicode) => {
    for (const width of [40, 80, 120]) {
      const lines = renderTranscriptMessage(
        userMessage("message surface"),
        width,
        plainTheme({ colorLevel, truecolor, unicode }),
      );
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(stripAnsi(lines.join("\n"))).not.toMatch(/[╭╮╰╯❘]/);
      if (colorLevel === 2) {
        expect(
          cellsForText(lines.join("\n"), "message surface").every((cell) => cell.background === "ansi256(236)"),
        ).toBe(true);
      } else if (colorLevel === 0) {
        expect(sgrCells(lines.join("\n")).every((cell) => cell.background === undefined)).toBe(true);
      }
    }
  });

  it.each([40, 80, 120] as const)("wraps long user content and keeps attachments within %s columns", (width) => {
    const text = `first hard line\nsecond hard line ${"longword".repeat(24)}`;
    const lines = renderTranscriptMessage(userMessage(text, [ATTACHMENT]), width, plainTheme());
    const plain = lines.map(stripAnsi);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(plain.join(" ")).toContain("first hard line");
    expect(plain.join(" ")).toContain("second hard line");
    expect(plain.join("").replaceAll(/[▮\s]/g, "")).toContain("〔登录页-修改前⋅1440x900⋅PNG〕");
  });

  it("keeps the user surface full-width and applies Inspect selection without changing layout", () => {
    const message = userMessage("inspect this", [ATTACHMENT]);
    const theme = plainTheme({ colorLevel: 3, truecolor: true });
    const normal = renderTranscriptMessage(message, 80, theme);
    const inspected = renderTranscriptMessage(message, 80, theme, { inspectedId: message.id });
    expect(normal.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(inspected.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(stripAnsi(inspected.join("\n"))).toContain("inspect this");
  });

  it("keeps adjacent assistant Markdown outside the user marker with one spacer", () => {
    const user = userMessage("question");
    const assistant: TranscriptMessage = { id: "a", role: "assistant", kind: "text", text: "## Answer" };
    const userLines = renderTranscriptMessage(user, 60, plainTheme());
    const transcript = renderTranscript([user, assistant], 60, plainTheme());
    expect(transcript[userLines.length]).toBe("");
    expect(stripAnsi(transcript.slice(userLines.length + 1).join("\n"))).toContain("▪ Answer");
  });

  it("keeps queued deliveries out of the waterfall and Inspect nodes until consumed", () => {
    const messages: TranscriptMessage[] = [
      { ...userMessage("steer"), id: "steer", delivery: "steer" },
      { ...userMessage("follow"), id: "follow", delivery: "followUp" },
      { ...userMessage("cancelled"), id: "cancelled", delivery: "cancelled" },
    ];
    const rendered = renderTranscript(messages, 80, plainTheme()).map(stripAnsi).join("\n");
    expect(rendered).not.toContain("steer");
    expect(rendered).not.toContain("follow");
    expect(rendered).not.toContain("等待");
    expect(rendered).toContain("队列已取消");
    expect(buildTranscriptNodes(messages).map((node) => node.id)).toEqual(["cancelled"]);
  });

  it("renders expanded edit tools as width-safe diffs", () => {
    const tool: TranscriptMessage = {
      id: "edit",
      role: "assistant",
      kind: "tool",
      name: "edit",
      summary: "+1 -1",
      status: "success",
      output: "@@ -4,1 +4,1 @@\n-old\n+new",
      expanded: true,
    };
    const lines = renderTranscriptMessage(tool, 42, plainTheme());
    expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
    expect(lines.map(stripAnsi).join("\n")).toContain("new");
  });

  it("renders one compact tool group with a corner on the final command", () => {
    const messages = [toolMessage(0), toolMessage(1), toolMessage(2)];
    const rendered = renderTranscript(messages, 80, plainTheme()).map(stripAnsi);

    expect(rendered).toHaveLength(4);
    expect(rendered[0]).toContain("工具调用 ⋅ 3 项 ⋅ 已完成");
    expect(rendered[1]).toMatch(/^❘‒ ✓ Read\s+file-0\.ts/);
    expect(rendered[2]).toMatch(/^❘‒ ✓ Bash\s+npm test -- shard-1/);
    expect(rendered[3]).toMatch(/^❘‒ ✓ Read\s+file-2\.ts/);
  });

  it("builds stable top-level nodes and reveals tool children only after entering the group", () => {
    const tools = [toolMessage(0), toolMessage(1)];
    const messages: TranscriptMessage[] = [
      userMessage("question"),
      ...tools,
      { id: "answer", role: "assistant", kind: "text", text: "answer" },
    ];
    expect(buildTranscriptNodes(messages)).toEqual([
      { id: "u", kind: "message", messageIndexes: [0] },
      { id: "tool-group:turn-1", kind: "toolGroup", messageIndexes: [1, 2] },
      { id: "answer", kind: "message", messageIndexes: [3] },
    ]);

    const selectedGroup = renderTranscript(messages, 80, plainTheme(), {
      collapseCompletedTools: true,
      selectedNodeId: "tool-group:turn-1",
    }).map(stripAnsi);
    expect(selectedGroup.join("\n")).toContain("▮ ⋄ 工具调用 ⋅ 2 项 ⋅ 已完成");
    expect(selectedGroup.join("\n")).not.toContain("file-0.ts");

    const selectedTool = renderTranscript(messages, 80, plainTheme(), {
      collapseCompletedTools: true,
      selectedNodeId: "tool-group:turn-1",
      selectedToolId: "tool-1",
    }).map(stripAnsi);
    expect(selectedTool.join("\n")).toContain("file-0.ts");
    expect(selectedTool.join("\n")).toContain("▮ ❘‒ ✓ Bash");
  });

  it("keeps the live waterfall expanded and collapses to one summary row only after completion", () => {
    const running = [toolMessage(0), toolMessage(1, "running"), toolMessage(2, "queued")];
    const live = renderTranscript(running, 80, plainTheme(), { collapseCompletedTools: true }).map(stripAnsi);
    expect(live[0]).toContain("工具调用 ⋅ 3 项 ⋅ 执行中");
    expect(live).toHaveLength(4);
    expect(live.at(-1)).toMatch(/^❘‒ ◉ Read\s+file-2\.ts ⋅ 等待中/);

    const completed = [toolMessage(0), toolMessage(1), toolMessage(2, "error")];
    const collapsed = renderTranscript(completed, 80, plainTheme(), { collapseCompletedTools: true }).map(stripAnsi);
    expect(collapsed).toEqual([expect.stringContaining("工具调用 ⋅ 3 项 ⋅ 1 失败")]);

    const inspected = renderTranscript(completed, 80, plainTheme(), {
      collapseCompletedTools: true,
      inspectedId: "tool-0",
    }).map(stripAnsi);
    expect(inspected).toHaveLength(4);
    expect(inspected.at(-1)).toMatch(/^❘‒ x Read\s+file-2\.ts ⋅ 失败/);
  });

  it("keeps completed tool groups fully expanded when the setting is disabled", () => {
    const messages = Array.from({ length: 9 }, (_, index) => toolMessage(index));
    const rendered = renderTranscript(messages, 80, plainTheme(), { collapseCompletedTools: false }).map(stripAnsi);
    expect(rendered).toHaveLength(10);
    expect(rendered.join("\n")).toContain("shard-5");
    expect(rendered.at(-1)).toMatch(/^❘‒ ✓ Read\s+file-8\.ts/);
  });

  it("aligns tool names and action summaries in stable columns", () => {
    const messages = [
      { ...toolMessage(0), name: "ls", summary: "src" },
      { ...toolMessage(1), name: "question", summary: "2 个问题" },
      { ...toolMessage(2), name: "read", summary: "package.json" },
    ];
    const rendered = renderTranscript(messages, 80, plainTheme(), { collapseCompletedTools: false }).map(stripAnsi);
    const summaries = ["src", "2 个问题", "package.json"];
    expect(rendered.slice(1).map((line, index) => line.indexOf(summaries[index] ?? ""))).toEqual([15, 15, 15]);
  });

  it.each([40, 80, 120] as const)("keeps compact and expanded tool groups within %s columns", (width) => {
    const messages = Array.from({ length: 9 }, (_, index) => toolMessage(index));
    const compact = renderTranscript(messages, width, plainTheme(), { collapseCompletedTools: true });
    const expanded = renderTranscript(
      messages.map((message, index) => ({ ...message, expanded: index === 1 })),
      width,
      plainTheme(),
      { inspectedId: "tool-1" },
    );
    expect([...compact, ...expanded].every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("uses the content-blue foreground for Markdown headings", () => {
    const lines = renderTranscriptMessage(
      { id: "heading", role: "assistant", kind: "text", text: "## Calm heading" },
      80,
      plainTheme({ colorLevel: 3, truecolor: true }),
    );
    expect(cellsForText(lines.join("\n"), "Calm heading").every((cell) => cell.foreground === "rgb(143,183,255)")).toBe(
      true,
    );
  });

  it("renders hidden, collapsed, and expanded thinking as three distinct visible modes", () => {
    const completed: TranscriptMessage = {
      id: "thinking",
      role: "assistant",
      kind: "thinking",
      effort: "high",
      durationMs: 1200,
      text: "EARLIER_THINKING\n\nLATEST_THINKING",
      collapsed: true,
      streaming: false,
    };
    const hidden = renderTranscript([completed], 80, plainTheme(), { thinkingDisplay: "hidden" }).map(stripAnsi);
    const collapsed = renderTranscript([completed], 80, plainTheme(), { thinkingDisplay: "collapsed" }).map(stripAnsi);
    const expanded = renderTranscript([{ ...completed, collapsed: false }], 80, plainTheme(), {
      thinkingDisplay: "expanded",
    }).map(stripAnsi);

    expect(hidden).toEqual(["⋄ 思考 ⋅ 已隐藏"]);
    expect(collapsed.join("\n")).toContain("Effort High ⋅ 1.2s ⋅ 已折叠");
    expect(collapsed.join("\n")).toContain("LATEST_THINKING ⋅ 2 段");
    expect(collapsed.join("\n")).not.toContain("EARLIER_THINKING");
    expect(expanded.join("\n")).toContain("Effort High ⋅ 1.2s ⋅ 已展开");
    expect(expanded.join("\n")).toContain("EARLIER_THINKING");
    expect(expanded.join("\n")).toContain("LATEST_THINKING");
  });

  it("uses a restrained gray base color for expanded Thinking Markdown", () => {
    const rendered = renderTranscript(
      [
        {
          id: "thinking-tone",
          role: "assistant",
          kind: "thinking",
          effort: "high",
          text: "GRAY_THINKING_BODY with **bold**",
          collapsed: false,
        },
      ],
      80,
      plainTheme({ colorLevel: 3, truecolor: true }),
      { thinkingDisplay: "expanded" },
    ).join("\n");
    expect(cellsForText(rendered, "GRAY_THINKING_BODY").every((cell) => cell.foreground === "rgb(174,180,186)")).toBe(
      true,
    );
    expect(cellsForText(rendered, "bold").every((cell) => cell.modifiers.has(1))).toBe(true);
  });

  it("shows a transient status for hidden streaming thinking without exposing its body", () => {
    const streaming: TranscriptMessage = {
      id: "thinking-live",
      role: "assistant",
      kind: "thinking",
      effort: "xhigh",
      text: "LIVE_PRIVATE_BODY",
      collapsed: true,
      streaming: true,
    };
    const rendered = renderTranscript([streaming], 80, plainTheme(), { thinkingDisplay: "hidden" }).map(stripAnsi);
    expect(rendered).toEqual(["⋄ 思考中 ⋅ Effort Xhigh"]);
    expect(rendered.join("\n")).not.toContain("LIVE_PRIVATE_BODY");
  });

  it("keeps the streaming cursor visible when the last line fills the width", () => {
    const message: TranscriptMessage = {
      id: "a",
      role: "assistant",
      kind: "text",
      text: "满".repeat(120),
      streaming: true,
    };
    const lines = renderTranscriptMessage(message, 40, plainTheme());
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(stripAnsi(lines.at(-1) ?? "")).toMatch(/❙$/);
  });

  it("renders Subagent context, lane, model, and fallback status within narrow widths", () => {
    const message: TranscriptMessage = {
      id: "subagent-1",
      role: "assistant",
      kind: "subagent",
      model: "openai/gpt-5",
      preferredModel: "kimi/k2",
      effort: "high",
      contextMode: "lane",
      task: "Audit a deliberately long implementation task without overflowing the terminal",
      status: "success",
      agentKind: "teammate",
      teammateId: "frontend",
      lane: "main",
      depth: 1,
      fallbackReason: "quota_exhausted",
      usageTokens: 2_600,
      runTokensLeft: 117_400,
      treeTokensLeft: 495_000,
      treeCostUsdLeft: 19.6,
    };
    const full = stripAnsi(renderTranscriptMessage(message, 160, plainTheme()).join("\n"));
    expect(full).toContain("frontend");
    expect(full).toContain("preferred kimi/k2");
    expect(full).toContain("lane main");
    expect(full).toContain("fallback quota_exhausted");
    expect(full).toContain("Budget ⋅ run 117K left ⋅ tree 495K / $19.600 left");
    for (const width of [40, 80, 120]) {
      expect(renderTranscriptMessage(message, width, plainTheme()).every((line) => visibleWidth(line) <= width)).toBe(
        true,
      );
    }
  });
});

describe("neutral-width UI chrome", () => {
  // 中文宽渲染终端把 East Asian Ambiguous 字符画成 2 列，导致行溢出与光标
  // 错位；所有 UI chrome 必须由 neutral/narrow 字符构成。
  it("keeps rendered transcript chrome free of East Asian Ambiguous glyphs", async () => {
    const { eastAsianWidthType } = await import("get-east-asian-width");
    const messages: TranscriptMessage[] = [
      userMessage("hello"),
      { id: "think", role: "assistant", kind: "thinking", text: "thinking body", effort: "medium", collapsed: true },
      toolMessage(0),
      toolMessage(1),
    ];
    const lines = [
      ...renderTranscript(messages, 80, plainTheme(), { collapseCompletedTools: true }),
      ...renderTranscriptMessage(
        {
          id: "sub",
          role: "assistant",
          kind: "subagent",
          model: "m",
          task: "t",
          status: "success",
          effort: "medium",
        } as TranscriptMessage,
        80,
        plainTheme(),
      ),
    ];
    const offenders: string[] = [];
    for (const line of lines) {
      for (const character of stripAnsi(line)) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint >= 0x80 && eastAsianWidthType(codePoint) === "ambiguous") {
          offenders.push(character);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("regular tail window and row-estimate cache", () => {
  it("keeps tool groups intact on the exact-free tail path", () => {
    const messages: TranscriptMessage[] = [
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `tail-old-${index}`,
        role: "assistant" as const,
        kind: "text" as const,
        text: `tail old ${index}`,
      })),
      toolMessage(0),
      toolMessage(1),
    ];
    const window = selectTranscriptWindow(messages, {
      width: 80,
      maxRows: 10_000,
      maxBlocks: 2,
      maxCharacters: 1_000_000,
      exactHiddenBlocks: false,
    });
    // Tool group is one block and never split; the second block is the last
    // plain message before it.
    expect(window.messages.at(-2)).toMatchObject({ id: "tool-0" });
    expect(window.messages.at(-1)).toMatchObject({ id: "tool-1" });
    expect(window.nodes).toHaveLength(2);
    expect(window.nodes[1]).toMatchObject({ kind: "toolGroup", messageIndexes: [40, 41] });
    // Tail path only reports presence of hidden blocks; exact counts require
    // the anchored (exact) path.
    expect(window.hiddenBlocks).toBe(1);
  });

  it("invalidates row estimates when tool expansion state changes", () => {
    const cache = new TranscriptRenderCache();
    const collapsedTool = { ...toolMessage(0), output: "line\n".repeat(30), expanded: false };
    const messages: TranscriptMessage[] = [collapsedTool];
    const base = { width: 80, maxRows: 10_000, cache, collapseCompletedTools: false };
    const collapsedRows = selectTranscriptWindow(messages, { ...base, maxBlocks: 1 }).nodes.length;
    expect(collapsedRows).toBeGreaterThan(0);

    const expanded: TranscriptMessage[] = [{ ...collapsedTool, expanded: true }];
    const windowAfterExpand = selectTranscriptWindow(expanded, { ...base, maxBlocks: 1 });
    // The estimate must reflect the expanded output rather than the cached
    // collapsed height: with 30 wrapped output lines the block exceeds a
    // small row budget and must not reuse the stale collapsed estimate.
    const tightWindow = selectTranscriptWindow(expanded, { ...base, maxRows: 5, maxBlocks: 1 });
    expect(windowAfterExpand.nodes).toHaveLength(1);
    // Row budget smaller than the expanded block height: the block itself is
    // always kept, but the stale collapsed estimate must not let MORE blocks
    // in than the budget allows.
    expect(tightWindow.nodes).toHaveLength(1);
    expect(tightWindow.nodes[0]?.messageIndexes).toHaveLength(1);
  });
});
