---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T12:52:18.510Z
dedupe_key: cycle.vspi-terminal-mock-recovery.plan
id: decision-3ce0c2c33314cdab7fe0fae3c65c8c85
kind: decision
schema_version: '1'
scope:
  ref: vspi-terminal-mock-recovery
  type: cycle
semantic_hash: 3ce0c2c33314cdab7fe0fae3c65c8c85d59d1a8a19e2772712669e45a86fc94a
source_refs:
  - locator: compiled-plan
    ref: cycle:vspi-terminal-mock-recovery:revision:3
    type: delivery_plan
supersedes:
  - decision-582c15109d07e694113c2598b6a52e39
updated_at: 2026-08-01T12:52:18.510Z
---
# VSPi 横向分隔 Question、白底兼容与宽松 Resume Mock

在保持增量发送、原子 Resume hydration、固定 Status 通知和 Question 独占输入权的前提下，以横向分隔、较大题型控件和无背景焦点态重做 Question，确保默认 Terminal 在黑底与白底均可辨，并让 Resume 会话列表具有稳定间距；经用户按主题、Frame 和行号验收后再完成生产构建与本地分发。

```json
{
  "acceptance": {
    "criteria": [
      {
        "id": "inspector-shell",
        "statement": "`npm run mock:terminal -- --rows 40 --cols 80` 启动严格 80×40 的 VSPi 子 PTY；父壳额外绘制 4 列行号、变化行标记、Frame/phase/baseY/viewportY/cursorY header、暂停与前后逐帧能力，可选列标尺默认关闭。",
        "verification": "子进程报告尺寸严格等于参数；行号与标尺不进入子 PTY 字节流；交互视图和 trace JSON 对同一屏使用相同 Frame ID 与 frame hash。"
      },
      {
        "id": "mock-scenario-coverage",
        "statement": "确定性 Mock Backend 可交互并可自动重放 startup、12+ 轮流式发送、超过三屏的单轮输出、Working tick、Question、通知、空/短/长 Resume、异步 hydration、恢复后发送和 resize。",
        "verification": "交互模式允许真实输入与 `/resume`；`--trace` 无头模式生成全部 phase 的逐帧记录，失败指出第一个 Frame ID 与行号。"
      },
      {
        "id": "incremental-streaming",
        "statement": "generation 活动期间动态尾部 append-only，三屏裁剪只在稳定边界执行；初始帧以后普通发送、token delta、Working tick 与完成结算不发生 change-above-viewport 全屏重绘。",
        "verification": "60 行 Mock 连续 12+ 轮无 post-start full redraw、无普通 CSI 2J/H/3J；每个增量不超过一个 viewport 的有界写入，后续轮次字节量不超过稳定基线 2 倍。"
      },
      {
        "id": "atomic-resume",
        "statement": "Resume picker 后静默 hydration Session reset、历史、usage、Plan 与附件，再一次性发布 restored surface；不重播 Splash/picker，不在 hydration 中显示 Working。短历史从顶部自然排列，长历史落到最新尾部，最新内容、Composer、Status 顺序稳定。",
        "verification": "trace 只允许 picker 与最终 restored 两个用户可见稳定态；恢复首行不是 startup/picker，最新消息行 < Composer 行 < Status 行，viewportY=baseY，cursor 位于 Composer；恢复后首次发送仍无全屏重绘。"
      },
      {
        "id": "production-parity",
        "statement": "Mock 不复制布局算法，直接复用生产 VspiApp、ScrollbackTUI、Composer、Panel、Status 与 surface controller；Stone 接受后构建的本地 `vspi` 与 Mock 使用同一实现。",
        "verification": "结构测试禁止第二套 Mock renderer；Mock 只替换 Backend、时钟、输入脚本与父级 inspector，生产构建、全量测试、真实 PTY、包安装和本地 smoke 全部通过。"
      },
      {
        "id": "question-breathing-room",
        "statement": "Question 元信息、题目、选项实体、输入区和操作提示按视觉分组留出稳定间距；相邻选项之间用一条弱化横线分隔，不绘制任何选项竖向导轨，也不在首尾嵌套第二个盒子。",
        "verification": "Question snapshot 与 80×40 PTY trace 断言相邻选项间横线、无导轨、分组间距和内部滚动；长说明保持属于同一选项，移动选择不改变外围 Status 坐标。"
      },
      {
        "id": "question-transcript-boundary",
        "statement": "旧 transcript 可以保留在 Question 上方并进入原生 scrollback，但任何 transcript 行都不得出现在 Question 边框范围内或形成覆盖；Question 通过瀑布流自然把旧内容向上推。",
        "verification": "80×40 的 trace long 后打开 mock question，按 Frame 行坐标确认 mock response 与 Question frame 几何不相交，向上滚动仍能找到旧 transcript。"
      },
      {
        "id": "fixed-notice-footprint",
        "statement": "通知不再占用 Question 与 Composer 之间的独立布局行，而是投影到固定两行 Status 足迹；info/success 弱化，warning/error 保留明确层级，progress 同样不触发布局跳动。",
        "verification": "逐类触发 notice，显示、更新与消失前后的 Question、Composer、Status 起始行完全一致；不存在额外 notice row 或面板 hint 替换。"
      },
      {
        "id": "question-surface-ownership",
        "statement": "Question 活跃期间完全替代主 Composer；选项模式不显示文本 cursor，直接回答/自由文本模式只有 Question 内输入框拥有 cursor，Question 退出后主 Composer 与原草稿恢复。",
        "verification": "PTY Frame 断言 Question 期间无主 Composer 边框或 cursor；分别进入选项、直接回答、自由文本和退出态，cursor 所在行与焦点所有权唯一且正确。"
      },
      {
        "id": "question-option-affordance",
        "statement": "单选使用 (●)/( )，多选使用 [✓]/[ ]，排序使用稳定序号；选中项由 ›、较大题型控件及 bold/focus 文字共同表达，不使用整行 inverse、白色背景或固定背景色。",
        "verification": "Panel snapshot 覆盖 singleChoice、multiChoice、ranking、other、长说明、窄宽、无色、Terminal 与 Light；断言控件宽度、横向分隔、无竖向导轨、无 inverse/背景填充且状态不只依赖颜色。"
      },
      {
        "id": "question-bottom-hierarchy",
        "statement": "Question 键位提示固定并整体弱化；直接回答/自由文本以标签、输入行和底部横线构成，不使用输入导轨或嵌套框；Question 底框下固定一空行后进入两行 Status。",
        "verification": "80×40 Frame 断言输入标签、唯一 cursor、底部横线、footer、Question 底框、空白 gutter、Status 1、Status 2 的顺序与颜色层级，通知出现/消失不改变坐标。"
      },
      {
        "id": "styled-inspector-frames",
        "statement": "带行号 Mock 对当前及历史 Frame 忠实还原 child 的 ANSI cell 样式，同时保留纯文本 Frame 用于 phase、行号、diff 与几何断言。",
        "verification": "Inspector 测试覆盖默认色、indexed/RGB 前景背景、bold、dim、italic、underline、inverse、strikethrough 和 reset；暂停回看旧 Frame 的样式 hash 与捕获时一致，child plain frame hash 不受行号/标尺影响。"
      },
      {
        "id": "background-neutral-terminal",
        "statement": "默认 Terminal 主题在真实黑底与白底上均保持背景中性：Question 与 Resume 选择态不使用 inverse 或固定背景，关键状态同时具有符号和字重；Mock 支持显式 terminal、dark、light 主题复现。",
        "verification": "主题单测和 inspector ANSI trace 断言 Terminal Question/Resume 不含 inverse 与背景 SGR，no-color 仍可辨；Light trace 使用深色前景与浅色 surface，并通过几何、cursor 和状态层级断言。"
      },
      {
        "id": "resume-session-spacing",
        "statement": "Resume 会话列表在相邻会话实体之间保留一整行空白，选中项使用 › 与文字强调而非整行反色；滚动以实体行坐标计算，使当前会话在短高与长列表中始终可见。",
        "verification": "Sessions snapshot 与 PTY trace 覆盖短列表、长列表、首项、末项和滚动；断言会话间空行、无 inverse/固定背景、当前项可见以及打开后 hydration 落点不变。"
      }
    ],
    "scope": "plan"
  },
  "acceptance_criteria": [
    {
      "id": "inspector-shell",
      "statement": "`npm run mock:terminal -- --rows 40 --cols 80` 启动严格 80×40 的 VSPi 子 PTY；父壳额外绘制 4 列行号、变化行标记、Frame/phase/baseY/viewportY/cursorY header、暂停与前后逐帧能力，可选列标尺默认关闭。",
      "verification": "子进程报告尺寸严格等于参数；行号与标尺不进入子 PTY 字节流；交互视图和 trace JSON 对同一屏使用相同 Frame ID 与 frame hash。"
    },
    {
      "id": "mock-scenario-coverage",
      "statement": "确定性 Mock Backend 可交互并可自动重放 startup、12+ 轮流式发送、超过三屏的单轮输出、Working tick、Question、通知、空/短/长 Resume、异步 hydration、恢复后发送和 resize。",
      "verification": "交互模式允许真实输入与 `/resume`；`--trace` 无头模式生成全部 phase 的逐帧记录，失败指出第一个 Frame ID 与行号。"
    },
    {
      "id": "incremental-streaming",
      "statement": "generation 活动期间动态尾部 append-only，三屏裁剪只在稳定边界执行；初始帧以后普通发送、token delta、Working tick 与完成结算不发生 change-above-viewport 全屏重绘。",
      "verification": "60 行 Mock 连续 12+ 轮无 post-start full redraw、无普通 CSI 2J/H/3J；每个增量不超过一个 viewport 的有界写入，后续轮次字节量不超过稳定基线 2 倍。"
    },
    {
      "id": "atomic-resume",
      "statement": "Resume picker 后静默 hydration Session reset、历史、usage、Plan 与附件，再一次性发布 restored surface；不重播 Splash/picker，不在 hydration 中显示 Working。短历史从顶部自然排列，长历史落到最新尾部，最新内容、Composer、Status 顺序稳定。",
      "verification": "trace 只允许 picker 与最终 restored 两个用户可见稳定态；恢复首行不是 startup/picker，最新消息行 < Composer 行 < Status 行，viewportY=baseY，cursor 位于 Composer；恢复后首次发送仍无全屏重绘。"
    },
    {
      "id": "production-parity",
      "statement": "Mock 不复制布局算法，直接复用生产 VspiApp、ScrollbackTUI、Composer、Panel、Status 与 surface controller；Stone 接受后构建的本地 `vspi` 与 Mock 使用同一实现。",
      "verification": "结构测试禁止第二套 Mock renderer；Mock 只替换 Backend、时钟、输入脚本与父级 inspector，生产构建、全量测试、真实 PTY、包安装和本地 smoke 全部通过。"
    },
    {
      "id": "question-breathing-room",
      "statement": "Question 元信息、题目、选项实体、输入区和操作提示按视觉分组留出稳定间距；相邻选项之间用一条弱化横线分隔，不绘制任何选项竖向导轨，也不在首尾嵌套第二个盒子。",
      "verification": "Question snapshot 与 80×40 PTY trace 断言相邻选项间横线、无导轨、分组间距和内部滚动；长说明保持属于同一选项，移动选择不改变外围 Status 坐标。"
    },
    {
      "id": "question-transcript-boundary",
      "statement": "旧 transcript 可以保留在 Question 上方并进入原生 scrollback，但任何 transcript 行都不得出现在 Question 边框范围内或形成覆盖；Question 通过瀑布流自然把旧内容向上推。",
      "verification": "80×40 的 trace long 后打开 mock question，按 Frame 行坐标确认 mock response 与 Question frame 几何不相交，向上滚动仍能找到旧 transcript。"
    },
    {
      "id": "fixed-notice-footprint",
      "statement": "通知不再占用 Question 与 Composer 之间的独立布局行，而是投影到固定两行 Status 足迹；info/success 弱化，warning/error 保留明确层级，progress 同样不触发布局跳动。",
      "verification": "逐类触发 notice，显示、更新与消失前后的 Question、Composer、Status 起始行完全一致；不存在额外 notice row 或面板 hint 替换。"
    },
    {
      "id": "question-surface-ownership",
      "statement": "Question 活跃期间完全替代主 Composer；选项模式不显示文本 cursor，直接回答/自由文本模式只有 Question 内输入框拥有 cursor，Question 退出后主 Composer 与原草稿恢复。",
      "verification": "PTY Frame 断言 Question 期间无主 Composer 边框或 cursor；分别进入选项、直接回答、自由文本和退出态，cursor 所在行与焦点所有权唯一且正确。"
    },
    {
      "id": "question-option-affordance",
      "statement": "单选使用 (●)/( )，多选使用 [✓]/[ ]，排序使用稳定序号；选中项由 ›、较大题型控件及 bold/focus 文字共同表达，不使用整行 inverse、白色背景或固定背景色。",
      "verification": "Panel snapshot 覆盖 singleChoice、multiChoice、ranking、other、长说明、窄宽、无色、Terminal 与 Light；断言控件宽度、横向分隔、无竖向导轨、无 inverse/背景填充且状态不只依赖颜色。"
    },
    {
      "id": "question-bottom-hierarchy",
      "statement": "Question 键位提示固定并整体弱化；直接回答/自由文本以标签、输入行和底部横线构成，不使用输入导轨或嵌套框；Question 底框下固定一空行后进入两行 Status。",
      "verification": "80×40 Frame 断言输入标签、唯一 cursor、底部横线、footer、Question 底框、空白 gutter、Status 1、Status 2 的顺序与颜色层级，通知出现/消失不改变坐标。"
    },
    {
      "id": "styled-inspector-frames",
      "statement": "带行号 Mock 对当前及历史 Frame 忠实还原 child 的 ANSI cell 样式，同时保留纯文本 Frame 用于 phase、行号、diff 与几何断言。",
      "verification": "Inspector 测试覆盖默认色、indexed/RGB 前景背景、bold、dim、italic、underline、inverse、strikethrough 和 reset；暂停回看旧 Frame 的样式 hash 与捕获时一致，child plain frame hash 不受行号/标尺影响。"
    },
    {
      "id": "background-neutral-terminal",
      "statement": "默认 Terminal 主题在真实黑底与白底上均保持背景中性：Question 与 Resume 选择态不使用 inverse 或固定背景，关键状态同时具有符号和字重；Mock 支持显式 terminal、dark、light 主题复现。",
      "verification": "主题单测和 inspector ANSI trace 断言 Terminal Question/Resume 不含 inverse 与背景 SGR，no-color 仍可辨；Light trace 使用深色前景与浅色 surface，并通过几何、cursor 和状态层级断言。"
    },
    {
      "id": "resume-session-spacing",
      "statement": "Resume 会话列表在相邻会话实体之间保留一整行空白，选中项使用 › 与文字强调而非整行反色；滚动以实体行坐标计算，使当前会话在短高与长列表中始终可见。",
      "verification": "Sessions snapshot 与 PTY trace 覆盖短列表、长列表、首项、末项和滚动；断言会话间空行、无 inverse/固定背景、当前项可见以及打开后 hydration 落点不变。"
    }
  ],
  "constraints": [
    "Milestone 1 是强制人工 Stone：Mock 未经用户亲自运行和确认，不得进入生产构建与本地分发。",
    "行号壳位于子 PTY 外；不得占用或改变 VSPi 的 rows/columns、换行、ANSI 字节流或 cursor 坐标。父终端容纳不下时明确报错或提供壳层滚动，不静默 resize 子 PTY。",
    "默认行标尺为 4 列，格式类似 `01 │`；变化行使用同宽标记。列标尺默认关闭，可切换但不得改变 child frame hash。",
    "Frame 在 synchronized-output 结束或确定性 settle 边界捕获；交互暂停/前后帧与 `--trace` 共享同一有界帧历史和稳定 ID。",
    "Mock 使用现有 Node.js、TypeScript、pi-tui、node-pty 与 @xterm/headless，不新增第三方依赖、不联网、不调用真实付费模型。",
    "活动 generation append-only；约三屏保留只在完成、取消或其他稳定边界 rebase，完整逻辑历史继续由 Session/Inspect 保存。",
    "Working tick 在内容不变时不得改变 frame、Composer 或 Status 的行坐标；Question 等待态和 Resume hydration 不显示 Working。",
    "保留 dirty worktree 中既有 Goal、Subagent、Session 和用户修改；不提交、不推送、不发布。",
    "Milestone 1 可修改 Mock 直接复用的生产 source surface、Question 和 Status 状态机，但不得构建或刷新 /home/heyx/.local/bin/vspi 指向的 dist。",
    "Question 保持瀑布流中的下方交互面板，不改为全屏 overlay；空间不足时使用滚动，不删除必要分组间距。",
    "通知必须复用固定 Status 高度，不得新增覆盖层、独立布局行或导致面板、Composer、Status 位移。",
    "Question 活跃期间主 Composer 不渲染；不得丢失其草稿、附件或退出后的焦点恢复。",
    "Question footer 固定且灰显，底框与 Status 之间保持一行 gutter；不得新增第二套底部布局算法。",
    "Inspector 样式序列化只读取 child xterm cell attributes；不得修改 child PTY 字节流、尺寸、frame plain hash 或 cursor 坐标。",
    "本次只调整 Resume picker 的会话列表呈现与滚动映射，不改变选择、打开、静默 hydration、恢复落点或恢复后发送控制流。",
    "Question 与 Resume 的关键差异不能只依赖颜色；无色、白底和黑底环境必须可由焦点符号、题型控件、横向分隔与字重辨识。",
    "终端背景不能可靠自动探测；默认 Terminal 必须背景中性，显式 VSPi Light 用于确定性浅色配色，不将主题手动切换作为唯一可用路径。",
    "相邻选项只使用横向分隔线，不绘制左/右导轨，不通过整行 inverse 或白色背景制造选中态。"
  ],
  "delivery_kind": "cycle",
  "delivery_mode": "plan",
  "evidence": [
    {
      "ref": "feedback-3a97aa13a519aea258d8a397676b8499",
      "summary": "Revision 2 被明确拒绝：发送超级卡，Resume 落点错误且动画与框混乱；用户要求先用终端 Mock 修正。",
      "type": "user-feedback"
    },
    {
      "ref": "user-terminal-inspector-ruler-2026-08-01",
      "summary": "用户要求亲自运行 Mock，并在子终端外增加 3-4 列行号壳，以 Frame/行号反馈隐藏、错位或消失内容；列标尺可选。",
      "type": "user-decision"
    },
    {
      "ref": "terminal-performance-probe-60x80-12-turns",
      "summary": "60 行 Fixture 前 11 轮约 11-14 KB，第 12 轮升至 45,988 bytes，出现两次 firstChanged < viewportTop 全屏重绘。",
      "type": "runtime-probe"
    },
    {
      "ref": "resume-surface-probe-98x62",
      "summary": "Resume 从 picker baseY 0 跳到 restored baseY 62，并重放 startupSurface 标记；现有测试只验证内容存在与 viewportY=baseY。",
      "type": "runtime-probe"
    },
    {
      "ref": "src/app/vspi-app.ts",
      "summary": "三屏 selectTranscriptWindow 在流式期间截断顶部；presentRestoredTranscript 使用 requestRender(true)，startupSurface 又只在 stable commit 成功后清除。",
      "type": "repository"
    },
    {
      "ref": "scripts/working-mock.ts",
      "summary": "已有 Working 样式 Mock 证明开发命令模式可行，但它未复用 VspiApp，也没有 child PTY、Resume、trace 或外部标尺。",
      "type": "repository"
    },
    {
      "ref": "feedback-40a6180c65bcf925d1cd8c783fb936db",
      "summary": "用户人工检查 80×40 Mock 后认为 Resume 已接近正确，但 Question 过于逼仄、旧 mock response 形成遮挡感，通知非常干扰。",
      "type": "user-feedback"
    },
    {
      "ref": "question-notice-layout-2026-08-01",
      "summary": "Question 当前没有组选项间空行且面板通常封顶 16 行；notice 作为面板下方独立 hint 行参与布局。",
      "type": "repository"
    },
    {
      "ref": "feedback-4d078eb912144be599cb51900961d07a",
      "summary": "用户拒绝当前 Stone：Question 应替代主 Composer、独占 cursor，选项与输入框需要明确状态和独立块感，footer 与 Status 要分层，Mock 必须显示真实颜色。",
      "type": "user-feedback"
    },
    {
      "ref": "question-focus-and-inspector-style-2026-08-01",
      "summary": "VspiApp.focused 当前无条件聚焦 Composer，questionInput 也保持 focused；父 inspector 使用 translateToString 捕获 Frame，导致 ANSI cell 样式丢失。",
      "type": "repository"
    },
    {
      "ref": "feedback-972bc2fd9775070a373aa12596ac4448",
      "summary": "用户拒绝导轨与白色反色方案：要求选项间横线、较大且清楚的多选控件、无导轨输入区、白底终端可用，并改善 Resume 会话间距。",
      "type": "user-feedback"
    },
    {
      "ref": "src/ui/theme.ts-and-panels.ts",
      "summary": "Terminal 的 selected 当前使用 chalk.inverse；Question 与 Sessions 均复用整行选中样式，Sessions 又以一会话一行及会话索引直接滚动。",
      "type": "repository"
    }
  ],
  "id": "vspi-terminal-mock-recovery",
  "milestones": [
    {
      "depends_on": [],
      "id": "mock-surface-oracle",
      "order": 1,
      "outcome": "保持发送、Resume hydration、通知和 ANSI inspector 回归通过，使 Question 以横向分隔、较大控件、无背景焦点和无导轨输入呈现，并让 Terminal/Light 与宽松 Resume 会话列表可在带行号 Mock 中验证。",
      "stone": {
        "acceptance_criteria": [
          "Mock 当前与历史 Frame 的颜色、背景、粗体、暗色和反色与真实 child 一致。",
          "Question 活跃时主 Composer 完全消失，退出后草稿和焦点恢复；选项模式无 cursor，文本模式只有 Question 输入 cursor。",
          "选项之间由横线分隔且没有竖向导轨；选中项没有白色/反色背景。",
          "单选 (●)/( )、多选 [✓]/[ ]、排序、其他和自由文本控件清楚，多选勾选一眼可辨。",
          "直接回答输入区没有导轨或嵌套框；footer、底框、空白 gutter 与两行 Status 层级清楚。",
          "默认 Terminal 在黑底/白底和 no-color 下可辨，显式 Light Mock 无白字白底或突兀白块。",
          "Resume 会话间有一空行，选中项不反色，长列表滚动时当前会话始终可见。",
          "通知仍位于 Status 第一行，第二行仍显示 Model、Effort、cwd 与 Policy。",
          "发送、长输出、Resume hydration 与恢复落点保持此前正确方向且无可感知全屏重绘。",
          "用户明确允许进入生产构建与本地分发。"
        ],
        "id": "stone-terminal-mock-review",
        "review": "用户分别运行 terminal 与 light 的 80×40 Mock，检查彩色/浅色 Frame、横向选项分隔、较大单选多选控件、无白块焦点、无导轨输入、唯一 cursor、footer/gutter/Status 层级、Resume 会话间距与滚动；用 Frame ID + 行号反馈。"
      },
      "title": "横向分隔 Question、白底兼容与宽松 Resume Mock",
      "verification_criteria": [
        "80×40 child、4 列行号壳、Frame controls、列标尺、plain/ANSI trace 与几何断言继续工作。",
        "Question 活跃期间主 Composer 不渲染；选项、直接回答、自由文本、Review 与退出态的 cursor/focus 所有权唯一。",
        "选项间只有横向分隔，没有竖向导轨或嵌套选项框；长说明保持属于同一实体。",
        "单选 (●)/( )、多选 [✓]/[ ]、排序序号、其他与输入区在彩色、无色、黑底和白底均可辨。",
        "Question 与 Resume 选择态不使用 inverse、整行白底或固定背景；Terminal 背景中性，Light palette 可显式复现。",
        "直接回答/自由文本使用标签、输入行和底部横线；footer 弱化，Question 底框、空白 gutter、两行 Status 顺序稳定。",
        "Resume 相邻会话之间有一空行，当前会话使用 › 与文字强调，实体行滚动在短高和长列表中保持选中项可见。",
        "Inspector 当前/历史 Frame 的 foreground/background、bold、dim、italic、underline、inverse、strikethrough 仍忠实重放。",
        "mock response 不侵入 Question；post-start full redraw、清屏/Home、输出爆量、hydration 中间帧与 Resume 错序保持为零。",
        "TypeScript、Biome、目标测试、全量 Vitest，以及 terminal/light 两组 80×40 trace 通过；不刷新 dist 或本地 vspi。"
      ]
    },
    {
      "depends_on": [
        "mock-surface-oracle"
      ],
      "id": "production-integration",
      "order": 2,
      "outcome": "将 Stone 已确认的共享实现完成生产构建，覆盖真实 PTY、Session/Goal/Question/notice 回归并刷新本地 vspi，等待最终人工验收。",
      "title": "生产集成、全量回归与本地分发",
      "verification_criteria": [
        "Mock trace 作为前置门禁继续通过，生产代码不存在第二套布局算法。",
        "TypeScript、Biome、目标测试、全量 Vitest、真实 PTY、build、package install 与 npm audit 通过。",
        "本地 wrapper 指向新 dist，Fixture smoke 和用户真实终端复验可用。",
        "证据包含 Frame/行坐标、full redraw 计数、字节预算、Resume trace 和文件 SHA-256。"
      ]
    }
  ],
  "outcome": "在保持增量发送、原子 Resume hydration、固定 Status 通知和 Question 独占输入权的前提下，以横向分隔、较大题型控件和无背景焦点态重做 Question，确保默认 Terminal 在黑底与白底均可辨，并让 Resume 会话列表具有稳定间距；经用户按主题、Frame 和行号验收后再完成生产构建与本地分发。",
  "revision": 3,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi 横向分隔 Question、白底兼容与宽松 Resume Mock",
  "plan_hash": "73486ce8cfc93317816b8fa741d0f33d845a30ae490623690183c3d6db6d2793"
}
```
