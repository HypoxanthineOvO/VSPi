---
kind: discussion-summary
cycle: C02-v0-1-0-usability
updated: 2026-07-24
raw_discussion: .pipeline/memory/records/cycle-381d64ffcd29/、delivery-381d64ffcd29/
---

# VSPi v0.1.0 本地日用版本讨论摘要

## 已确认需求

- v0.1.0 是本地日用版本：真实 Pi 后端，Fixture 只能显式启用，绝不静默回退。
- 启动失败（无模型/配置损坏）显示 setup/error，不假装可用。
- 执行 Policy 必须是真实边界而非提示文案；Sandboxed/Host 标识与 Backend 标识分离。
- 项目配置不得包含明文密钥，不能把用户提升到 Auto/YOLO。

## 已作决定

- 采用单一 Action Registry 统一所有交互动作来源。
- 建立独立 ExecutionPolicyService，`--recovery` 强制 Standard 且不叫 `--safe`。
- LocalPlanBackend 独立于 Hypo-Workflow，避免双权威。
- v0.1.0 只创建本地 commit/tag 检查点，不发布远端 Release。

## 接受与拒绝

- M4 Policy 安全契约经 Stone `S-policy-contract` 人工审阅后接受。
- 旧后端 Mode Auto 文案与静默 Fixture fallback 被拒绝并清除。
- Status layout 经历多轮修正（见 `delivery-381d64ffcd29` 的 Status layout regression/refinement 反馈），最终两行状态布局稳定。

## 纠正与分歧

- Policy 与 Backend 曾混为同一 Mode 标识，修订为两项独立元数据。

## 未决问题

- 自动压缩 profile 的统一配置留待 v0.2.0；v0.1.0 自动 threshold/overflow 保持 Pi Native。
