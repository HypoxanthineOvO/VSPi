---
authority_role: record
confidence: confirmed
created_at: 2026-07-23T01:56:11.048Z
dedupe_key: cycle.vspi-tui-v1.feedback.ff40cfb6c4e06804
id: feedback-309edec7a60dd4c1b493b13fc7e46c81
kind: feedback
schema_version: '1'
scope:
  ref: vspi-tui-v1
  type: cycle
semantic_hash: 309edec7a60dd4c1b493b13fc7e46c810c2effe1f81c4638862030b1b266c0c5
source_refs:
  - locator: reject
    ref: actor:user:operator
    type: user_feedback
supersedes: []
updated_at: 2026-07-23T01:56:11.048Z
---
# Delivery feedback

Problem: 默认空会话混入演示 fixture；启动动画被差分界面覆盖；状态行缺少语义标签和颜色层级；品牌大小写不规范；模型详情布局与汇率参考行影响阅读；缺少面向 GitLab 部署的更新界面。
Reproduce: 在新工作区启动 VSPi，观察默认主界面与 Plan。 打开模型选择器。 检查状态行、模型详情和可用命令。
Expected: 默认会话为空；启动动画保留在上方 scrollback，主界面在其后；无计划时显示当前计划为空；路径、Context、模型等字段带名称和颜色区分；品牌名称首字母大写；模型详情位于右侧；删除国外汇交易中心参考价行；增加可审阅的 GitLab 更新入口。
Actual: 默认显示计划和演示数据；启动动画被覆盖；状态行文本同色且标签不清；部分品牌为小写；模型详情纵向堆在下方并显示汇率参考行；没有更新界面。
Context: 这是 TUI v1 的首次视觉验收；真实聊天与 session 已接入，但 fixture 不应冒充默认真实状态；后续计划通过 GitLab 分发更新。
