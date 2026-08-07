---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T13:30:11.023Z
dedupe_key: cycle.vspi-terminal-mock-recovery.feedback.6a8df73c713438f1
id: feedback-0d2cda78eb4c67b25aef1238c0bbda86
kind: feedback
schema_version: '1'
scope:
  ref: vspi-terminal-mock-recovery
  type: cycle
semantic_hash: 0d2cda78eb4c67b25aef1238c0bbda868e6f251ea105e584dfdd2719830d3da4
source_refs:
  - locator: revision
    ref: actor:user:workspace-user
    type: user_feedback
supersedes: []
updated_at: 2026-08-01T13:30:11.023Z
---
# Delivery feedback

Problem: 独立方框与框间空行在终端中占用过多离散行，无法通过细粒度 padding 调整获得合适密度。
Reproduce: 打开 Question single、multi 或 ranking Mock。 观察每个选项至少三行且框间另有空行。
Expected: 选项无空行、无分隔线、无内层方框，只保留 ›、单选、多选与排序标记；说明只在必要时紧邻换行。
Actual: 独立方框增加区分度但高度和间距过重。
Context: 保留已认可输入区、无背景选择、白底兼容、Resume 间距、短终端标题、唯一 cursor、通知和性能回归。
