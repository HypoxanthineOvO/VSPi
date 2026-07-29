---
authority_role: record
confidence: confirmed
created_at: 2026-07-23T04:30:31.360Z
dedupe_key: cycle.vspi-tui-v1.plan
id: decision-d0627add08c0c097bda321efacca7984
kind: decision
schema_version: '1'
scope:
  ref: vspi-tui-v1
  type: cycle
semantic_hash: d0627add08c0c097bda321efacca798420c5a90a19d5027ff83b8fde687889da
source_refs:
  - locator: compiled-plan
    ref: cycle:vspi-tui-v1:revision:4
    type: delivery_plan
supersedes:
  - decision-1c7d01437a8796a9be84642ce6d6f421
updated_at: 2026-07-23T04:30:31.360Z
---
# VSPi TUI v1 命令发现、上下文状态与键位提示修订

命令入口明确区分 canonical 与 alias，支持唯一候选 Tab 补全和统一匹配高亮；状态区以真实当前上下文占用显示 Context xxK / yyK ab%，并按宽度左右锚定；共享面板提供响应式列与上下文灰字键位提示。

```json
{
  "acceptance": {
    "criteria": [
      {
        "id": "ac_alias",
        "statement": "命令匹配携带 canonical、matched token 和 match kind；alias 命中先显示别名并指向 canonical command。",
        "verification": "/ex、/resume、/thinking 和插件 alias 快照显示别名括号、箭头、canonical id 与 source。"
      },
      {
        "id": "ac_complete",
        "statement": "唯一 slash token 候选支持 Tab 补全 matched canonical 或 alias，不自动执行；多候选、参数输入和普通文本不误补。",
        "verification": "App/composer 测试覆盖 /ex 到 /exit、/qui 到 /quit、多候选、参数、history 不变和空输入 Inspect fallback。"
      },
      {
        "id": "ac_highlight",
        "statement": "composer、内置结果和插件结果的匹配片段使用颜色叠加粗体或反显，canonical、alias 与 source 仍可区分。",
        "verification": "truecolor、256 色和无色快照证明命中片段具有非颜色单一信号。"
      },
      {
        "id": "ac_context",
        "statement": "Context 固定呈现为“当前占用K / 模型窗口K 百分比”，当前占用来自 pi AgentSession.getContextUsage()，不得使用累计输入输出 Token 冒充。",
        "verification": "以 50176/128000 断言“Context 50K / 128K 39%”；累计 Token 独立变化不改变 Context；空 Offline Fixture 为“0K / 0K 0%”；压缩后 tokens=null 为“?K / 128K ?%”。"
      },
      {
        "id": "ac_status_align",
        "statement": "composer 下方状态在 80 列使用两行左右锚定布局：路径对 Context/Token/费用，模型对 Effort/活动状态；120 列可单行，40 列保留路径对 Context、模型对 Effort。",
        "verification": "40/80/120 列断言左右字段贴近各自锚点、中间 gap 随宽度增长、长路径或模型只截断自身且右侧列位稳定。"
      },
      {
        "id": "ac_command_columns",
        "statement": "命令结果在 80/120 列将身份、说明和来源按可用宽度计算为稳定列位和均匀间隔，40 列两行降级。",
        "verification": "命令面板宽度快照断言列起点、间距、截断和无重叠。"
      },
      {
        "id": "ac_hints",
        "statement": "共享工作区 frame 下方、composer 上方显示 contextual muted 键位提示，并与滚动计数及 80x24 高度预算共存。",
        "verification": "Command、Model、Provider、Sessions、Settings、Theme、Question、Update、Plan 提示快照通过。"
      },
      {
        "id": "ac_regression",
        "statement": "Revision 1 的 splash、真实空状态、模型双栏、Update、附件、Markdown、真实 pi 和安全行为不回归。",
        "verification": "全量 check、test、build、smoke、render-once、PTY、真实 pi 与 package dry-run 审计通过。"
      }
    ],
    "scope": "cycle"
  },
  "acceptance_criteria": [
    {
      "id": "ac_alias",
      "statement": "命令匹配携带 canonical、matched token 和 match kind；alias 命中先显示别名并指向 canonical command。",
      "verification": "/ex、/resume、/thinking 和插件 alias 快照显示别名括号、箭头、canonical id 与 source。"
    },
    {
      "id": "ac_complete",
      "statement": "唯一 slash token 候选支持 Tab 补全 matched canonical 或 alias，不自动执行；多候选、参数输入和普通文本不误补。",
      "verification": "App/composer 测试覆盖 /ex 到 /exit、/qui 到 /quit、多候选、参数、history 不变和空输入 Inspect fallback。"
    },
    {
      "id": "ac_highlight",
      "statement": "composer、内置结果和插件结果的匹配片段使用颜色叠加粗体或反显，canonical、alias 与 source 仍可区分。",
      "verification": "truecolor、256 色和无色快照证明命中片段具有非颜色单一信号。"
    },
    {
      "id": "ac_context",
      "statement": "Context 固定呈现为“当前占用K / 模型窗口K 百分比”，当前占用来自 pi AgentSession.getContextUsage()，不得使用累计输入输出 Token 冒充。",
      "verification": "以 50176/128000 断言“Context 50K / 128K 39%”；累计 Token 独立变化不改变 Context；空 Offline Fixture 为“0K / 0K 0%”；压缩后 tokens=null 为“?K / 128K ?%”。"
    },
    {
      "id": "ac_status_align",
      "statement": "composer 下方状态在 80 列使用两行左右锚定布局：路径对 Context/Token/费用，模型对 Effort/活动状态；120 列可单行，40 列保留路径对 Context、模型对 Effort。",
      "verification": "40/80/120 列断言左右字段贴近各自锚点、中间 gap 随宽度增长、长路径或模型只截断自身且右侧列位稳定。"
    },
    {
      "id": "ac_command_columns",
      "statement": "命令结果在 80/120 列将身份、说明和来源按可用宽度计算为稳定列位和均匀间隔，40 列两行降级。",
      "verification": "命令面板宽度快照断言列起点、间距、截断和无重叠。"
    },
    {
      "id": "ac_hints",
      "statement": "共享工作区 frame 下方、composer 上方显示 contextual muted 键位提示，并与滚动计数及 80x24 高度预算共存。",
      "verification": "Command、Model、Provider、Sessions、Settings、Theme、Question、Update、Plan 提示快照通过。"
    },
    {
      "id": "ac_regression",
      "statement": "Revision 1 的 splash、真实空状态、模型双栏、Update、附件、Markdown、真实 pi 和安全行为不回归。",
      "verification": "全量 check、test、build、smoke、render-once、PTY、真实 pi 与 package dry-run 审计通过。"
    }
  ],
  "constraints": [
    "canonical command id 是唯一执行身份；alias 只参与匹配、补全和显示。",
    "/ex 唯一补 /exit，/qui 唯一补 /quit；Tab 不提交、不写 history。",
    "多候选、已有参数或普通文本不做命令补全，空输入 transcript Inspect 保留。",
    "匹配强调不能只依赖颜色；至少叠加粗体、下划线或反显。",
    "内置与插件命令共享 matcher/highlighter，插件 package source 始终可见。",
    "UsageSnapshot 分离 contextTokens、contextWindow、contextPercent 与累计 inputTokens、outputTokens、costUsd。",
    "pi 后端调用 AgentSession.getContextUsage()；Context 百分比由未格式化的 tokens/contextWindow 四舍五入为整数，不从格式化后的 K 数值反算。",
    "Context 的 K 使用十进制千 token：0 固定为 0K，1K 以下到 10K 以下保留一位小数，10K 及以上四舍五入为整数并使用大写 K。",
    "pi 在 compaction 后返回 tokens=null 时显示 ?K 和 ?%，保留已知 contextWindow；不得显示伪造的 0%。",
    "Offline Fixture 未配置模型容量时固定显示 0K / 0K 0%，不得伪造窗口大小。",
    "状态右侧组必须右锚定；路径和模型值可省略号截断，Context、Token、费用和 Effort 标签不得被长值推动或丢失。",
    "命令行宽屏使用身份、说明、来源三段动态间距；40 列可换行但不重叠。",
    "键位帮助行位于 frame 外、composer 上方，使用 muted 灰色并计入高度。",
    "不增加后端命令或插件加载机制，不实现凭据管理，不改变 pi 0.81.1 和现有安全边界。"
  ],
  "delivery_kind": "cycle",
  "evidence": [
    {
      "ref": "feedback-bf0c8330b8356e5ff14f20b4235030f5",
      "summary": "用户要求 alias provenance、Tab 补全、统一高亮、宽度对齐和键位提示。",
      "type": "feedback"
    },
    {
      "ref": "conversation-2026-07-23-context-contract",
      "summary": "用户明确要求 Context 显示为 xxK / yyK ab%。",
      "type": "feedback"
    },
    {
      "ref": "pi-coding-agent@0.81.1 AgentSession.getContextUsage",
      "summary": "正式接口返回 tokens、contextWindow、percent；compaction 后 tokens 和 percent 可为 null。",
      "type": "sdk"
    },
    {
      "ref": "src/backend/pi-backend.ts",
      "summary": "当前 publishUsage 累加 assistant input/output 后计算 contextPercent，语义错误且未暴露占用量与窗口。",
      "type": "source"
    },
    {
      "ref": "src/ui/status.ts",
      "summary": "当前状态只显示 Context 百分比且内容连续左排，尚未左右锚定。",
      "type": "source"
    },
    {
      "ref": "src/domain/commands.ts",
      "summary": "当前 filterCommands 缺少 matched token 和 match kind。",
      "type": "source"
    },
    {
      "ref": "src/ui/panels.ts",
      "summary": "当前命令行左侧堆叠且无 frame 外 contextual hint row。",
      "type": "source"
    },
    {
      "ref": "src/ui/composer.ts",
      "summary": "当前 slash token 无 Tab completion 与命令高亮。",
      "type": "source"
    },
    {
      "ref": "r1-m4-audit",
      "summary": "Revision 1 的 81 项测试、PTY、安全和真实 pi 边界已验证。",
      "type": "verification"
    }
  ],
  "id": "vspi-tui-v1",
  "milestones": [
    {
      "depends_on": [],
      "id": "M1",
      "order": 1,
      "outcome": "引入 canonical/alias/source-aware match result 和唯一 slash token Tab 补全；同时把当前 Context 与累计 Token 拆成独立数据通道并接入 pi 正式接口。",
      "title": "命令匹配与 Context 数据契约",
      "verification_criteria": [
        "/ex 补全为 /exit 并绑定 /quit；/qui 补全为 /quit；多候选、参数和普通输入不误改写。",
        "内置和插件命令返回 matched token、match kind、canonical id 与 source；Enter alias 调用原 canonical handler，Tab 不执行或污染历史。",
        "UsageSnapshot 公开 contextTokens、contextWindow、contextPercent，累计 input/output/cost 继续单独统计。",
        "pi 使用 getContextUsage() 并覆盖正常、空会话、切换会话和 compaction 未知态；Offline Fixture 使用显式零容量。"
      ]
    },
    {
      "depends_on": [
        "M1"
      ],
      "id": "M2",
      "order": 2,
      "outcome": "实现 Context xxK / yyK ab% 的精确渲染，重做状态两端锚定、Command 响应式列和 composer/结果高亮，并为共享工作区增加 contextual hint row。",
      "title": "状态左右对齐、匹配高亮与键位提示",
      "verification_criteria": [
        "状态 Mock 显示“Context 50K / 128K 39%”，未知态显示“Context ?K / 128K ?%”，并与“Token ↑输入 ↓输出”明确分开。",
        "40/80/120 列状态左右锚点与动态 gap 稳定，长值不推动右侧字段，所有输出保持精确终端宽度。",
        "Alias/canonical/plugin 命中在彩色和无色终端均有可辨强调。",
        "80/120 列命令三段列位稳定，40 列两行无越界；各面板灰字提示与滚动计数共存，80x24 不超预算。"
      ]
    },
    {
      "depends_on": [
        "M2"
      ],
      "id": "M3",
      "order": 3,
      "outcome": "更新文档和终端 Mock，对命令补全、Context 语义、状态对齐、键位提示及 Revision 1 功能完成独立发布回归。",
      "title": "终端 Mock、文档与发布回归审计",
      "verification_criteria": [
        "README 与 TUI 规范说明 alias、Tab、高亮、Context 数据来源与未知态、状态左右对齐、命令列和 contextual hints。",
        "全量 check、test、build、smoke、render-once 和 package dry-run 通过。",
        "40/80/120 列、ASCII、256 色、truecolor 和 80x24 PTY 通过，并检查 Context 数字、空格、大写 K 与右锚点。",
        "真实 pi、会话/compaction、附件/Bridge、Update、Markdown、无副作用和错误恢复保持通过。"
      ]
    }
  ],
  "outcome": "命令入口明确区分 canonical 与 alias，支持唯一候选 Tab 补全和统一匹配高亮；状态区以真实当前上下文占用显示 Context xxK / yyK ab%，并按宽度左右锚定；共享面板提供响应式列与上下文灰字键位提示。",
  "revision": 4,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi TUI v1 命令发现、上下文状态与键位提示修订",
  "plan_hash": "2eff97b2433860d3f891f59b67ee9f96858527359108ee632983787a4ddafa03"
}
```
