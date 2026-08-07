---
kind: plan
cycle: C01-tui-v1
status: closed
updated: 2026-07-23
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi TUI v1 主线

## 执行目的

交付 VSPi 终端界面的 v1 主线体验：真实启动状态与最终帧时序、Slash 命令后缀高亮、浅色用户消息块、稳定 Context 中间轨道，以及 Revision 5 Mock、文档与发布复审。

## 执行边界

本 Cycle 聚焦 TUI 渲染与交互表面，不包含 Provider/Policy/Workflow 语义改动。最终验收以独立 test/implement/audit 证据分离为准，无 High/Medium finding 后才进入一次 Cycle acceptance。

## 验证目标

启动、命令高亮、用户消息、状态轨道与全部既有功能在 40/80/120 列、ASCII/256/truecolor、80×24 PTY 与真实 Pi 下保持稳定，无重叠、残影或信息截断。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 真实启动状态与最终帧时序 | 引入 typed StartupStatus 并重排启动编排：品牌动画与 backend 初始化并行，最终 splash 使用已解析 model/mode/version 后写入 scrollback，再启动动态 TUI | Animated 与 reduced-motion 都保证 final splash 在初始化后、TUI.start 前提交；失败路径 clean shutdown |
| `M2` | Slash 后缀高亮、浅色用户消息与 Context 中间轨道 | 修正命令匹配视觉范围，重做用户消息浅色圆角块，将 Context 放入新的稳定中间轨道而不移动 Token/费用 | 命令强调范围、40/80/120 消息块与 Context/Token/费用列位断言；Revision 4 的 151 项基线与新增测试通过 |
| `M3` | Revision 5 Mock、文档与发布复审 | 更新 README 与 TUI Mock，完成真实启动、用户消息、命令高亮、状态轨道的独立发布审计 | 全量 check/test/build/smoke/source+dist、80×24 PTY、npm pack 临时安装与 clean shutdown 通过；test/implement/audit 证据分离 |

ID 在本 Cycle 内保持稳定。
