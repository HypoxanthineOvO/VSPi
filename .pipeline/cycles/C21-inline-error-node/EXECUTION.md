---
kind: execution
cycle: C21-inline-error-node
updated: 2026-08-20T21:09:09+08:00
---

# Execution Checkpoints

## 2026-08-20 - 方案确认

- 用户批准轻量单行错误节点：用错误符号替代 assistant `·`，展开观感和工具调用详情一致。
- `pi-tui` 仅提供基础组件；上游 `AssistantMessageComponent` 会直接输出完整错误，`ToolExecutionComponent` 是私有且工具专用，因此不直接复用。

## 2026-08-20 - 实施完成

- 新增轻量 `TranscriptMessage.kind = "error"`，保存 summary、model、pretty detail 与 expanded 状态。
- live `message_end(stopReason="error")` 与历史 hydration 都投影为错误节点；aborted 不生成错误。
- renderer 折叠态严格一行，无边框；展开态复用 transcript wrapping、selection 和窗口高度估算。
- App 复用 Inspect toggle；`Ctrl+O` 定位并展开最近错误。普通本地 error notice 恢复原始短文本。
- 验证：定向 71 项、interaction/layout/session 59 项通过；全量 Vitest 通过；TypeScript、Biome、`git diff --check` 通过。
