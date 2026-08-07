---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T13:08:33.545Z
dedupe_key: cycle.vspi-terminal-mock-recovery.feedback.ac4ac8b73e5bad27
id: feedback-02a51cd5ae8a278313abf9136d3e6ce6
kind: feedback
schema_version: '1'
scope:
  ref: vspi-terminal-mock-recovery
  type: cycle
semantic_hash: 02a51cd5ae8a278313abf9136d3e6ce62611edee77be8d5b8b1e7d56d7f8b54e
source_refs:
  - locator: revision
    ref: actor:user:workspace-user
    type: user_feedback
supersedes: []
updated_at: 2026-08-01T13:08:33.545Z
---
# Delivery feedback

Problem: 横向分隔线没有让每个选项形成独立实体，快捷键 footer 的位置也仍显得奇怪。
Reproduce: 打开 Question single、multi 或 ranking Mock。 观察选项只有相邻横线，没有各自完整的上左下右边界。 观察底部快捷键提示位置。
Expected: 每个选项拥有完整独立方框，框间留空，多行说明位于同一框内；输入区保持现状。footer 暂不猜测性移动，继续按 Frame 观察。
Actual: 选项仍表现为被横线分段的列表；footer 位置尚不自然。
Context: 保留 revision 3 已通过的无背景选中态、白底兼容、较大控件、Resume 间距、唯一 cursor、通知和性能回归。
