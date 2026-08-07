---
kind: progress
cycle: C02-v0-1-0-usability
plan: PLAN.md
status: closed
updated: 2026-07-24T09:41:23+08:00
current: M9
next: none
---

# VSPi v0.1.0 本地日用版本进度

## 当前状态

Cycle 已完成并被接受（delivery `vspi-v0-1-0-usability` 状态 accepted，revision 2，拓扑 strict 三角色分离）。v0.1.0 本地检查点已创建（git commit c0f5829），不发布远端 Release。

## 完整计划状态

| ID | 阶段 | 状态 | 当前结果 / 证据 | 下一步 |
| --- | --- | --- | --- | --- |
| `M1` | 统一动作系统与诚实 TUI 外壳 | `completed` | Action Registry 单一来源；生产命令目录与 canonical/alias 关系明确；Splash/Status 展示真实 Backend 与 Policy | 无 |
| `M2` | 真实 Pi Runtime、历史与 Session 生命周期 | `completed` | 真实 Pi Session 真相；Fixture 仅显式启用；Ctrl+C 取消与草稿恢复通过 | 无 |
| `M3` | Provider、Model、Effort 与配置真相源 | `completed` | ProviderCatalog/ConfigService 合并三层来源；模型切换原子回滚；四协议 contract fixtures 通过 | 无 |
| `M4` | 执行 Policy、OS Sandbox 与 Recovery（Stone `S-policy-contract`） | `completed` | 用户接受四级 Policy 安全契约；项目只降不升；`--recovery` 以 Standard 启动 | 无 |
| `M5` | Question、附件与 Transcript/Markdown 完整交互 | `completed` | 四题型 Question、附件生命周期、非 Vision 拒绝附件、Markdown 宽度安全通过 | 无 |
| `M6` | Local Plan 后端、工具与完整工作区 | `completed` | LocalPlanBackend 契约测试；Session 绑定与 typed tools 落地 | 无 |
| `M7` | 模型 Prompt Profile 与官方 Harness 资料库 | `completed` | Factory 家族、覆盖优先级、effective prompt 来源标注与脱敏通过 | 无 |
| `M8` | Plan 上下文、提醒与手动压缩连续性 | `completed` | 四 profile 压缩、capsule 注入与复核触发通过 | 无 |
| `M9` | 集成迁移、独立审计与 v0.1.0 检查点 | `completed` | 端到端 PTY 矩阵通过；独立审计无 High/Medium；v0.1.0 commit/tag 创建（不发布 Release） | 无 |

## 阻塞

- 无；Cycle 已接受并关闭。

## 计划变化

- M4 Policy 安全契约通过 Stone 审阅后才继续其余功能；`vspi --recovery` 不叫 `--safe`，与 Policy 体系分离。

## 下一步

无。后续版本迭代由新 Cycle 承接。
