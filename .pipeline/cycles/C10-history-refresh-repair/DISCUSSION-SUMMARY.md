---
kind: discussion-summary
cycle: C10-history-refresh-repair
updated: 2026-08-08
raw_discussion: .pipeline/local/discussions/C10-history-refresh-repair/
---

# VSPi History Refresh 结构修复讨论摘要

## 已确认需求

- 用户要求执行 History Refresh，并在发现结构缺口后明确要求直接修复。
- 修复必须保留 Legacy Delivery 和现有 C07、C08、C09 的语义状态。

## 已作决定

- 创建独立 C10 承载项目级修复。
- 使用权威 Markdown Record 与 Hypo-Workflow Core 重建派生索引，不手工猜测 active/superseded 状态。

## 接受与拒绝

- 用户明确授权迁移并删除 Record Store 中错误的 evidence 旧路径。
- 修复经结构完整性检查接受，C10 关闭。

## 未决问题

无。
