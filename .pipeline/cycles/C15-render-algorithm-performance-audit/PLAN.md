---
kind: plan
cycle: C15-render-algorithm-performance-audit
mode: plan
status: closed
updated: 2026-08-17T00:55:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C14-streaming-render-regression
---

# 渲染算法性能审计

## 目的

对 VSPi 渲染算法做系统性性能审计，产出带量化证据的问题分级报告。审计对象是 C14 交付后的现行渲染链路：frame pacing（`tui-frame-pacer.ts`）、native viewport shift 检测（`terminal-frame-optimizer.ts`）、fullscreen body/dock semantic cache 与 transcript message cache（`vspi-app.ts`、`transcript.ts`）、transcript/panels/markdown 等组件构建成本，以及 Pi 官方 layout scheduling 与 differential write 在该链路中的责任边界。

## 背景

- C14 已以“基本可用线”接受，保留边界：真实 VSCode Remote SSH Terminal 高历史位置反向滚动仍不理想，本轮不将其升级为 Pi ScrollView 重构。
- 项目 preference（`preference-43221dda2fae2a29a42d6bab24ac5bb0`）要求默认复用 Pi 官方 render architecture；VSPi 自建渲染层需要测量证据与回归覆盖，审计默认以该 preference 为归因基线。
- C14 经验约束：毫秒级 synthetic benchmark 不构成真实症状复现；审计证据必须区分远端 Node 帧计算成本与本地 terminal renderer 积压（DSR/backlog）两类现象。

## 边界

- 本 Cycle 是审计 Cycle：默认只产出问题清单、根因、量化证据与修复建议（含优先级与上下游归属），不在本 Cycle 内实施架构级修复；审计期间发现的小型可验证修复需先经用户确认是否纳入。
- 不回退 C14 已接受的行为：通用 30 FPS pacing、focused keyboard 即时刷新、滚轮 3 行、100ms viewport 合并、native viewport shift 与 fullscreen semantic cache 保持现状。
- trace 与 profile 遵循 C14 隐私约定：不保存屏幕正文，只记录 write 数、bytes、rewritten rows、DSR、帧耗时、CPU 等无正文数据。
- 不以单点 trace 代替场景矩阵；结论必须标注测量环境（direct PTY、xterm-headless、真实 VSCode Terminal）。

## 计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 审计基线与测量口径 | 定义 KPI（frame 耗时分布、per-frame build 次数、write bytes、rewritten rows、DSR backlog、CPU）与场景矩阵；复用并固化 C14 无正文 trace 工具 | 基线文档与工具可在本机重复运行 |
| `M2` | 渲染算法代码路径审计 | 对 pacer、shift 检测、semantic/transcript cache 失效逻辑与组件构建的复杂度、冗余计算、失效正确性给出静态审计结论，标注热点与风险 | 逐文件审计记录 + 热点清单，必要时以 micro-profile 佐证 |
| `M3` | 真实场景量化测量 | 场景矩阵下取得量化数据：streaming、纯滚动、高历史位置反向滚动（C14 遗留边界）、长会话/长消息、resize、宽窄终端 | direct PTY / xterm-headless / 真实 Terminal 三层证据，标注环境 |
| `M4` | 审计报告与问题分级 | 输出 AUDIT.md：问题清单、根因、量化证据、修复建议与优先级，区分上游 Pi 侧与 VSPi 侧，并对每个建议标注与官方架构 preference 的符合性 | 报告经 M1-M3 证据链交叉核对 |
| `S1` | 用户审阅审计结论 | 用户确认审计结论与修复项去向（后续 Cycle / 纳入本 Cycle / 搁置） | 用户明确接受或退回补充测量 |
