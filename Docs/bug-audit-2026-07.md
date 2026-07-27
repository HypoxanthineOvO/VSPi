# VSPi 缺陷盘点与修复计划

更新时间：2026-07-27

## 状态定义

- `verified`：已有实现证据，且定向测试与完整测试通过。
- `staged`：工作区已有补丁，但补丁后的完整验证尚未完成。
- `confirmed`：已定位到明确代码路径，尚未实现。
- `investigate`：用户现象成立，但仍需运行时证据区分根因。

## 1. 模型上下文与压缩

### C-01 VSPLab GPT 上下文真相源错误

- 状态：`verified`
- 修复：`VSPLAB_MODELS` 不再手抄规格；provider 声明 `inheritModelsFrom: "openai-codex"`，注册时从真实 `ModelRuntime` 合并上游 `contextWindow`/`maxTokens`/输入能力/reasoning/thinking map/cost tiers，VSPLab 只保留路由、协议与显示名。上游条目缺失时 fail-closed 抛错，不猜测窗口。
- 证据：五个模型 `contextWindow === 272_000`、cost 与 thinkingLevelMap 等于上游、fail-closed 契约测试；94 文件 683 用例全绿。

### C-02 自动压缩后 usage 未立即刷新

- 状态：`verified`
- 现象：手动压缩会刷新 usage，Pi 原生 `compaction_end` 成功路径只更新 busy 状态。
- 修复：`compaction_end` 成功且有结果时立即发布 usage；取消、失败和 overflow retry 保持原有状态语义。manual compact 在真实 Pi 事件路径下只由事件收尾，fake session 才走后端兜底。
- 证据：M8 成功、取消、失败、overflow retry 定向测试与完整测试通过。

### C-03 “压缩过于激进”尚需事件证据

- 状态：`investigate`
- 已知机制：Pi 默认在 `contextTokens > contextWindow - 16,384` 时压缩；272K 模型的阈值为 255,616。
- 关键区别：上下文压缩不删除 Session JSONL 历史；“无法往回翻”主要由 Transcript 前景窗口造成。
- 计划：增加 threshold/overflow 原因、tokens、window、reserve 的可观测测试或诊断；在没有证据前不放宽 Codex 安全边界。

## 2. Transcript 历史浏览

### T-01 前景窗口有硬上限但没有加载入口

- 状态：`verified`
- 修复：`selectTranscriptWindow` 新增 `startNodeId` 锚点模式；Inspect 向上越界时选中上移一条并逐批（20 块）向前扩展，向下越过锚点窗口底部时窗口跟随、接近尾部自动恢复 tail 跟随。窗口在两种模式下都保持有界。
- 证据：60/140 条历史可一路向上到第 0 条、到顶安全提示、向下回尾部、渲染帧 ≤ 24 行；M2 旧“限制在窗口内”测试更新为新契约。

### T-03 渲染输出超过终端高度导致周期性清屏跳顶

- 状态：`verified`
- 根因：`maxRows = rows * 6` 使输出远超一屏；窗口滑动或顶部提示变化令 `firstChanged < viewportTop`，pi-tui 走 `fullRender(true)`（`\x1b[2J\x1b[H\x1b[3J`），清屏并清终端原生 scrollback。
- 修复：Transcript 窗口改为视口预算（终端行数减去 composer/activity/queue/status/panel/hint），整帧永不超高，差分渲染始终命中；Inspect 聚焦时 Plan 面板让位给历史浏览。
- 证据：长 busy transcript + Plan 面板下 80x24 帧高不变量测试。

### T-02 历史加载与模型上下文压缩概念未分离

- 状态：`confirmed`
- 风险：用户会把“UI 未加载历史”理解为“压缩删除历史”。
- 方案：Transcript 使用明确的可加载边界；压缩提示只描述模型上下文，不暗示历史被删除。

## 3. Question

### Q-01 填空输入不是正常编辑器

- 状态：`verified`
- 原因：手写字符串追加逻辑先拦截左右切题，不支持光标、Unicode 字素或 IME 硬件光标。
- 修复：改用 Pi TUI `Input`；输入态左右键移动光标，选择态才切题。
- 证据：`中文（）` 中间插入后得到 `中文（补）充`；修复时 `npm run check` 和 669 项完整测试通过。

### Q-02 `Tab 直接回答` 被 App 层 Composer 快捷键抢占

- 状态：`staged`
- 原因：真实 App 先处理 `Tab 进入 Transcript` 和命令补全，之后才把输入交给 Question。
- 已暂存方案：非 Plan/Commands 模态面板优先拥有键盘输入。
- 待验证：已有消息、Composer 有命令草稿、空 Composer、Question 四种题型下的真实 `VspiApp.handleInput()` 路由。

### Q-03 长选项标签被截断，description 固定保留

- 状态：`verified`
- 修复：所有 label/description 能完整单行容纳时保留对齐布局；任一项超长即切换流式块，label 与 description 分别用 `wrapTextWithAnsi` 完整换行，绝不截断。

### Q-04 多行选项没有整块选择与滚动语义

- 状态：`verified`
- 修复：流式块内所有行共享 `›` 选中标记，frame 滚动以块为单位定位；块高于视口时保持块顶可见（不再首尾互斥）。

### Q-05 固定键位提示挤占长选项空间

- 状态：`verified`
- 修复：Question body 溢出时 hint 移到列表末尾随内容滚动（`hintRenderedInline`），App 不再追加外部固定行；未溢出时保留固定 hint。

### Q-06 用户 Esc 被当作 Agent abort，导致模型停摆

- 状态：`verified`
- 原因：App 把用户关闭 Question reject 为 `AbortError`，Pi 将其视为工具/生成中止，而不是一次正常用户选择。
- 修复：新增 `UserQuestionCancelledError` 边界；Question Tool 只把该错误转换为正常 ToolResult：`cancelledByUser: true`、所有题目标记 skipped，并附 `continuationHint` 要求模型继续或用普通文本重述必要问题。真实 AbortSignal 仍保持 AbortError。
- 证据：Question tool、App 输入路由、完整 94 个测试文件通过。

### Q-07 `/compact` 成功后被塞回 Composer

- 状态：`verified`
- 原因：App 在 manual compact catch 中统一恢复命令草稿；如果成功路径之后仍有异常收尾，就可能把 `/compact ...` 塞回输入框。
- 修复：成功后明确清空 Composer；仅后端 compaction 失败时恢复命令草稿。
- 证据：`/compact continuity` 成功/失败两条应用级回归通过。

## 4. Plan

### P-01 四种状态被压成三种展示状态

- 状态：`verified`
- 修复：`PlanItem.status` 扩展为 `pending/in_progress/blocked/done`；`○` pending、`●` in_progress、`✕` blocked、`✓` done；focus 独立 `focused` 字段（focus 色加粗）。状态循环 pending→in_progress→blocked→done。

### P-02 `[焦点]` 重复展示

- 状态：`verified`
- 修复：标题只保留标题，不再拼接任何内部状态。

### P-03 blocker 被拼进标题

- 状态：`verified`
- 修复：仅 `status=blocked` 且有真实原因时另起一行 `阻塞 <原因>`；`· 无` 等哨兵文本不再出现。

### P-04 blocker 可选契约存在集成不一致

- 状态：`verified`
- 结论：仓库三层（`PlanWorkItem.blocker?`、TypeBox `Type.Optional`、嵌套 children）均正确；此前观察到的“非空 blocker”来自会话侧工具描述而非仓库 schema。已补序列化 JSON Schema `required` 逐层断言防回归。

## 4.5 生命周期与状态一致性

### K-06 队列状态双向分叉：消息未进队列却已被模型收到

- 状态：`verified`
- 根因：App 用自己的 `activityActive()` 决定走 prompt 还是 queue 分支，与 backend 的真实 `session.isStreaming` 是两套真相；`agent_end` 先于 Pi settle 的窗口内两视图分叉。普通分支忽略 `SendResult.status === "queued"`，queued 分支也不处理 backend 实际已开始新 prompt 的结果。
- 修复：两条分支都以 backend `SendResult` 为最终真相校正呈现（queued lane ↔ 主流互转），并传 `clientMessageId` 保持 handoff 投影可消费。

### A-01 Approval 后出现“折叠”

- 状态：`investigate`
- 代码结论：Approval 路径只做 deny/allow/elevate 决策并关闭面板，自身不触发压缩，也不改 Transcript 窗口。最可能是后续 tool result 使上下文越过阈值触发 Pi 自动压缩（属预期），或用户看到的是 `collapseTools`/thinking 的 UI 折叠。
- 建议：下次复现时记录 `compaction_start` 的 reason 与前后 usage；若 reason=threshold 且 usage 刷新正常，则为预期行为而非缺陷。

## 5. 快捷键体系

### K-01 Registry 不是实际分发的唯一权威

- 状态：`confirmed`
- 现状：Registry 定义 action/hint，但 `VspiApp.handleInput()`、`PanelController.handleInput()` 和若干子组件仍有独立优先级与直接按键判断。
- 后果：提示和 Panel 单测正确，真实 TUI 仍可能被上层抢键。

### K-02 缺少模态层级规则

- 状态：`confirmed`
- 建议优先级：
  1. Session handoff / Auth / Rename / Preview 等顶层模态。
  2. Question / Approval 等阻塞式交互面板。
  3. 当前显式聚焦的普通 Panel。
  4. Transcript Inspect。
  5. Composer 全局命令、补全、附件操作。
  6. Composer 文本编辑兜底。
- 任何层消费输入后必须停止向下传播。

### K-03 catch-all action 掩盖冲突

- 状态：`confirmed`
- 位置：Question、Approval、Composer edit 使用 `matcher: () => true`。
- 风险：Registry 内部的第一个匹配和 App 外部优先级共同决定结果，静态检查无法发现抢键。
- 方案：按状态拆分 editing/navigation/review actions，明确列出可消费键；文本兜底只匹配可打印输入与编辑键。

### K-04 多个文本字段仍是手写字符串编辑

- 状态：`confirmed`
- 范围：Provider 文本、Settings endpoint、Attachment rename、Plan nextAction、Prompt import、Skill 搜索/添加、Auth 文本等。
- 风险：左右光标、Unicode 字素、IME、粘贴、撤销行为不一致。
- 方案：区分单行 `Input` 和多行 `Editor`，建立共享 TextField 包装，不再逐面板手写。

### K-05 测试只验证 Registry 结构，未验证真实路由

- 状态：`confirmed`
- 当前覆盖：action 存在、hint 存在、PanelController 直调。
- 缺口：`VspiApp.handleInput()` 在不同 panel/focus/composer/session 状态下最终由谁消费。
- 方案：建立按键路由矩阵，至少覆盖 Tab、Shift+Tab、Escape、Enter、方向键、Space、Ctrl+C、Ctrl+V、Alt+Enter、Backspace/Delete 和 Kitty CSI-u。

## 6. 实施顺序

已完成：快捷键路由矩阵与 Question Tab、Question 取消闭环、长选项布局与提示流动、Transcript 边界加载与渲染跳顶、VSPLab 模型继承与 272K 守卫、compaction usage 刷新与 /compact 回显、Plan 四状态/focus/blocker。

剩余：

1. 统一模态优先级与输入 action，消除 catch-all 抢键（K-01/K-03）。
2. 补齐 `VspiApp.handleInput()` 真实按键路由矩阵（K-05）。
3. 将手写文本字段分批迁移到共享输入组件（K-04）。
4. A-01 运行时取证（Approval 后 compaction reason/usage）。
5. 运行 40/80/120 列、24 行终端、Kitty/普通键协议、完整静态检查与全量测试。

## 完成标准

- 每个可见 hint 都有一条真实 `VspiApp.handleInput()` 测试证明可执行。
- 同一状态下一个物理按键只有一个最终 owner。
- 输入态不使用导航快捷键抢占左右光标和常规编辑键。
- 历史浏览与模型上下文压缩相互独立，完整 Session 历史始终可达。
- 模型窗口默认跟随 Pi，特殊覆盖有明确来源、守卫和测试。
