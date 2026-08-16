---
kind: progress
cycle: C14-streaming-render-regression
plan: PLAN.md
status: closed
updated: 2026-08-16T22:50:00+08:00
current: complete
next: v1.0.0 dual-platform release
---

# Streaming 渲染回归进度

## 当前状态

C14 已关闭。用户确认当前渲染“基本回到可用线，先这样吧”，接受本轮结果进入 v1.0.0；该结论不表示 VSCode Remote SSH Terminal 的滚动体验已达到理想状态。

## 计划状态

| ID | 阶段 | 状态 | 结果 |
| --- | --- | --- | --- |
| `M1` | Streaming cadence 复现与归因 | `completed` | 真实 VSCode trace 确认高频整屏位移会形成 terminal renderer backlog |
| `M2` | 最小修复 | `completed` | 通用 30 FPS、滚轮 3 行、100ms viewport 合并、native shift 与 fullscreen semantic cache |
| `M3` | 集成与安装门禁 | `completed` | v1.0.0 package 构建与内容校验通过 |
| `S1` | 本机 streaming 验收 | `completed` | 用户接受当前版本达到基本可用线 |

## 阻塞

- 无；v1.0.0 发布流程已恢复。
