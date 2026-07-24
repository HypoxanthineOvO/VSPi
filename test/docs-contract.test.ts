import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

const BLOCK_LOGO = [
  "██╗   ██╗███████╗██████╗ ██╗",
  "██║   ██║██╔════╝██╔══██╗██║",
  "██║   ██║███████╗██████╔╝██║",
  "╚██╗ ██╔╝╚════██║██╔═══╝ ██║",
  " ╚████╔╝ ███████║██║     ██║",
  "  ╚═══╝  ╚══════╝╚═╝     ╚═╝",
] as const;

const PRODUCTION_COMMANDS = [
  "/new",
  "/sessions",
  "/compact",
  "/model",
  "/providers",
  "/plan",
  "/prompt",
  "/thinking",
  "/effort",
  "/policy",
  "/usage",
  "/settings",
  "/theme",
  "/quit",
] as const;

const REMOVED_COMMANDS = ["/demo-question", "/demo-tool"] as const;

const COMMAND_HINT = "↑↓ 选择  Tab 补全  Enter 执行  Esc 关闭";

let readme = "";
let docs = "";

beforeAll(async () => {
  [readme, docs] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../Docs/tui-v1.md", import.meta.url), "utf8"),
  ]);
});

function textBlocks(content: string): string[] {
  return Array.from(content.matchAll(/```text\s*\n([\s\S]*?)```/g), (match) => match[1] ?? "");
}

function productionCommandBlock(content: string): string | undefined {
  return textBlocks(content).find((block) => block.includes("/new") && block.includes("/quit"));
}

function visibleWidth(text: string): number {
  return Array.from(text).reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const wide =
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60);
    return width + (wide ? 2 : 1);
  }, 0);
}

function visibleColumn(line: string, label: string): number {
  const index = line.indexOf(label);
  return index < 0 ? -1 : visibleWidth(line.slice(0, index));
}

type MarkedSpan = { kind: "normal" | "emphasis"; text: string };

function markedToken(content: string, token: string): MarkedSpan[] | undefined {
  for (const line of content.split("\n")) {
    const spans = Array.from(
      line.matchAll(/[[〔]\s*(普通|强调)\s*[:：]\s*([^\]〕]*?)[\]〕]/g),
      (match): MarkedSpan => ({
        kind: match[1] === "强调" ? "emphasis" : "normal",
        text: (match[2] ?? "").trim(),
      }),
    );
    if (spans.map((span) => span.text).join("") === token) return spans;
  }
  return undefined;
}

function expectMarkedToken(token: string, expected: ReadonlyArray<MarkedSpan["kind"]>): void {
  const spans = markedToken(docs, token);
  expect(spans, `Docs must bracket every visible cell of ${token} as 普通 or 强调`).toBeDefined();
  expect(spans?.flatMap((span) => Array.from(span.text, () => span.kind)) ?? []).toEqual(expected);
}

function expectSharedFacts(content: string, artifact: string): void {
  expect.soft(content, `${artifact}: fresh Plan empty state`).toContain("当前计划为空");
  expect.soft(content, `${artifact}: examples are not preset`).toContain("交互示例");
  expect
    .soft(content, `${artifact}: default dynamic interface is empty`)
    .toMatch(/(?:默认|新(?:会话|工作区))[^。\n]{0,180}(?:动态界面|会话)[^。\n]{0,120}(?:为空|不(?:加载|预置|包含))/);
  expect.soft(content, `${artifact}: no demo Plan title`).not.toContain("当前计划  TUI v1");
  expect.soft(content, `${artifact}: no demo Plan progress`).not.toContain("2 / 5");
  expect.soft(content, `${artifact}: no demo usage`).not.toMatch(/42k|8\.1k|Kimi \/ K3/);

  expect.soft(content, `${artifact}: six-line splash statement`).toMatch(/(?:六行|6\s*行).*(?:Logo|logo|块字符|block)/);
  expect.soft(content, `${artifact}: splash final frame`).toContain("最终帧");
  expect.soft(content, `${artifact}: terminal scrollback`).toContain("scrollback");
  expect
    .soft(content, `${artifact}: initial frame is brand-only`)
    .toMatch(
      /(?:初始|initial)[^。\n]{0,180}(?:品牌|brand)[^。\n]{0,180}(?:不(?:含|显示|声明).*(?:状态|模型|Mode)|仅|只)/i,
    );
  expect
    .soft(content, `${artifact}: final frame waits for initialization`)
    .toMatch(
      /(?:初始化[^。\n]{0,140}(?:完成|成功|解析)[^。\n]{0,140}最终帧|最终帧[^。\n]{0,160}(?:等待|晚于|之后).*初始化)/i,
    );
  expect.soft(content, `${artifact}: resolved Model`).toMatch(/(?:真实|解析|resolved)[^。\n]{0,120}Model/i);
  expect.soft(content, `${artifact}: Backend Pi`).toContain("Backend Pi");
  expect.soft(content, `${artifact}: Backend Fixture`).toContain("Backend Fixture");
  expect.soft(content, `${artifact}: Policy boundary`).toMatch(/Policy[^。\n]{0,100}(?:Sandboxed|Host)/);
  expect.soft(content, `${artifact}: no legacy Mode Auto`).not.toMatch(/Mode[^。\n]{0,60}Auto/);
  expect.soft(content, `${artifact}: package-derived version`).toMatch(/package\.json|package version|包版本/i);
  expect.soft(content, `${artifact}: no legacy pseudo-status`).not.toContain("Home · auto/safe · Web");
  expect.soft(content, `${artifact}: no legacy provider list`).not.toContain("Kimi / OpenAI / DeepSeek");
  expect
    .soft(content, `${artifact}: splash committed before dynamic TUI`)
    .toMatch(
      /(?:最终帧.*(?:提交|写入).*scrollback.*动态 TUI|最终帧.*动态 TUI.*前.*(?:提交|写入).*scrollback|动态 TUI.*之?前.*(?:提交|写入).*scrollback)/i,
    );
  expect.soft(content, `${artifact}: later renders preserve splash`).toMatch(/不(?:会|被).*(?:擦除|清除|覆盖|刷掉)/);

  for (const label of ["Model", "Effort", "Context", "Token", "Cost"]) {
    expect.soft(content, `${artifact}: status label ${label}`).toContain(label);
  }
  expect.soft(content, `${artifact}: unlabeled path`).toMatch(/不显示[^。\n]{0,40}`?Path`?[^。\n]{0,40}(?:标题|标签)/);
  expect.soft(content, `${artifact}: fixed Model/Effort gap`).toMatch(/Model[^。\n]{0,80}Effort[^。\n]{0,80}两个空格/);
  expect
    .soft(content, `${artifact}: color-separated status labels`)
    .toMatch(/(?:(?:标签|字段).*(?:颜色|分色|着色).*(?:区分|分离|分别)?|(?:颜色|分色|着色).*(?:标签|字段))/);
  expect.soft(content, `${artifact}: 80-column two-line status`).toMatch(/`?80`?\s*列.*两行/);

  expect
    .soft(content, `${artifact}: wide model split`)
    .toMatch(/(?:60|80)(?:\+|\s*列(?:及以上|以上)).*左.*列表.*右.*详情/);
  expect
    .soft(content, `${artifact}: CNY price only in detail`)
    .toMatch(/(?:(?:CNY|人民币|价格).*(?:仅|只).*(?:右侧)?详情|(?:右侧)?详情.*(?:仅|只).*(?:CNY|人民币|价格))/);
  expect.soft(content, `${artifact}: no displayed FX row`).toContain("不显示汇率参考行");
  expect
    .soft(content, `${artifact}: no stale displayed FX sample`)
    .not.toMatch(/中国外汇交易中心参考价\s*·|USD\/CNY\s*7\.18/);

  const commandBlock = productionCommandBlock(content);
  expect.soft(commandBlock, `${artifact}: literal production command block`).toBeDefined();
  for (const command of PRODUCTION_COMMANDS) {
    expect.soft(commandBlock, `${artifact}: production command ${command}`).toContain(command);
  }
  for (const command of REMOVED_COMMANDS) {
    expect.soft(commandBlock, `${artifact}: removed command ${command}`).not.toContain(command);
  }
  expect
    .soft(content, `${artifact}: removed Update command is absent from the whole artifact`)
    .not.toContain("/update");
  expect
    .soft(content, `${artifact}: self-update is explicitly outside the v0.1 production surface`)
    .toMatch(/自更新[^。\n]{0,120}(?:不属于|不在|不提供|后续)[^。\n]{0,80}v0\.1/i);
}

function hasNearby(content: string, left: string[], right: string[], distance = 240): boolean {
  const normalized = content.replace(/\s+/g, " ").toLowerCase();
  const positions = (term: string): number[] => {
    const output: number[] = [];
    const needle = term.toLowerCase();
    let start = 0;
    while (start <= normalized.length) {
      const index = normalized.indexOf(needle, start);
      if (index < 0) break;
      output.push(index);
      start = index + Math.max(1, needle.length);
    }
    return output;
  };
  const leftPositions = left.flatMap(positions);
  const rightPositions = right.flatMap(positions);
  return leftPositions.some((leftIndex) =>
    rightPositions.some((rightIndex) => Math.abs(leftIndex - rightIndex) <= distance),
  );
}

function hasCanonicalQuitAliases(content: string): boolean {
  return content.split(/[。\n]/).some((clause) => {
    const normalized = clause.replace(/\s+/g, " ");
    return (
      /(?:别名|aliases?)/i.test(normalized) &&
      /\/quit(?![\w-])/i.test(normalized) &&
      /\/exit(?![\w-])/i.test(normalized) &&
      /\/q(?![\w-])/i.test(normalized)
    );
  });
}

function expectRevisionFiveFacts(content: string, artifact: string): void {
  const normalized = content.replace(/\s+/g, " ");
  for (const sample of ["Context 50K / 128K 39%", "Context 0K / 0K 0%", "Context ?K / 128K ?%"] as const) {
    expect.soft(content, `${artifact}: Context sample ${sample}`).toContain(sample);
  }
  expect.soft(content, `${artifact}: cumulative Token mock`).toMatch(/Token\s*↑[^\s]+\s*↓[^\s]+/);
  expect
    .soft(
      hasNearby(content, ["Context"], ["当前", "占用", "current", "used"]),
      `${artifact}: Context means current used`,
    )
    .toBe(true);
  expect
    .soft(hasNearby(content, ["Context"], ["窗口", "window"]), `${artifact}: Context includes the model window`)
    .toBe(true);
  expect
    .soft(hasNearby(content, ["Context"], ["百分比", "percent"]), `${artifact}: Context includes percent`)
    .toBe(true);
  expect
    .soft(hasNearby(content, ["Token"], ["累计", "cumulative"]), `${artifact}: Token is cumulative and separate`)
    .toBe(true);

  expect.soft(content, `${artifact}: alias mock`).toMatch(/quit\s*[（(]\s*\/?exit\s*[）)]/i);
  expect
    .soft(hasCanonicalQuitAliases(content), `${artifact}: canonical aliases /exit and /q belong to /quit`)
    .toBe(true);
  expect
    .soft(content, `${artifact}: /clear belongs to /new`)
    .toMatch(/(?:\/clear[^。\n]{0,100}\/new|\/new[^。\n]{0,100}\/clear)/);
  expect
    .soft(content, `${artifact}: /session and /resume belong to /sessions`)
    .toMatch(
      /\/sessions[^。\n]{0,140}\/session[^。\n]{0,80}\/resume|\/sessions[^。\n]{0,140}\/resume[^。\n]{0,80}\/session/,
    );
  expect
    .soft(content, `${artifact}: /provider belongs to /providers`)
    .toMatch(/(?:\/provider[^s][^。\n]{0,100}\/providers|\/providers[^。\n]{0,100}\/provider(?:\W|$))/);
  expect.soft(content, `${artifact}: /thinking is canonical, not an alias`).not.toMatch(/别名[^。\n]{0,180}\/thinking/);
  expect.soft(normalized, `${artifact}: alias completion`).toMatch(/\/ex\s*→\s*\/exit/);
  expect.soft(normalized, `${artifact}: canonical completion`).toMatch(/\/qui\s*→\s*\/quit/);
  expect.soft(normalized, `${artifact}: session completion`).toMatch(/\/ses\s*→\s*\/sessions/);
  expect.soft(normalized, `${artifact}: provider completion`).toMatch(/\/provi\s*→\s*\/providers/);
  expect.soft(normalized, `${artifact}: clear completion`).toMatch(/\/cl\s*→\s*\/clear/);
  expect
    .soft(content, `${artifact}: slash directory has no emphasis`)
    .toMatch(/(?:单独|仅|输入)[^。\n]{0,40}`?\/?`?[^。\n]{0,120}(?:目录|完整命令)[^。\n]{0,120}不(?:高亮|强调)/);
  expect
    .soft(content, `${artifact}: /exit emphasizes only ex`)
    .toMatch(
      /\/ex(?:it)?[^。\n]{0,180}(?:只强调\s*`?ex`?|强调范围[^。\n]{0,30}`?ex`?)[^。\n]{0,140}(?:slash|斜杠|`?it`?|普通)/i,
    );
  expect
    .soft(content, `${artifact}: /quit emphasizes only qui`)
    .toMatch(
      /\/qui(?:t)?[^。\n]{0,180}(?:只强调\s*`?qui`?|强调范围[^。\n]{0,30}`?qui`?)[^。\n]{0,140}(?:slash|斜杠|`?t`?|普通)/i,
    );
  expect.soft(content, `${artifact}: Tab is the only completion key`).toMatch(/Tab[^。\n]{0,100}(?:唯一|仅有|只)/i);
  expect.soft(content, `${artifact}: unique candidate completion`).toMatch(/唯一(?:候选|匹配)/);
  expect.soft(content, `${artifact}: completion requires no arguments`).toMatch(/(?:无|不带|没有)参数/);
  expect.soft(normalized, `${artifact}: Tab never executes`).toMatch(/Tab.{0,180}不(?:会|自动)?执行/i);
  expect
    .soft(normalized, `${artifact}: Tab never writes history`)
    .toMatch(/Tab.{0,220}(?:不(?:写入|改变|污染).{0,60}(?:history|历史)|(?:history|历史).{0,60}不)/i);
  expect
    .soft(
      hasNearby(content, ["插件", "扩展", "plugin"], ["package", "source", "来源"]),
      `${artifact}: plugin package source`,
    )
    .toBe(true);

  expect.soft(content, `${artifact}: composer matching`).toMatch(/composer/i);
  expect.soft(content, `${artifact}: command matching`).toMatch(/(?:Command|命令)/i);

  for (const width of [40, 80, 120]) {
    expect.soft(content, `${artifact}: ${width}-column responsive contract`).toMatch(new RegExp(`${width}\\s*列`));
    expect
      .soft(
        hasNearby(content, ["状态", "status"], [`${width} 列`, `${width}列`], 520),
        `${artifact}: status layout at ${width} columns`,
      )
      .toBe(true);
    expect
      .soft(
        hasNearby(content, ["命令", "command"], [`${width} 列`, `${width}列`], 520),
        `${artifact}: command layout at ${width} columns`,
      )
      .toBe(true);
  }
  expect
    .soft(hasNearby(content, ["状态", "status"], ["左右锚", "两端锚", "左锚"]), `${artifact}: status anchoring`)
    .toBe(true);
  expect
    .soft(
      hasNearby(content, ["命令", "command"], ["三列", "身份", "source", "来源"]),
      `${artifact}: command wide columns`,
    )
    .toBe(true);
  expect
    .soft(
      hasNearby(content, ["长路径", "长模型", "路径", "模型"], ["截断", "省略号"]),
      `${artifact}: long values truncate themselves`,
    )
    .toBe(true);
  expect
    .soft(content, `${artifact}: 80-column fixed status starts`)
    .toMatch(
      /80\s*列[^。\n]{0,300}Model\s*0\s*\/\s*Effort\s*24\s*\/\s*Context\s*56[^。\n]{0,120}路径值\s*0\s*\/\s*Token\s*52\s*\/\s*Cost\s*70/,
    );
  expect
    .soft(content, `${artifact}: 120-column fixed status starts`)
    .toMatch(
      /120\s*列[^。\n]{0,300}Model\s*0\s*\/\s*Effort\s*24\s*\/\s*Context\s*96[^。\n]{0,120}路径值\s*0\s*\/\s*Token\s*92\s*\/\s*Cost\s*110/,
    );
  expect
    .soft(content, `${artifact}: 40-column fixed status starts`)
    .toMatch(
      /40\s*列[^。\n]{0,300}Model\s*0\s*\/\s*Effort\s*15\s*\/\s*Context\s*25[^。\n]{0,120}路径值\s*0\s*\/\s*Token\s*20\s*\/\s*Cost\s*32/,
    );
  expect
    .soft(content, `${artifact}: long paths do not push telemetry`)
    .toMatch(/长路径[^。\n]{0,160}(?:不(?:会)?推动|不移动|不能移动|只截断)/);
  expect.soft(content, `${artifact}: fixed two-line status at every width`).toMatch(/40\s*列[^。\n]{0,180}两行/i);

  expect.soft(content, `${artifact}: user message background`).toContain("#B8E6E3");
  expect.soft(content, `${artifact}: user message foreground`).toContain("#102426");
  expect
    .soft(content, `${artifact}: cyan user border`)
    .toMatch(/(?:用户消息[^。\n]{0,200}(?:边框|焦点青|#5FC7C7)|(?:边框|焦点青|#5FC7C7)[^。\n]{0,200}用户消息)/);
  for (const width of [40, 80, 120]) {
    expect
      .soft(hasNearby(content, ["用户消息"], [`${width} 列`, `${width}列`], 700), `${artifact}: user message ${width}`)
      .toBe(true);
  }
  expect.soft(hasNearby(content, ["用户消息"], ["wrap", "换行", "长单词"], 700)).toBe(true);
  expect.soft(hasNearby(content, ["用户消息"], ["附件", "attachment"], 700)).toBe(true);
  expect.soft(hasNearby(content, ["用户消息"], ["Inspect"], 700)).toBe(true);

  expect.soft(content, `${artifact}: literal Command hint`).toContain(COMMAND_HINT);
  expect.soft(normalized, `${artifact}: hint outside frame`).toMatch(/(?:frame|框)(?:外|之外)/i);
  expect.soft(normalized, `${artifact}: hint above composer`).toMatch(/composer(?:上方|之前)|(?:上方|之前).*composer/i);
  expect
    .soft(hasNearby(content, ["Model", "模型"], ["hint", "提示", "键位"]), `${artifact}: contextual Model hint`)
    .toBe(true);
  expect
    .soft(hasNearby(content, ["窄", "narrow"], ["详情", "detail", "Right"]), `${artifact}: narrow Model detail action`)
    .toBe(true);
  expect.soft(content, `${artifact}: Model wide breakpoint`).toMatch(/60\s*列/);
  expect
    .soft(normalized, `${artifact}: dynamic Model layouts`)
    .toMatch(/(?:窄|narrow).*(?:宽|wide|双栏)|(?:宽|wide|双栏).*(?:窄|narrow)/i);
  expect
    .soft(content, `${artifact}: no Update production hint`)
    .not.toMatch(/Update[^。\n]{0,100}(?:Enter 检查|Enter 安装|Enter 重试|Enter 重启)/);
}

describe("delivered TUI documentation contract", () => {
  it.each([
    ["README.md", () => readme],
    ["Docs/tui-v1.md", () => docs],
  ] as const)("keeps %s aligned with delivered defaults and fixtures", (artifact, content) => {
    expectSharedFacts(content(), artifact);
  });

  it.each([
    ["README.md", () => readme],
    ["Docs/tui-v1.md", () => docs],
  ] as const)("documents the Revision 5 interaction contract in %s", (artifact, content) => {
    expectRevisionFiveFacts(content(), artifact);
  });

  it("uses bracket notation for the exact slash-excluded emphasis ranges", () => {
    expectMarkedToken("/", ["normal"]);
    expectMarkedToken("/exit", ["normal", "emphasis", "emphasis", "normal", "normal"]);
    expectMarkedToken("/quit", ["normal", "emphasis", "emphasis", "emphasis", "normal"]);
  });

  it("documents pi current-context and cumulative-usage sources in the technical spec", () => {
    expect(hasNearby(docs, ["getContextUsage()"], ["当前", "占用", "current", "used"], 220)).toBe(true);
    expect(hasNearby(docs, ["getSessionStats()"], ["累计", "cumulative"], 220)).toBe(true);
    expect(hasNearby(docs, ["getContextUsage()"], ["getSessionStats()"], 420)).toBe(true);
  });

  it("documents all runnable README backends with truthful runtime labels", () => {
    expect(readme).toContain("npm run dev");
    expect(readme).toContain("VSPi_BACKEND=pi npm run dev");
    expect(readme).toContain("VSPi_FIXTURE=1 npm run dev");
    expect(readme).toMatch(/默认[\s\S]{0,160}(?:真实 pi|Backend Pi)[\s\S]{0,160}(?:不|绝不)[^。\n]{0,80}回退 Fixture/i);
    expect(readme).toContain("Offline Fixture");
    expect(readme).toContain("Backend Pi");
    expect(readme).toContain("Backend Fixture");
    expect(readme).toMatch(/Policy[^。\n]{0,100}Sandboxed/);
    expect(readme).not.toMatch(/Mode[^。\n]{0,60}Auto/);
  });

  it("keeps the detailed terminal mocks aligned with the rendered layout", () => {
    const blocks = textBlocks(docs);
    const splash = blocks.find((block) => BLOCK_LOGO.every((line) => block.includes(line)));
    expect(splash, "Docs splash mock must retain all six exact block-logo lines").toBeDefined();
    expect(splash).not.toContain("Home · auto/safe · Web");
    expect(splash).not.toContain("Kimi / OpenAI / DeepSeek");
    expect(splash).toMatch(/Model\s+\S+/);
    expect(splash).toMatch(/Backend\s+(?:Pi|Fixture)/);
    expect(splash).toMatch(/Policy\s+\S+\s+·\s+(?:Sandboxed|Host)/);
    expect(splash).not.toMatch(/\bMode\b|\bAuto\b/);
    expect(splash).toMatch(/v\d+\.\d+\.\d+/);

    const main = blocks.find((block) => block.includes("当前计划为空"));
    expect(main, "Docs main mock must show the fresh empty Plan").toBeDefined();
    const mainLines = main?.split("\n") ?? [];
    const planBottom = mainLines.findIndex((line) => line.startsWith("╰"));
    expect(mainLines[planBottom + 1]).toMatch(/(?:Shift\+Tab|↑↓|Enter|Esc)/);
    const composerTop = planBottom + 2;
    expect(mainLines[composerTop]).toMatch(/^╭/);
    const composerBottom = mainLines.findIndex((line, index) => index > composerTop && line.startsWith("╰"));
    expect(composerBottom).toBeGreaterThan(composerTop);
    const firstStatusLine = composerBottom + 1;
    const identity80 = mainLines[firstStatusLine] ?? "";
    const telemetry80 = mainLines[firstStatusLine + 1] ?? "";
    expect(identity80).toContain("Context 50K / 128K 39%");
    expect(visibleColumn(identity80, "Model")).toBe(0);
    expect(visibleColumn(identity80, "Effort")).toBe(24);
    expect(visibleColumn(identity80, "Context")).toBe(56);
    expect(visibleWidth(identity80)).toBe(80);
    expect(telemetry80).toMatch(/^\/workspace\/vspi/);
    expect(telemetry80).not.toMatch(/\bPath\b/);
    expect(visibleColumn(telemetry80, "Token")).toBe(52);
    expect(visibleColumn(telemetry80, "Cost")).toBe(70);
    expect(visibleWidth(telemetry80)).toBe(80);

    const allLines = blocks.flatMap((block) => block.split("\n"));
    const identity120Index = allLines.findIndex(
      (line) => visibleColumn(line, "Effort") === 24 && visibleColumn(line, "Context") === 96,
    );
    expect(identity120Index, "Docs must include a literal 120-column identity status line").toBeGreaterThan(-1);
    expect(visibleColumn(allLines[identity120Index] ?? "", "Model")).toBe(0);
    expect(visibleWidth(allLines[identity120Index] ?? "")).toBe(120);
    expect(allLines[identity120Index + 1]).toMatch(/^\/workspace\/vspi/);
    expect(allLines[identity120Index + 1]).not.toMatch(/\bPath\b/);
    expect(visibleColumn(allLines[identity120Index + 1] ?? "", "Token")).toBe(92);
    expect(visibleColumn(allLines[identity120Index + 1] ?? "", "Cost")).toBe(110);

    const compact = blocks.some((block) => {
      const lines = block.split("\n");
      return lines.some(
        (line, index) =>
          visibleColumn(line, "Model") === 0 &&
          visibleColumn(line, "Effort") === 15 &&
          visibleColumn(line, "Context") === 25 &&
          visibleWidth(line) === 40 &&
          (lines[index + 1] ?? "").startsWith("/workspace/vspi") &&
          !/\bPath\b/.test(lines[index + 1] ?? "") &&
          visibleColumn(lines[index + 1] ?? "", "Token") === 20 &&
          visibleColumn(lines[index + 1] ?? "", "Cost") === 32 &&
          visibleWidth(lines[index + 1] ?? "") === 40,
      );
    });
    expect(compact, "Docs must include the fixed two-line 40-column status mock").toBe(true);

    const model = blocks.find(
      (block) =>
        block.includes("Provider") && block.includes("Model ID") && block.includes("输入 ¥") && block.includes("│"),
    );
    expect(model, "Docs model mock must show left-list/right-detail content").toBeDefined();
    expect(blocks.join("\n")).not.toMatch(/中国外汇交易中心参考价\s*·|USD\/CNY\s*7\.18/);
  });

  it("mocks the Unicode and ASCII user-message frame shapes", () => {
    const blocks = textBlocks(docs);
    const unicode = blocks.find((block) => {
      const lines = block.trimEnd().split("\n");
      return (
        /^╭─+╮$/.test(lines[0] ?? "") &&
        /^╰─+╯$/.test(lines.at(-1) ?? "") &&
        !BLOCK_LOGO.some((logoLine) => block.includes(logoLine))
      );
    });
    expect(unicode, "Docs must include a rounded Unicode user-message mock").toBeDefined();
    const unicodeLines = unicode?.trimEnd().split("\n") ?? [];
    expect(unicodeLines.slice(1, -1).every((line) => /^│.*│$/.test(line))).toBe(true);
    expect(new Set(unicodeLines.map(visibleWidth)).size).toBe(1);

    const ascii = blocks.find((block) => {
      const lines = block.trimEnd().split("\n");
      return /^\+-+\+$/.test(lines[0] ?? "") && /^\+-+\+$/.test(lines.at(-1) ?? "");
    });
    expect(ascii, "Docs must include an ASCII user-message fallback mock").toBeDefined();
    const asciiLines = ascii?.trimEnd().split("\n") ?? [];
    expect(asciiLines.slice(1, -1).every((line) => /^\|.*\|$/.test(line))).toBe(true);
    expect(new Set(asciiLines.map(visibleWidth)).size).toBe(1);
  });

  it("retains the attachment and Markdown boundaries", () => {
    expect(readme).toContain("〔登录页-修改前 · 1440×900 · PNG〕");
    expect(readme).toMatch(/Attachment Bridge[\s\S]{0,500}(?:loopback|127\.0\.0\.1)/i);
    expect(docs).toContain("H1/H2");
    for (const bullet of ["•", "◦", "▪"]) expect(docs).toContain(bullet);
    expect(docs).toMatch(/行内代码[\s\S]{0,200}fenced code[\s\S]{0,200}引用/i);
  });
});
