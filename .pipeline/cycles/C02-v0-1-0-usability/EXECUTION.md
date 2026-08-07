---
kind: execution-log
cycle: C02-v0-1-0-usability
updated: 2026-07-24T09:41:23+08:00
---

# VSPi v0.1.0 本地日用版本执行记录

## 2026-07-24 - M1-M3 完成（外壳、Runtime、配置真相源）

- **计划项：** `M1` → `M3`
- **目的：** 建立统一动作系统、真实 Pi Session 生命周期与 Provider/Model/Effort 配置真相源。
- **结果：** Action Registry 单一来源；真实 Pi 启动/恢复/取消链路；ProviderCatalog/ConfigService 三层合并与原子切换落地。
- **证据：** `evidence/m1-{test,implement,audit}.txt`、`m2-{test,implement,audit}.txt`、`m3-{test,implement,audit}.txt`。
- **遇到的问题：** 早期后端 Mode Auto 文案与静默 Fixture fallback 被清除，改为 Backend Pi/Fixture 显式标识。
- **下一步：** M4 Stone。

## 2026-07-24 - M4 Stone 审阅与接受

- **计划项：** `M4`（Stone `S-policy-contract`）
- **目的：** 用户审阅四级 Policy 的标签、允许/拒绝矩阵、YOLO 警告、项目只降不升与 `--recovery` 行为。
- **结果：** 用户接受安全契约；Standard 为默认，项目配置无法提升到 Auto/YOLO；`--recovery` 强制 Standard 启动；audit 证据不含 secret。
- **证据：** `evidence/m4-{test,implement,audit}.txt`。
- **计划影响：** 安全契约成为后续功能前提。
- **下一步：** M5-M8。

## 2026-07-24 - M5-M8 完成（交互、Plan、Profile、压缩连续性）

- **计划项：** `M5` → `M8`
- **目的：** 完成 Question/附件/Transcript 交互、Local Plan 工作区、Prompt Profile 与压缩连续性。
- **结果：** 四题型 Question、附件生命周期、LocalPlanBackend 契约、Factory 家族与四 profile 压缩全部通过。
- **证据：** `evidence/m5-{test,implement,audit}.txt` 至 `m8-{test,implement,audit}.txt`。
- **遇到的问题：** 非 Vision 模型发送前拒绝附件且保留草稿，避免图片内容泄漏。
- **下一步：** M9。

## 2026-07-24 - M9 独立审计与 v0.1.0 检查点

- **计划项：** `M9`
- **目的：** 清除 Fixture-as-feature，完成全链路验证与独立审计，用户接受后创建 v0.1.0 检查点。
- **结果：** 端到端 PTY 矩阵、npm check/test/build/smoke/pack 全部通过；独立 test/implement/audit 无 High/Medium；git commit c0f5829 与 annotated tag 创建，不发布远端 Release。
- **证据：** `evidence/m9-{test,implement,audit}.txt`、`evidence/c1-{test,implement,audit}.txt`（Cycle 验收证据）。
- **计划影响：** Cycle 关闭；v0.1.0 成为后续版本基线。
- **遇到的问题：** 无。
- **下一步：** v0.2.0 Workflow 集成 Cycle。
