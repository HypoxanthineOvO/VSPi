---
kind: plan
cycle: C03-v0-2-0-workflow-integration
status: closed
updated: 2026-07-25
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi v0.2.0 Workflow 集成

## 执行目的

在 v0.1.0 基础上交付 v0.2.0：Thinking 三态显示（hidden/collapsed/expanded）Stone、Settings 与 Workflow 边界回归、Session/历史/取消回归与全量发布边界回归。

## 执行边界

thinkingDisplay 只属于 VSPi 显示偏好，不写入 Workflow 或模型工具参数。Workflow Provider 保持只读，模型清单不含 plan_* 工具。

## 验证目标

三态显示在实时流式、历史会话、Session hydration、切换、取消与迟到事件隔离下保持一致；旧配置（showThinking）自动迁移；全量质量门禁通过。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | Thinking 三态显示 Stone（Stone `S-thinking-display-mode`） | 交付 hidden/collapsed/expanded 三态设置、始终可见的思考记录、正文展开和旧配置迁移 | Stone 审阅：隐藏/折叠/展开三态文案与 Apply/Cancel；历史会话与 Inspect 可见性 |
| `M2` | Settings 与 Workflow 边界回归 | 确认 thinkingDisplay 只属于 VSPi 显示偏好，不写入 Workflow 或模型工具参数 | Global/Project settings 分层和 trust 边界不回退；Workflow Provider 保持只读且模型清单无 plan_* |
| `M3` | Session、历史与取消回归 | 三态显示在 Session hydration、切换、取消和迟到事件隔离下保持一致 | new/switch/fork/resume 后模式应用一致且不跨 Session 污染；hidden 临时状态收束为完成记录 |
| `M4` | 全量质量与发布边界回归 | 完成全量测试、构建、安装、文档和终端验证并重新请求最终验收 | npm test/check/build/package install/source+dist smoke/docs 通过；Luna 默认模型、工具动态收束和扩展能力状态不回退 |

ID 在本 Cycle 内保持稳定。
