---
kind: plan
mode: plan
cycle: C07-subagent-teams
status: closed
updated: 2026-08-09
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi Subagent 与项目 Teammate Corrective Plan

## 执行目的

基于当前已存在的 `PiAgentManager`、scheduler、Task Agent、Teammate lane、routing、fallback 与 `/agents` UI，修复权威、隔离、持久一致性、资源预算和审计可见性缺口；不从旧 revision 0 重复实现 m1–m4。

## 执行边界

- 保留 C05 已验证能力和当前 dirty worktree，不回滚用户修改。
- legacy Delivery `vspi-subagent-teams` revision 0 只读保留；本 Plan 是当前语义 authority。
- 不引入独立 worktree、多写者合并、后台 daemon 或新第三方 runtime。
- 不发布版本、不提交、不推送、不调用真实付费模型。

## 验证目标

- 默认 limits 为 depth 3 / tree 12 / concurrency 16；可信项目可显式配置，硬上限为 5 / 128 / 16。
- 完整父历史不跨 Provider；Task Agent 默认 in-memory，持久化仅保留有界、脱敏的审计投影。
- 持久操作使用结构化用户命令，不由自然语言关键词推断授权；Teammate identity 不可被单次调用替换。
- 所有 child bash/edit/write 进入真实单写者边界；lane 具备跨进程 Session lease 与 stale 检测。
- 每次 run/tree 有 token、cost、time 边界；取消级联到 active 与 queued descendants。
- `/agents` 展示真实结构化 timeline，而不是把 4K output preview 命名为完整 Transcript。

## 完整计划

| ID | 类型 | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- | --- |
| `M1` | Milestone | 基线与安全合同 | 将现状、威胁模型、默认值、硬边界和 deferred scope 固化为可审阅合同 | `SECURITY-CONTRACT.md` 覆盖跨 Provider、identity、授权、写入、lane、预算、留存、取消和 UI |
| `S1` | Stone `security-contract-review` | 安全合同审阅 | 用户审阅合同与默认策略，接受后才允许修改 Agent runtime | 展示威胁矩阵、默认/硬上限、数据流和明确 deferred 项；接受标准见安全合同 |
| `M2` | Milestone | Scheduler 与 Task Agent corrective implementation | 对齐 3/12/16 默认与 5/128/16 硬上限；Task Agent in-memory；跨 Provider/预算/取消/单写者边界 fail closed | schema、scheduler、真实 SDK、并行/递归、budget、cancel、provider-boundary 与 bash-writer 测试 |
| `M3` | Milestone | Teammate authority 与持久连续性 | 固定 Teammate identity；以结构化命令管理/override；补齐 routing 语义、lane lease、stale 检测与 sticky fallback | 权限 intent、required/preferred/consult/manual、跨进程 lane、reset/model switch/fallback 测试 |
| `S2` | Stone `agent-runtime-review` | Runtime 真实演示审阅 | 用户检查 Task Agent/Teammate 的隔离、Provider、预算、取消、lane ownership 与 failure states | 无付费 fixture/本地 SDK 演示；至少覆盖并行、递归、required、跨进程冲突和预算停止 |
| `M4` | Milestone | 审计投影与 `/agents` UI | Map/Timeline/Tools/Pools 展示真实 run tree、权限、上下文来源、usage/budget、lane owner、fallback 和结构化事件 | 40/80/120 渲染、键盘、长文本、脱敏、PTY 与 transcript 状态测试 |
| `S3` | Stone `agents-ui-review` | 终端 UI 真实演示审阅 | 用户能区分 Task Agent/Teammate、preview/timeline、current/preferred model、授权与阻塞状态 | 真实 `/agents`、主 transcript、窄/宽终端与错误场景演示 |
| `M5` | Milestone | 安全回归与 Cycle close | 文档与实现一致，通过完整质量门禁并关闭 C07 | `npm run check`、targeted Vitest、全量 `npm test`、build、smoke、PTY、依赖审计 |

ID 在本 Cycle 内保持稳定；普通 Milestone 验证后自动继续，Stone 必须等待用户接受。

## Deferred

- 独立 Git worktree、模块所有权与多写者 merge。
- 后台 Agent daemon、远程团队同步与跨机器 lane handoff。
- 将任意完整父对话发送到不同 Provider。
