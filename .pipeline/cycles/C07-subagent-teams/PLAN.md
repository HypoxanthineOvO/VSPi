---
kind: plan
cycle: C07-subagent-teams
status: active
updated: 2026-07-30
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi Subagent 与项目 Teammate 完整计划

## 执行目的

实现 VSPi 的 Task Agent 与项目 Teammate 完整能力：Agent 合同与派生树调度器、独立 Task Agent runtime、项目 Teammate 与模型生命周期、主 Agent 协调与终端状态界面、安全加固与文档。这是当前进行中的 Cycle，尚无交付验收。

## 执行边界

本 Cycle 覆盖 Subagent/Teammate 的完整计划（m1-m5）；已有 Goal 交付验证（C05）作为基础。不发布版本，m5 通过全量质量门禁即可。

## 验证目标

默认限制为深度 5、累计 128、全局并发 16；上下文隔离、模型策略、路由强度、权限边界、fail closed 行为与 40/80/120 状态界面全部可验证。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `m1` | 定义 Agent 合同与派生树调度器 | 形成可验证的 Task Agent/Teammate 类型、profile 与设置 schema、上下文传递规则、模型策略和中央树调度器（深度 5、累计 128、全局并发 16） | Schema 测试覆盖 profile/模型池/路由/权限/非法组合；调度测试覆盖 tree_id/深度/队列/取消 |
| `m2` | 接入独立 Task Agent runtime（Stone `task-agent-runtime-review`） | 使用 Pi SDK 构建内存子 Session：最小上下文、显式继承、两种提示词模式、模型/Effort、嵌套派生、并行、流式、usage、级联取消 | Stone 审阅真实演示与测试证据：默认上下文隔离、自定义 prompt/model/Effort、跨模型探索、状态流和取消行为 |
| `m3` | 实现项目 Teammate 与模型生命周期 | 项目角色注册、持久 lane Session、显式管理授权、required/preferred/consult/manual 路由、模型切换和黏着式额度 fallback | 角色管理授权测试；恢复测试覆盖独立上下文/Session lease/陈旧状态；额度错误触发 fallback |
| `m4` | 接入主 Agent 协调与终端状态界面（Stone `teammate-ui-review`） | 主 Agent 精简能力/团队状态与用户约束；transcript 与 /agents 面板展示 Task Agent、Teammate、模型、Effort、lane、上下文、任务和 fallback | Stone 审阅真实 /agents 与 transcript 交互；40/80/120 状态和详情视图稳定 |
| `m5` | 完成安全加固、回归验证与文档 | 输入/路径/权限/并发/恢复安全审计，更新用户配置和使用文档，通过全量质量门禁而不发布版本 | npm run check/目标 Vitest/全量 npm test/build/smoke 通过；安全测试覆盖信任/逃逸/权限升级/预算绕过/越权/脱敏 |

ID 在本 Cycle 内保持稳定。
