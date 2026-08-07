---
kind: cycle-summary
cycle: C02-v0-1-0-usability
status: closed
started: 2026-07-23
finished: 2026-07-24
builds_on:
  - C01-tui-v1
successors:
  - C03-v0-2-0-workflow-integration
---

# VSPi v0.1.0 本地日用版本总结

## 目的与边界

在 TUI v1 基础上交付 v0.1.0 本地日用版本：统一动作系统、真实 Pi Runtime、Provider/Model 真相源、四级执行 Policy、Question/附件交互、Local Plan、Prompt Profile 与压缩连续性。不发布远端 Release。

## 最终结果

- 统一动作系统与诚实 TUI 外壳（Action Registry 单一来源）。
- 真实 Pi Session 生命周期；Fixture 仅显式启用。
- Provider/Model/Effort 配置真相源（三层合并、原子切换、四协议 fixtures）。
- 四级 Policy + OS Sandbox + `--recovery`（Standard 强制）。
- Question 四题型、附件生命周期、Local Plan 工作区、Prompt Profile Factory 家族、四 profile 压缩。
- v0.1.0 commit/tag 检查点创建（c0f5829），不发布 Release。

## 验证结果

- 端到端 PTY 链路矩阵（启动/恢复/对话/Question/附件/Plan/Profile/compact/new/switch/fork/restart）通过。
- npm check/test/build/smoke/pack 临时安装通过；40/80/120 色彩矩阵通过。
- 独立 test/implement/audit 证据分离，最终审计无 High/Medium finding。

## 重要决定与经验

- Policy 是真实执行边界，不是 UI 提示；Sandboxed/Host 必须可审计。
- 项目配置只能降级不能提升执行等级；密钥拒绝写入项目层。
- v0.1.0 作为后续版本基线，自动压缩 profile 统一配置留待 v0.2.0。

## 后续候选

- v0.2.0 Workflow 集成（thinkingDisplay 三态显示与 Workflow 边界）由 C03 承接。
