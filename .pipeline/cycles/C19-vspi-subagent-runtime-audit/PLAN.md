---
kind: plan
cycle: C19-vspi-subagent-runtime-audit
mode: plan
status: completed
updated: 2026-08-19T14:20:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C07-subagent-teams
---

# VSPi Subagent Runtime 审计

## 目的

从 VSPi 原生 Pi session 与当前源码出发，核查用户最近会话中出现的 Subagent 强制路由、预算失败、每父节点 child 限制、进度可见性和失败回传问题，先形成可审阅的现状报告；用户批准后再进入方案讨论。

## 边界

- 调查对象仅为 VSPi 自身 runtime 与 `~/.pi/agent/sessions/` 中的 VSPi 会话，不把会话内容中涉及的 VSP-Codex 项目作为本 Cycle 证据。
- 审计阶段只读取 session、源码、测试与历史合同，不修改产品源码，不提前确定修复设计。
- 报告区分用户直接观察、session 事件事实、源码确认、推断和未决问题。
- C07 的安全与权限边界作为历史合同输入，但不自动继承旧任务。
- 本轮只讨论需求并记录 Plan；未经后续 S2 明确授权，不修改产品源码、测试、依赖或发布状态。

## 已确认需求合同

### 交付与兼容

- 分两阶段交付：先完整 P0，再实现 v2 runtime。
- 发布节奏：Phase A 完成并经人工审阅后发布 v1.1.2；Phase B 完成并经人工审阅后发布 v1.2.0。
- v2 上线时直接删除旧 `subagent` 工具，不保留兼容 wrapper，也不长期暴露两套工具语义。
- Teammate 暂时 Ban：关闭配置入口、自动/手动路由和模型调用入口；保留实现、配置解析与历史数据，后续另开讨论决定迁移或删除。

### Agent 生命周期与归属

- Agent identity 绑定一个 Root Session，跨 root turn 和进程 resume 保留；不同 Root Session 严格隔离。
- 运行中的 provider request 在进程退出后不自动重跑。resume 恢复 identity/history，并把该 turn 标记为 `interrupted`，等待新的 `followup_task`。
- `spawn_agent` 必须提供稳定 `task_name`，形成 `/root/name/child` 路径；可选中文 nickname 只用于显示，不参与寻址。
- 递归深度可配置，默认 3；达到深度时只禁止继续 spawn，不影响当前 Agent 自行完成。

### 资源与权限

- token、cache、cost、elapsed 全部仅作 telemetry，不作为 VSPi 的停止、拒绝、排队或成果作废条件。
- 限制字段降级为警戒线：`maxAgentsPerTree`/`maxConcurrency`/`maxRunTokens`/`maxTreeTokens`/`maxTreeCostUsd`/`maxRunSeconds` 保留于配置，超限仅在进度中标黄提醒，绝不拒绝、作废或覆盖真实错误；`maxDepth` 保留默认 3、可配置，超限仅禁止继续 spawn。
- VSPi 不设 generation concurrency、tree size 或 per-parent child 数量上限；spawn 立即运行。
- Agent 默认继承 caller 的工具，排除 Root Session 所有权和直接用户交互控制；execution policy、workspace boundary 与共享工作区约束继续生效。
- 默认 `fork_turns=all`，从 spawn 时的完整可见历史建立结构化分叉；显式支持 `none` 和最近 N 轮。

### 通信与交互

- v2 工具族为 `spawn_agent`、`followup_task`、`send_message`、`wait_agent`、`interrupt_agent`、`list_agents`。
- child final 自动全文送达直接 parent；Root 可见所有后代的状态与摘要，但孙级全文不自动注入 Root context。
- `interrupt_agent` 默认只中断目标当前 turn，并支持显式 `include_descendants` 级联。
- Root 是唯一 composer；用户通过只读 Agent Inspector 查看 child 完整 history/messages，不直接切入 child 对话。
- 主 Transcript 显示紧凑生命周期、当前工具、最近活动和 final 通知；`/agents` 显示完整树、activity、messages 与 usage；两处共享同一事件模型。

## 两阶段实施 Plan

### Phase A：完整 P0

| ID | 工作项 | 预期行为 | 验证重点 |
| --- | --- | --- | --- |
| `P0-1` | 移除自然语言强制门禁 | 整体删除关键词检测：不再注入“用户明确要求”capability，移除回合末 authority 断言；真强制意图由模型按用户原话自行遵循 | 复放目标 session 原文，讨论 Subagent 不改变权限；主回答保留且 composer 不恢复旧 draft |
| `P0-2` | 预算与 scheduler 去硬门禁 | 6 个限制字段降级为仅标黄的警戒线；移除 per-parent child=3 与 concurrency/tree 拒绝；catch 路径不再用预算错误覆盖真实错误；`maxDepth` 默认 3 保留；工具描述 limits 文案同步 | 4+ sibling 均启动；高 usage 返回成果并标黄遥测；深度超限只拒绝继续 spawn；provider 错误原样上报 |
| `P0-3` | Teammate Ban | 面板、配置页、命令、自动/手动路由全部隐藏，界面上当其不存在；旧 `.vspi/agents.json` 仍可解析、数据不丢失 | 旧配置可加载但不参与 runtime；UI 无 teammate 痕迹 |
| `P0-4` | bash 分类修正 | 由只读命令组成的 `&&`/pipe 保持只读；写入和网络分类不放宽 | `ls && cat | head` 允许，重定向/写命令仍按原 policy |
| `P0-5` | 基础进度补全 | 在现有投影上小改：current tool、turn、最近活动、elapsed、实际 usage；超警戒线标黄；不显示 `tokens left`；不提前引入 v2 事件模型 | 长任务持续可观察，错误 run 也有状态记录 |
| `P0-6` | 状态栏 Speed/CH 微调 | Speed 仅显示平均吞吐；CH 移出 Speed 并入 Token，显示为 `Token ↑x ↓y Hit Rate: z%`（Hit Rate 取最近请求口径）；窄终端先省略 Hit Rate 再省略 `↓y`；`/usage` 面板不变 | 40/80/120 列状态栏渲染测试更新；Speed 不再显示瞬时值 |
| `P0-7` | P0 回归与候选审阅 | 目标复现链消失，现有安全边界保持；以 AUDIT 第五节缺失场景为新测试清单；覆盖 P0-1 至 P0-6 | Agent focused、app 提交事务、PTY/Transcript/状态栏定向回归；通过后发布 v1.1.2，停在人工审阅 |

### Phase A+：命令幻觉快速修复（用户报告的外部会话事故）

用户反馈另一台 Windows 机器的会话中，模型先后推荐了不存在的 `/reload`、`/wsl-fix` 与 `vspi -c`。归因：模型把捆绑在 node_modules 内的上游 pi 文档（含 `/reload` 命令表、扩展热加载、`-c` 语义）当成 VSPi 事实来源，且 VSPi 提示词从未声明产品差异与真实命令清单。与 Subagent 审计无关，并入本 Cycle 一起发布 v1.1.2。

| ID | 工作项 | 预期行为 | 验证重点 |
| --- | --- | --- | --- |
| `F1` | 提示词命令契约 | 系统提示词注入由 `ACTION_REGISTRY` 动态生成的命令清单 + 产品差异声明（上游 pi 文档不适用）+ 修改本体/配置后建议 `/reload` 的通用引导（不点名具体文件或事故） | 契约与注册表同步测试；引导文案不含事故细节 |
| `F2` | `/reload` 命令 | 运行空闲时可执行：spawn `vspi continue`（同 tty），新进程经既有 lease handoff 接管会话，旧进程退出；运行中拒绝 | 注册表包含 `/reload`；handler 走注入 launcher、busy 拒绝、不触 send |
| `F3` | 去 pi 文档 + CLI 兼容 | postinstall 移除依赖内 pi `docs/`、`examples/`、上游 README（错误信息源头）；CLI 补 `-c/--continue`、`-r/--resume` 别名（常见 CLI 语义对齐） | 全新 tarball 安装后文档目录不存在且 `vspi --version` 正常；别名 help 有记载、一帧渲染可用 |

### Phase B：Subagent v2 Runtime

| ID | 工作项 | 预期行为 | 验证重点 |
| --- | --- | --- | --- |
| `V2-1` | Durable Agent Registry | 保存 rootSessionId、stable path、parent、nickname、runtime identity、status 与 timestamps | Root Session 隔离；resume 后树、终态和 interrupted 状态准确 |
| `V2-2` | 结构化 session fork | 支持 `all`/`none`/N turns，默认 all；分叉后独立增长 | 不再用 1MB JSON 文本注入；跨 provider 边界遵守 C07 合同 |
| `V2-3` | 异步生命周期工具族 | spawn 立即返回 identity；follow-up/send/wait/interrupt/list 各自语义独立 | 多 Agent 同时运行、完成后复用、嵌套 depth=3、显式级联 interrupt |
| `V2-4` | Message Bus 与结果回传 | parent 收 child final 全文；Root 收后代状态/摘要；消息不重复注入 | parent/root/孙级路由、mailbox 幂等、长结果与 resume 回放 |
| `V2-5` | 工具继承与执行边界 | caller 工具继承，排除 Root 控制；共享 policy 与工作区 | 文件/网络/plugin/子 Agent 能力；Root-only 操作不可越权 |
| `V2-6` | 统一可观测性 | Transcript 紧凑事件 + `/agents` 完整 Inspector，共享事件真相源 | current tool/activity/messages/usage/终态一致，窄宽终端可用 |
| `V2-7` | 移除旧 runtime 表面 | 删除旧 `subagent` 工具；Teammate 继续保持 Ban 和数据兼容 | 工具 schema 无旧入口；旧配置不被破坏；无双 runtime |
| `V2-8` | v2 集成审阅 | 生命周期、resume、通信、权限和 UI 形成端到端证据 | focused + app/session resume + PTY；停在发布前人工审阅 |

## 计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 目标会话定位 | 锁定正确的 VSPi Pi session，排除 Codex rollout 与 VSP-Codex 项目混淆 | session header、cwd 与用户原文交叉确认 |
| `M2` | 运行时证据还原 | 还原强制 Subagent 注入、工具拒绝、预算错误、child limit 与用户消息退回链路 | JSONL 事件顺序、tool result、timestamp |
| `M3` | 源码与测试审计 | 核实触发规则、预算口径、失败时机、scheduler 限制、状态投影和测试缺口 | 逐文件静态审计 + 定向现有测试 |
| `M4` | 现状报告 | 输出问题分级、影响、已知/未知边界，不包含修复方案 | AUDIT.md 与证据链交叉核对 |
| `S1` | 用户审阅 | 用户批准现状报告后，决定是否进入方案讨论 | 用户明确批准或退回补充调查 |
| `M5` | 方案讨论 | 在不修改源码的前提下讨论 P0 止血边界、v2 runtime 目标、兼容与迁移策略 | 用户决定关键架构语义 |
| `S2` | 实施授权 | 用户审阅最终方案与实施计划，决定是否开始修改源码 | 用户明确批准或退回方案 |
