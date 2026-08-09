---
kind: plan
cycle: C10-history-refresh-repair
status: closed
updated: 2026-08-08
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi History Refresh 结构修复

## 执行目的

修复 History Refresh 审阅发现的语义化 Workflow 结构缺口，使项目索引、Experiment 索引、Memory 派生索引和本地 Discussion 入口重新一致且可恢复。

## 执行边界

只修复 `.pipeline/` 语义索引、本地 session/discussion 入口和 `.gitignore`。不修改源码，不改变 C07、C08、C09 的任务或状态。Legacy Delivery 的状态、revision、digest 与交付内容保持不变；允许为恢复 Record Store 合法结构而修正一个 evidence path 指针。

## 验证目标

- 项目索引引用的 Cycle、Memory、Experiment 入口全部存在。
- Memory 的 YAML 与 Markdown 派生索引覆盖全部权威 Record，并保持 supersession 图一致。
- C09 的本地 Discussion 路径存在且默认不进入 Git。
- Cycle 必需文件、索引计数和 Git 状态一致。

## 任务列表

| ID | 任务 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `R1` | 修复结构入口 | 补齐 Experiment 索引、本地 Discussion 忽略规则与目录 | 路径、ignore 与 symlink 检查 |
| `R2` | 重建 Memory 派生索引 | `index.yaml` 与 `INDEX.md` 覆盖全部权威 Record | 使用 Hypo-Workflow Core 重建并核对数量 |
| `R3` | 验证并关闭 | 所有语义引用可达，历史权威未被改写 | 完整性检查、diff 审阅与 Cycle Summary |
