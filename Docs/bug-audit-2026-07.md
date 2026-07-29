# VSPi 缺陷盘点与修复计划

更新时间：2026-07-28

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

### C-03 压缩原因与窗口证据

- 状态：`verified`
- 机制：Pi 默认在 `contextTokens > contextWindow - reserveTokens` 时压缩；默认 reserve 为 16,384。上下文压缩不删除 Session JSONL 历史。
- 修复：`compaction_start/end` 现在向 Transcript 写入 Session 诊断，记录原生 `reason`、压缩前后 tokens、context window、reserve 与 retry；threshold/overflow/manual 不再依据相邻的 Approval 猜测。
- 证据：28,500→12,000 / 32,000、reserve 16,384、reason threshold、retry no 的事件契约测试。

## 2. Transcript 历史浏览

### T-01 前景窗口有硬上限但没有加载入口

- 状态：`verified`
- 修复：完成消息进入原生 scrollback；Composer `PageUp` 直接进入 Inspect，Inspect 的 `PageUp/PageDown` 每次至少跨五个节点或一个当前可视批次并自动加载相邻历史，方向键仍支持节点级浏览。界面不显示无法交互的隐藏数量占位，完整 Session 历史始终作为 Inspect 数据源。
- 证据：60/140 条历史可一路向上到第 0 条、到顶安全提示、向下回尾部、渲染帧 ≤ 24 行；M2 旧“限制在窗口内”测试更新为新契约。

### T-03 渲染输出超过终端高度导致周期性清屏跳顶

- 状态：`verified`
- 根因：`maxRows = rows * 6` 使输出远超一屏；窗口滑动或顶部提示变化令 `firstChanged < viewportTop`，pi-tui 走 `fullRender(true)`（`\x1b[2J\x1b[H\x1b[3J`），清屏并清终端原生 scrollback。
- 修复：Transcript 窗口改为视口预算（终端行数减去 composer/activity/queue/status/panel/hint），整帧永不超高，差分渲染始终命中；Inspect 聚焦时 Plan 面板让位给历史浏览。
- 证据：长 busy transcript + Plan 面板下 80x24 帧高不变量测试。

### T-02 历史加载与模型上下文压缩概念未分离

- 状态：`verified`
- 修复：Splash、恢复历史和完成 turn 静态提交到原生 scrollback；live viewport 只渲染流式尾部与 Composer。压缩诊断只描述模型 context，Inspect 始终读取完整 Session。

## 3. Question

### Q-01 填空输入不是正常编辑器

- 状态：`verified`
- 原因：手写字符串追加逻辑先拦截左右切题，不支持光标、Unicode 字素或 IME 硬件光标。
- 修复：改用 Pi TUI `Input`；输入态左右键移动光标，选择态才切题。
- 证据：`中文（）` 中间插入后得到 `中文（补）充`；修复时 `npm run check` 和 669 项完整测试通过。

### Q-02 `Tab 直接回答` 被 App 层 Composer 快捷键抢占

- 状态：`verified`
- 修复：Question/Approval 等模态在 App 层先于 Composer 获得完整输入所有权；直接回答、四种题型、命令草稿和已有消息组合均有真实 `VspiApp.handleInput()` 回归。

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

- 状态：`verified`
- 结论：Approval 路径只做 deny/allow/elevate 决策并关闭面板，自身不触发压缩。若后续 tool result 越过阈值，Pi 会以 `reason=threshold` 或 `reason=overflow` 明确报告。
- 修复：压缩开始/结束诊断记录 reason、前后 usage、window、reserve、retry；Approval 与 compaction 不再通过时间相邻推断因果。

## 5. 快捷键体系

### K-01 Registry 不是实际分发的唯一权威

- 状态：`verified`
- 修复：App 明确按 Session handoff/Auth/Rename/Preview、Question/Approval、普通 Panel、Transcript、Composer command、Composer editor 的顺序分发；消费后立即返回。

### K-02 缺少模态层级规则

- 状态：`verified`
  1. Session handoff / Auth / Rename / Preview 等顶层模态。
  2. Question / Approval 等阻塞式交互面板。
  3. 当前显式聚焦的普通 Panel。
  4. Transcript Inspect。
  5. Composer 全局命令、补全、附件操作。
  6. Composer 文本编辑兜底。
- 任何层消费输入后必须停止向下传播。

### K-03 catch-all action 掩盖冲突

- 状态：`verified`
- 修复：Question、Approval、Composer edit 的 catch-all 已替换为可打印输入、编辑键、bracketed paste 和明确导航键；未知 CSI 不匹配任何 owner。

### K-04 多个文本字段仍是手写字符串编辑

- 状态：`verified`
- 修复：Provider、Settings endpoint、Attachment rename、Plan nextAction、Prompt import、Skill、Auth、Approval 与搜索字段统一复用 Pi TUI `Input` 状态，支持左右光标、Unicode 字素和一致的删除/粘贴行为。

### K-05 测试只验证 Registry 结构，未验证真实路由

- 状态：`verified`
- 证据：真实 `VspiApp.handleInput()` 覆盖 Tab、Shift+Tab、Escape、Enter、方向键、Space、Ctrl+C、Alt+Enter、PageUp/PageDown、Backspace/Delete 和 Kitty CSI-u；未知 CSI 有负向 owner 测试。

## 6. 实施顺序

已完成：统一模态 owner、消除 catch-all、共享输入组件、真实按键路由矩阵、Question 全流程、Transcript static/live split、Splash 原生 scrollback、VSPLab 模型继承、运行期 Model 切换、compaction 诊断、Plan 状态与交互命令生命周期。

剩余：无已知实现项；发布前只执行最终静态检查、全量测试和真实 PTY smoke。

## 完成标准

- 每个可见 hint 都有一条真实 `VspiApp.handleInput()` 测试证明可执行。
- 同一状态下一个物理按键只有一个最终 owner。
- 输入态不使用导航快捷键抢占左右光标和常规编辑键。
- 历史浏览与模型上下文压缩相互独立，完整 Session 历史始终可达。
- 模型窗口默认跟随 Pi，特殊覆盖有明确来源、守卫和测试。
