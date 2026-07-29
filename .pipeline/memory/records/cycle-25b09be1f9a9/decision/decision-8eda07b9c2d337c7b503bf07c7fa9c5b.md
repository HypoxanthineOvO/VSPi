---
authority_role: record
confidence: confirmed
created_at: 2026-07-23T07:03:27.953Z
dedupe_key: cycle.vspi-tui-v1.plan
id: decision-8eda07b9c2d337c7b503bf07c7fa9c5b
kind: decision
schema_version: '1'
scope:
  ref: vspi-tui-v1
  type: cycle
semantic_hash: 8eda07b9c2d337c7b503bf07c7fa9c5bc4c2891629e099731328a10734fb61ae
source_refs:
  - locator: compiled-plan
    ref: cycle:vspi-tui-v1:revision:5
    type: delivery_plan
supersedes:
  - decision-d0627add08c0c097bda321efacca7984
updated_at: 2026-07-23T07:03:27.953Z
---
# VSPi TUI v1 真实启动状态、命令后缀高亮与用户消息视觉修订

最终启动帧只展示已解析的真实模型、真实模式和构建版本；slash 仅触发命令模式且不参与高亮；用户消息使用浅色圆角块；Context 移到稳定的中间轨道，同时保留 Revision 4 的完整交互与发布质量。

```json
{
  "acceptance": {
    "criteria": [
      {
        "id": "ac_slash_trigger",
        "statement": "首个 slash 只作为命令模式触发符；空 slash 不产生匹配强调，非空查询只强调 slash 后实际匹配字符。",
        "verification": "Composer 与 Command 快照覆盖 /、/ex、/qui、plugin alias、cursor-middle、color0/256/truecolor；/ex 仅 ex 带 SGR，slash 与未匹配后缀不带匹配 SGR，Tab/Enter 行为不回归。"
      },
      {
        "id": "ac_truthful_splash",
        "statement": "最终 splash 仅显示 backend 已解析的真实模型、真实运行模式和 package 版本，不显示固定 Home/Web、auto/safe 或 Provider 宣传列表。",
        "verification": "Startup orchestration 测试证明动画可先开始，最终帧等待 app/backend start；pi、auto fallback、forced fixture 三条路径显示对应真实 model/mode，Safe 只在显式真实状态存在时出现；最终帧仍在动态 TUI 前写入 scrollback。"
      },
      {
        "id": "ac_user_surface",
        "statement": "用户消息渲染为浅色高对比背景的圆角消息块，包含稳定的上下边界、宽度安全换行和附件内容；无色/ASCII 有清晰边框降级。",
        "verification": "40/80/120、单行/多行/附件/Inspect 快照检查 ╭╮/╰╯、浅背景与深色文字、精确宽度、ASCII +|- 降级和相邻消息间距。"
      },
      {
        "id": "ac_context_track",
        "statement": "80 列 Context 从当前可见列 28 移到固定中间轨道列 24；Token 与费用继续右锚。120 列 Context 固定在列 34；40 列保持紧急两端布局。",
        "verification": "短/长路径与 active/zero/unknown Context 的 40/80/120 可见列断言证明 Context 起点稳定，Token/费用列不移动，路径只截断自身。"
      },
      {
        "id": "ac_regression",
        "statement": "Revision 4 已验证的 Context 数据语义、alias/Tab/canonical、命令列、hints、Markdown、splash scrollback、真实 pi、附件、Update、Bridge、打包与安全边界全部保持通过。",
        "verification": "全量 test/check/build/smoke、source/dist render、80x24 PTY、真实 pi、package dry-run+临时安装、audit 与 workspace 清洁检查通过。"
      },
      {
        "id": "ac_docs",
        "statement": "README 与 TUI 规范只描述真实 Revision 5 启动状态、slash 后缀高亮、浅色用户消息块和新的 Context 锚点，并给出匹配实际渲染的终端 Mock。",
        "verification": "docs-contract 与人工 mock 对照删除 Home · auto/safe · Web 和 Kimi / OpenAI / DeepSeek，保留真实状态样例及所有既有边界。"
      }
    ],
    "scope": "cycle"
  },
  "acceptance_criteria": [
    {
      "id": "ac_slash_trigger",
      "statement": "首个 slash 只作为命令模式触发符；空 slash 不产生匹配强调，非空查询只强调 slash 后实际匹配字符。",
      "verification": "Composer 与 Command 快照覆盖 /、/ex、/qui、plugin alias、cursor-middle、color0/256/truecolor；/ex 仅 ex 带 SGR，slash 与未匹配后缀不带匹配 SGR，Tab/Enter 行为不回归。"
    },
    {
      "id": "ac_truthful_splash",
      "statement": "最终 splash 仅显示 backend 已解析的真实模型、真实运行模式和 package 版本，不显示固定 Home/Web、auto/safe 或 Provider 宣传列表。",
      "verification": "Startup orchestration 测试证明动画可先开始，最终帧等待 app/backend start；pi、auto fallback、forced fixture 三条路径显示对应真实 model/mode，Safe 只在显式真实状态存在时出现；最终帧仍在动态 TUI 前写入 scrollback。"
    },
    {
      "id": "ac_user_surface",
      "statement": "用户消息渲染为浅色高对比背景的圆角消息块，包含稳定的上下边界、宽度安全换行和附件内容；无色/ASCII 有清晰边框降级。",
      "verification": "40/80/120、单行/多行/附件/Inspect 快照检查 ╭╮/╰╯、浅背景与深色文字、精确宽度、ASCII +|- 降级和相邻消息间距。"
    },
    {
      "id": "ac_context_track",
      "statement": "80 列 Context 从当前可见列 28 移到固定中间轨道列 24；Token 与费用继续右锚。120 列 Context 固定在列 34；40 列保持紧急两端布局。",
      "verification": "短/长路径与 active/zero/unknown Context 的 40/80/120 可见列断言证明 Context 起点稳定，Token/费用列不移动，路径只截断自身。"
    },
    {
      "id": "ac_regression",
      "statement": "Revision 4 已验证的 Context 数据语义、alias/Tab/canonical、命令列、hints、Markdown、splash scrollback、真实 pi、附件、Update、Bridge、打包与安全边界全部保持通过。",
      "verification": "全量 test/check/build/smoke、source/dist render、80x24 PTY、真实 pi、package dry-run+临时安装、audit 与 workspace 清洁检查通过。"
    },
    {
      "id": "ac_docs",
      "statement": "README 与 TUI 规范只描述真实 Revision 5 启动状态、slash 后缀高亮、浅色用户消息块和新的 Context 锚点，并给出匹配实际渲染的终端 Mock。",
      "verification": "docs-contract 与人工 mock 对照删除 Home · auto/safe · Web 和 Kimi / OpenAI / DeepSeek，保留真实状态样例及所有既有边界。"
    }
  ],
  "constraints": [
    "Slash 保留在命令 token 与补全文本中，但从匹配 query、score 和 emphasis range 中排除；输入 / 只打开完整命令目录。",
    "输入 /ex 时仅字符 ex 使用颜色加粗、下划线或反显；/ 与补全后的 it 不属于匹配片段。",
    "Canonical command 仍是唯一执行身份，duplicate exact alias 继续在 resolver 与 Panel Enter fail closed。",
    "启动动画不得等待 backend 才首次显示；中间帧可以只显示品牌初始化状态，但最终帧必须等待 backend/app 初始化并使用真实状态。",
    "动态 TUI 只能在真实最终 splash 连同结尾换行写入 scrollback 后启动；不得恢复 Plan 后清屏。",
    "StartupStatus 的 model 来自已启动 backend.modelLabel，mode 来自真实配置/运行状态，version 来自 package metadata。",
    "当前可显示的真实 backend mode 是 Auto、Pi 或 Fixture；Safe 只有未来存在真实 Safe runtime state 时才显示，本 Revision 不虚构或实现 Safe 功能。",
    "Auto fallback 到 fixture 时同时显示模型 Offline Fixture 与模式 Auto；forced fixture 显示模式 Fixture。",
    "删除真实 splash 与文档 Mock 中固定的 Home · auto/safe · Web 和 Kimi / OpenAI / DeepSeek。",
    "用户消息块 truecolor 使用浅青背景 #B8E6E3、深色文字 #102426 与焦点青边框；256 色使用可读近似色，无色终端使用边框而不伪造背景。",
    "用户消息块使用全宽稳定圆角 frame，正文和附件位于块内；多行每行填满背景且不得与相邻消息重叠。",
    "80 列状态的 Path/Context/Token/费用可见列起点分别为 0/24/52/70；120 列 Context 起点为 34，Token/费用/Effort 维持稳定右侧轨道；40 列保持现有紧急布局。",
    "不改变 Context 50K / 128K 39% 的格式、getContextUsage/getSessionStats 数据来源、CNY 费用语义或 Offline/unknown 规则。",
    "不新增真实 Safe mode、模型组后端、Provider 写入、GitLab updater、Secret Manager 或其他后端功能。"
  ],
  "delivery_kind": "cycle",
  "evidence": [
    {
      "ref": "feedback-da6226ef6e521d26d9d0450ff05b4db0",
      "summary": "用户在 Revision 4 final acceptance 拒绝 slash 高亮、深色用户消息、偏右 Context 和虚构 splash 文案。",
      "type": "feedback"
    },
    {
      "ref": "src/ui/splash.ts",
      "summary": "当前真实 splash 硬编码 Home · auto/safe · Web 与 Kimi / OpenAI / DeepSeek，并在 backend start 前构造最终帧。",
      "type": "source"
    },
    {
      "ref": "src/app/startup.ts",
      "summary": "当前 startUiAfterSplash 先完整 runStartupSequence，之后才调用 app.start 与 TUI.start，最终帧无法读取真实 model。",
      "type": "source"
    },
    {
      "ref": "src/backend/adaptive-backend.ts",
      "summary": "AdaptiveBackend 在 start 后才确定真实 pi 或 auto fallback fixture；modelLabel 可作为最终 splash 的真实来源。",
      "type": "source"
    },
    {
      "ref": "src/ui/ansi.ts",
      "summary": "当前 emphasizePrefix 从 token 第 0 字符起强调，因此 slash 被包含。",
      "type": "source"
    },
    {
      "ref": "src/ui/transcript.ts",
      "summary": "当前用户消息使用整行 userSurface 深色背景，没有上下边框。",
      "type": "source"
    },
    {
      "ref": "src/ui/theme.ts",
      "summary": "当前 userBackground 是 #20262A，需改为浅色表面并提供深色前景与终端能力降级。",
      "type": "source"
    },
    {
      "ref": "src/ui/status.ts",
      "summary": "当前 80 列 Context 实测起点为列 28，用户要求向中间/左移动并保持右侧字段稳定。",
      "type": "source"
    },
    {
      "ref": "r4-m3-audit",
      "summary": "Revision 4 在拒绝前已通过 151 项测试、PTY、真实 pi、打包安装和安全审计，可作为 Revision 5 回归基线。",
      "type": "verification"
    }
  ],
  "id": "vspi-tui-v1",
  "milestones": [
    {
      "depends_on": [],
      "id": "M1",
      "order": 1,
      "outcome": "引入 typed StartupStatus，并重排启动编排：品牌动画与 backend 初始化并行，最终 splash 使用已解析 model/mode/version 后写入 scrollback，再启动动态 TUI。",
      "title": "真实启动状态与最终帧时序",
      "verification_criteria": [
        "Animated 与 reduced-motion 都保证 final splash 在 app/backend 初始化后、TUI.start 前提交并带结尾换行。",
        "真实 pi、Auto fallback、forced fixture 的 model/mode 均来自运行时；Safe 不存在时绝不出现。",
        "最终帧不含 Home · auto/safe · Web 或固定 Provider 列表，40/80/120 和 ASCII 降级宽度安全。",
        "backend 或 attachment 初始化失败路径保持 clean shutdown，不产生双重 start/dispose。"
      ]
    },
    {
      "depends_on": [
        "M1"
      ],
      "id": "M2",
      "order": 2,
      "outcome": "修正命令匹配视觉范围，重做用户消息浅色圆角块，并将 Context 放入新的稳定中间轨道而不移动 Token/费用。",
      "title": "Slash 后缀高亮、浅色用户消息与 Context 中间轨道",
      "verification_criteria": [
        "/ 只打开目录且无匹配 SGR；/ex 仅 ex 强调，/ 与 it 普通；alias/plugin/cursor/color modes 与 Tab/canonical 行为通过。",
        "用户消息在 40/80/120、truecolor/256/ASCII、单行/多行/附件/Inspect 下呈现圆角浅色块并保持精确宽度。",
        "80 列 Context/Token/费用分别从可见列 24/52/70 开始，120 列 Context 从 34 开始；长路径不推动这些轨道。",
        "Revision 4 的 151 项基线与新增测试全部通过。"
      ]
    },
    {
      "depends_on": [
        "M2"
      ],
      "id": "M3",
      "order": 3,
      "outcome": "更新 README 与 TUI Mock，并对真实启动、用户消息、命令高亮、状态轨道和全部既有功能完成独立发布审计。",
      "title": "Revision 5 Mock、文档与发布复审",
      "verification_criteria": [
        "README/Docs 删除固定启动宣传行，展示真实 model/mode/version final splash、浅色用户消息块、slash 后缀强调和新 Context 列位。",
        "全量 check/test/build/smoke/source+dist、40/80/120、ASCII/256/truecolor、80x24 PTY、真实 pi 与 clean shutdown 通过。",
        "附件/Bridge/Update/Markdown/错误恢复、安全与 npm pack 临时安装不回归。",
        "test/implement/audit evidence 分离，最终无 High/Medium finding后才进入一次 Cycle acceptance。"
      ]
    }
  ],
  "outcome": "最终启动帧只展示已解析的真实模型、真实模式和构建版本；slash 仅触发命令模式且不参与高亮；用户消息使用浅色圆角块；Context 移到稳定的中间轨道，同时保留 Revision 4 的完整交互与发布质量。",
  "revision": 5,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi TUI v1 真实启动状态、命令后缀高亮与用户消息视觉修订",
  "plan_hash": "0cc9390a173e5939590e30cb813169f38353cc89a636e373cf7e97da800d68a6"
}
```
