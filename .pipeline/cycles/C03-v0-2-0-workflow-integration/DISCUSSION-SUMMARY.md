---
kind: discussion-summary
cycle: C03-v0-2-0-workflow-integration
updated: 2026-07-25
raw_discussion: .pipeline/memory/records/cycle-4165928aca5b/
---

# VSPi v0.2.0 Workflow 集成讨论摘要

## 已确认需求

- Thinking 显示提供 hidden/collapsed/expanded 三态，思考记录始终可见（至少最简记录行）。
- thinkingDisplay 是 VSPi 显示偏好，不进入 Workflow 语义或模型工具参数。
- 可用性优先：工具展示压缩、审批体验、动态工具收束与 Policy 标签需要同步修正。

## 已作决定

- AppSettings 使用 thinkingDisplay enum，默认 collapsed；normalizeSettings 优先读取 thinkingDisplay，再迁移 showThinking，最后回退 collapsed。
- ThinkingMessage 暴露 streaming：live start 为 true、message_end 为 false、history 为 false。
- 工具展示压缩与审批体验修订（决策 `decision-b8ef0133`、`decision-bc7ae00b`）：动态收束与 Policy 标签落地。

## 接受与拒绝

- M1 Stone `S-thinking-display-mode` 接受后进入 M2。
- 多次修订聚焦"始终可见的思考记录"（decision-9444032a）与"Thinking 三态显示模式修订"（decision-34f87a27）。
- "可用性优先与 Workflow 集成"（decision-5a7bb757、decision-b8914dcc、decision-ff351e9d）作为并行主线被接受。

## 纠正与分歧

- Workflow 集成范围多次收敛：不注册 plan_* 工具、Provider 只读、显示偏好与模型参数分离。

## 未决问题

- 无结构性未决问题。
