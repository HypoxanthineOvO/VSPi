---
kind: progress
cycle: C09-ui-rendering-fixes
plan: PLAN.md
status: active
updated: 2026-08-06T03:10:00+08:00
current: M3
next: 处理 Inspect 渲染层遗留问题（真实终端下 Inspect 帧只显示部分内容）
---

# VSPi 终端渲染与历史浏览修复进度

## 当前状态

M1、M2 已完成并通过 Mock 验证；M3 的 app 层（连续翻页）已修复，但真实终端渲染层仍有遗留问题（Inspect 帧内容不完整），作为本 Cycle 的下一步。

## 完整计划状态

| ID | 阶段 | 状态 | 当前结果 / 证据 | 下一步 |
| --- | --- | --- | --- | --- |
| `M1` | Question 确认界面空行修复 | `completed` | review 模式获得与选项模式一致的 footer gap；Mock 确认内容与 "Enter 提交" 之间有一行空白 | 无 |
| `M2` | Resume 会话选择器对齐修复 | `completed` | Sessions picker 垂直居中，标题从第 1 行移到第 16 行（80×40 Mock），顶部留白充足；单元测试更新并通过 | 无 |
| `M3` | 历史滚动与 Inspect 浏览修复 | `in_progress` | app 层：pageTranscript 改为基于窗口边界的连续翻页，PageUp 不再跳过头，Mock 确认连续显示各轮响应；真实终端渲染层 Inspect 帧仍只显示部分内容（与工作区未提交 scrollback 机制修改交互） | 深挖 ScrollbackTUI.commitStatic rebase 与 pi-tui 差分渲染交互 |

## 阻塞

- 无硬阻塞；M3 渲染层遗留问题已记录原因与线索。

## 计划变化

- 无。

## 下一步

处理 M3 渲染层遗留；或按用户决定将遗留转为后续 Cycle 候选。
