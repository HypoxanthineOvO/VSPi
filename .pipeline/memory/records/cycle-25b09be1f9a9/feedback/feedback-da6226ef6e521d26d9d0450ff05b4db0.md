---
authority_role: record
confidence: confirmed
created_at: 2026-07-23T07:00:56.021Z
dedupe_key: cycle.vspi-tui-v1.feedback.4f0a53dac508ca81
id: feedback-da6226ef6e521d26d9d0450ff05b4db0
kind: feedback
schema_version: '1'
scope:
  ref: vspi-tui-v1
  type: cycle
semantic_hash: da6226ef6e521d26d9d0450ff05b4db006453cc0bb47e168a48f1ec300bc01e4
source_refs:
  - locator: reject
    ref: actor:user:operator
    type: user_feedback
supersedes: []
updated_at: 2026-07-23T07:00:56.021Z
---
# Delivery feedback

Problem: Revision 4 的命令匹配把 slash 触发符纳入高亮，用户消息块过暗且缺少圆角边界，Context 锚点偏右，并且真实启动帧展示了固定的虚构入口和 Provider 文案而非运行时真实状态。
Reproduce: 启动 VSPi，观察最终 splash 中的 Home · auto/safe · Web 与 Kimi / OpenAI / DeepSeek。 在 composer 输入 / 或 /ex，观察 slash 被当成匹配字符并参与强调。 发送一条用户消息，观察整行深色背景且没有上下圆角边界。 在 80 列状态区观察 Context 位于偏右的 telemetry 组。
Expected: Slash 只触发命令模式且不高亮；仅 slash 后实际匹配字符高亮。用户消息使用更浅、更鲜明的背景与上下圆角边界。Context 固定在更靠左的中间锚点。最终 splash 只显示已解析的真实模型、真实运行模式与版本；Safe 仅在真实 Safe 状态存在时显示。
Actual: Slash 当前包含在匹配强调中；用户消息使用 #20262A 深色整行背景且无边界；Context 跟随右侧 telemetry 组；splash 在 backend 启动前提交，并硬编码 Home/auto-safe/Web 及 Provider 列表。
Context: Revision 4 final manual acceptance。用户确认固定宣传行属于真实渲染而非纯 Mock 后拒绝当前结果，并要求 Revision 5 保持 splash scrollback 特性但改为运行时真实状态。
