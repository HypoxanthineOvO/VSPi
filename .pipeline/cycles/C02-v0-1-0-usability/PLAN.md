---
kind: plan
cycle: C02-v0-1-0-usability
status: closed
updated: 2026-07-24
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi v0.1.0 本地日用版本

## 执行目的

在 TUI v1 主线之上交付 VSPi v0.1.0 本地日用版本：统一动作系统与诚实 TUI 外壳、真实 Pi Runtime/Session 生命周期、Provider/Model/Effort 配置真相源、执行 Policy 与 OS Sandbox、Question/附件/Transcript 完整交互、Local Plan 后端、Prompt Profile 与 v0.1.0 检查点。

## 执行边界

本 Cycle 是 v0.1.0 可用性基线，不发布远端 Release（只 commit/tag 本地检查点）。Policy 安全契约（M4）通过 Stone `S-policy-contract` 人工审阅后才继续后续功能。

## 验证目标

真实 Pi 端到端链路（启动、恢复、对话、Question、附件、Plan、Profile、compact、new/switch/fork/restart）全部通过，四级 Policy 与 `--recovery` 纳入矩阵，任何失败不丢草稿、配置或历史。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 统一动作系统与诚实 TUI 外壳 | 以单一 Action Registry 统一按键、命令、alias、completion 与 contextual hints；修复 Splash、空 transcript、两行 Status、Composer/Markdown 布局，展示真实 Backend 与 Policy | 每个动作只有一个定义源；Tab/Shift+Tab/Enter/方向键无抢占；80/40/120 列状态安全降级 |
| `M2` | 真实 Pi Runtime、历史与 Session 生命周期 | 正常启动、历史 hydration、流式消息、thinking/tool、取消、草稿恢复、新建/切换/Fork/退出重开全部使用真实 Pi Session 真相 | 启动成功使用真实 Model，无可用模型显示 setup/error 不回退 Fixture；Ctrl+C 取消并恢复草稿；source/dist 与 80×24 PTY 覆盖 |
| `M3` | Provider、Model、Effort 与配置真相源 | 建立 ProviderCatalog/ConfigService，合并 Pi 内置、全局 models.json 与受限项目 overlay | 项目 overlay、Trust gate、schema 校验、原子保存契约测试；模型切换成功同步、失败原子回滚；四协议 contract fixtures |
| `M4` | 执行 Policy、OS Sandbox 与 Recovery（Stone `S-policy-contract`） | 独立 ExecutionPolicyService：Safe/Standard/Auto/YOLO 四级、默认 Standard、项目只降不升、可审计 OS sandbox、`--recovery` 启动链路 | Stone 人工审阅：真实探针矩阵、YOLO 警告、项目只降不升、recovery 行为；接受后才继续其余功能 |
| `M5` | Question、附件与 Transcript/Markdown 完整交互 | Question 真实注册覆盖四种题型；剪贴板/bridge 附件生命周期；thinking/tool 折叠与中文 Markdown 视觉 | Question 状态机、附件 manifest/恢复/清理测试；非 Vision 模型发送前拒绝附件；40/80/120 无重叠残影 |
| `M6` | Local Plan 后端、工具与完整工作区 | 独立于 Hypo-Workflow 的 LocalPlanBackend：revision + 原子 HEAD + lock + semantic hash；多 Plan、Session 绑定、三层 work items | plan_list/read/create/update/bind 契约测试；Session 绑定用 Pi custom entry；复杂重构走 typed tools |
| `M7` | 模型 Prompt Profile 与官方 Harness 资料库 | PromptProfileService 与 Factory Registry，按模型注入可追踪 overlay；Factory/Fork/覆盖/规则/匹配/导入导出/effective prompt UI | Factory 家族覆盖主流厂商；覆盖优先级与重匹配测试；effective prompt 逐段标注来源并脱敏 |
| `M8` | Plan 上下文、提醒与手动压缩连续性 | before_agent_start 注入 Plan capsule；四轮/六事件与 resume/compaction/failure/completion 触发复核；手动 compact 四 profile | 绑定 Plan 默认 Execution Continuity；capsule 只在本轮 overlay；Ctrl+C abortCompaction 原子 |
| `M9` | 集成迁移、独立审计与 v0.1.0 检查点 | 清除 Fixture-as-feature，完成旧配置/Session 兼容、全链路错误恢复、文档与安装验证；用户接受后 commit/tag v0.1.0 | 端到端 PTY 链路、npm check/test/build/smoke/pack 通过；独立审计无 High/Medium；接受后才 commit/tag 且不发布 Release |

ID 在本 Cycle 内保持稳定。
