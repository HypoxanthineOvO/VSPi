---
kind: discussion-summary
cycle: C19-vspi-subagent-runtime-audit
updated: 2026-08-19T12:30:42+08:00
---

# VSPi Subagent Runtime 审计讨论摘要

## 已确认要求与反馈

- 用户要求读取最近与 VSPi 的会话，检查其中涉及 VSPi Subagent 机制的巨大 Bug，并先汇报现状。
- 在用户批准现状报告之前，不开始讨论修复方案。
- 调查对象是 VSPi 自身，不是 VSP-Codex；首轮对象混淆已被用户纠正。

## 未确认假设

- run budget 的三个超限数值中 cache token 的精确占比，session tool result 未直接展示完整 usage breakdown，需要结合 runtime 事件或可控复现确认。

## 已确认审计结论

- 用户只是在讨论 Subagent 时会被关键词规则误判为明确要求强制委派。
- 所有 Subagent 失败后，回合末断言可以否决已生成的主回答；app 会删除本轮 transcript 并把原文恢复到 composer。
- run/tree budget 等权累计 input/output/cacheRead/cacheWrite，且在完整运行后检查，超限会覆盖已有成果。
- 同一 parent 存在未在工具描述中披露的累计 child=3 限制。
- 当前 Task Agent 为阻塞式一次性 session，不支持持久寻址和后续消息交互。

## 已确认方案决定

- P0 止血与 v2 runtime 分两阶段交付。
- Agent identity 绑定 Root Session，支持跨 turn 和进程 resume；不同 Root Session 严格隔离。
- Teammate 暂时 Ban：关闭入口与路由，但不删除实现、配置兼容或历史数据，后续另议。
- token/cache/cost/elapsed 全部仅作 telemetry；VSPi 不以 Agent budget 自动停止、拒绝或作废成果。
- v2 上线时直接删除旧 `subagent`，不保留兼容 wrapper。
- VSPi 不设 Agent generation concurrency、tree size 或 per-parent child 运行上限；spawn 立即运行。
- `fork_turns` 默认 `all`，以 spawn 时完整可见历史建立结构化分叉。
- Agent 默认继承 caller 工具，但排除 Root Session 所有权和直接用户交互控制；execution policy 继续生效。
- P0 采用完整范围：同时处理意图/final 事务、预算与 scheduler、Teammate Ban、bash 分类和基础进度。
- Agent 嵌套深度可配置、默认 3；超限只禁止继续 spawn。
- child final 全文自动送达直接 parent；Root 只自动接收后代状态与摘要。
- resume 保留未完成 Agent 的 identity/history 并标记 interrupted，不自动重跑。
- Root 是唯一 composer，Agent Inspector 只读。
- interrupt 默认仅目标，可显式包含 descendants。
- Transcript 与 `/agents` 同时显示进度，使用同一事件模型。
- identity 使用稳定 path 寻址，并支持仅展示用途的可选中文 nickname。

## S2 补充决定（2026-08-19）

- 发布节奏：Phase A（完整 P0）→ v1.1.2；Phase B（v2 runtime）→ v1.2.0。
- P0-1 强制门禁：整体删除关键词检测与回合末 authority 断言，不保留“只认明确命令句”的折中；真强制意图由模型按用户原话自行遵循。
- P0-2 限制字段：`maxAgentsPerTree`/`maxConcurrency`/`maxRunTokens`/`maxTreeTokens`/`maxTreeCostUsd`/`maxRunSeconds` 保留于配置、降级为仅标黄的警戒线；`maxDepth` 默认 3 保留。
- P0-3 Teammate UI：完全隐藏（面板、配置页、命令、路由入口），非灰色禁用态；数据与配置解析照旧保留。
- config 界面清理：只做 P0 顺带瘦身（限制字段降级、teammate 隐藏），不做额外布局重构。
- P0-5 进度补全：按现有投影小改，不提前引入 v2 事件模型；工具描述 limits 文案与实际行为同步。
- P0-6 状态栏微调（源自 2026-08-18 目标 session 首条消息的“次要方面”）：Speed 仅显示平均吞吐，移除瞬时值；CH 移出 Speed 并入 Token，显示为 `Token ↑x ↓y Hit Rate: z%`（最近请求口径）；窄终端先省略 Hit Rate 再省略 `↓y`；`/usage` 面板不变。

## Discussion Ledger

### 2026-08-18 - 用户要求检查 VSPi Subagent 巨大 Bug

> $hypo-workflow:cycle 读一下最近我和 VSPi 的会话，里面有一个涉及到 VSPi Subagent 机制的巨大 Bug，我希望你检查一下，并整理一下现状汇报给我，等我批准之后开始和我讨论方案。

### 2026-08-18 - 用户纠正调查对象

> 我说的是 VSPi，不是 VSP-Codex，你完全搞错了吧

### 2026-08-18 - S1 接受

> 批准，开始讨论方案

用户接受 C19 现状报告，授权进入方案讨论；尚未授权修改产品源码。

### 2026-08-18 - M5 第一组方案选择

> 交付顺序：先 P0，再 v2。
>
> Agent 生命周期：绑定 Root Session，可 resume。
>
> Teammate：先 Ban 掉，但是不删掉，就是关闭入口，后面再说。
>
> 预算语义：全部只做遥测。

### 2026-08-18 - M5 第二组方案选择

> 旧工具兼容：v2 上线即删除。
>
> 并发行为：不设 VSPi 并发容量。
>
> 上下文默认：完整结构化 fork。
>
> 工具继承：继承 caller，排除 Root 控制。

### 2026-08-18 - 本轮只记录 Plan

> 我们这轮只讨论需求，因为我额度不够了，不要开始真的改昂，记下 Plan 即可
>
> 还有问题要问我吗 问的问题还是一起问

用户要求将剩余问题一次问完；回答后只保存 Plan，不进入源码实施。

### 2026-08-18 - M5 最后一组方案选择

> P0：完整 P0。
>
> 嵌套深度：可配置，默认 3。
>
> 完成回传：自动给 parent，Root 看摘要。
>
> Resume：保留并标记 interrupted。
>
> 用户交互：Root-only + 只读 Inspector。
>
> Interrupt：默认仅目标，可选后代。
>
> 进度可见性：Transcript + /agents。
>
> 命名寻址：稳定路径 + 可选昵称。

### 2026-08-19 - S2 P0 细节定稿

> 我们挨个研究讲解一下呢？因为除了这些之外可能 P0 还包括一些细节微调，比如 vspi config 的界面可能想更清晰一点？这个属于细节了，你这个 P0 的讨论先开始吧，我们先一口气做完 P0 发一个 1.1.2？v2 做完发 1.2.0。

用户确认发布节奏（P0→1.1.2，v2→1.2.0），随后经逐项讲解确认：门禁整体删除、限制字段留作警戒线、Teammate 完全隐藏、config 界面只做顺带瘦身。

### 2026-08-19 - S2 补入状态栏微调

> 不是还有一点点界面调整吗？就是那个命中率和速度的调整

用户提醒目标 session 首条消息的“次要方面”（Speed 只留平均、CH 并入 Token 为 `Token ↑x ↓y Hit Rate: z%`）仍需纳入 P0；确认为 P0-6，原回归审阅项顺延为 P0-7。
