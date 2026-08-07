---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T12:52:18.510Z
dedupe_key: cycle.vspi-terminal-mock-recovery.feedback.9c23f7d6a2b8dedc
id: feedback-cedd874f1aeec7a7b35562fcbd67ca5b
kind: feedback
schema_version: '1'
scope:
  ref: vspi-terminal-mock-recovery
  type: cycle
semantic_hash: cedd874f1aeec7a7b35562fcbd67ca5b422da06b7b60012be1edf418667bd2dd
source_refs:
  - locator: revision
    ref: actor:user:workspace-user
    type: user_feedback
supersedes: []
updated_at: 2026-08-01T12:52:18.510Z
---
# Delivery feedback

Problem: Question 的竖向导轨与整行白色反色过于突兀，输入导轨难看；白底终端不可用，多选控件过小，Resume 会话列表仍然拥挤。
Reproduce: 在 80×40 Mock 打开单选、多选与直接回答 Question。 观察选项左侧导轨、整行白色选中背景、输入导轨与多选勾选状态。 在白色背景或 Light 主题下检查可读性。 打开 Resume 并浏览多个会话。
Expected: 选项以横线分隔成实体，选择态无白块且控件清楚；输入区无导轨；默认 Terminal 在白底可用；Resume 会话间有稳定空行且选中项可见。
Actual: 选项和输入区依赖竖向导轨，选中态出现突兀白色反色，多选框难辨，白底不可用，Resume 连续单行显得拥挤。
Context: 保留 Question 独占 Composer、唯一 cursor、固定 Status 通知、增量发送和原子 Resume hydration；Stone 未接受，不进入构建分发。
