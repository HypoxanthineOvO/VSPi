---
kind: cycle-summary
cycle: C10-history-refresh-repair
status: closed
updated: 2026-08-08
---

# VSPi History Refresh 结构修复摘要

## 目的与边界

修复 History Refresh 的项目级语义结构，不修改 VSPi 源码，也不改变 C07、C08、C09 的任务状态。

## 结果

- 新建 `.pipeline/experiments/INDEX.md`。
- 新增 `.pipeline/local/` 默认 ignore，并建立 C09/C10 Discussion 与本 Session focus。
- 将误放在 Record Store 的 C05 验收证据迁移至 `.pipeline/memory/evidence/`，同步修正引用。
- 使用 Hypo-Workflow Core 重建 `.pipeline/memory/index.yaml` 与 `INDEX.md`。
- 项目总览更新为 3 个 active Cycle、7 个 closed Cycle、125 条合法 Record。

## 验证证据

- Core 重建结果：125 条 Record。
- 79 个 active Record 对应 79 个 active dedupe key；supersedes 缺失数为 0。
- C05 evidence SHA-256 与 Delivery 原绑定一致。
- Cycle 必需文件、项目入口、ignore、symlink 与 Git whitespace 检查通过。

## 重要决定与经验

- `memory/records` 只能容纳四种带合法 frontmatter 的权威 Record；普通验收证据必须放入 evidence 区域。
- 派生索引应通过 Core 重建，不能用物理 Markdown 文件数手工更新。

## 后续候选

无。
