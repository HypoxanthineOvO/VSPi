---
kind: discussion-summary
cycle: C01-tui-v1
updated: 2026-07-23
raw_discussion: .pipeline/memory/records/cycle-25b09be1f9a9/
---

# VSPi TUI v1 主线讨论摘要

## 已确认需求

- 启动必须展示真实 Model/Mode/Version 的最终帧，不保留固定宣传行或虚拟 Provider 列表。
- Slash 命令匹配的视觉强调只覆盖匹配前缀（如 `/ex` 仅强调 ex），不能漂移到其他区域。
- 用户消息使用浅色圆角块，在 40/80/120 列与 ASCII/256/truecolor 下宽度精确。
- Context 进入独立稳定中间轨道，不推动 Token/费用；长路径只截断自身。

## 已作决定

- 采用 typed StartupStatus 与并行启动编排，最终 splash 在 TUI.start 前写入 scrollback。
- Context/Token/费用右轨固定列位（80 列 24/52/70；120 列 Context 从 34 开始），路径 flex 区不越界。
- Revision 5 以独立 test/implement/audit 证据分离为验收门禁。

## 接受与拒绝

- 经过多轮 revision（r1-r5），用户接受最终启动时序、命令高亮、用户消息视觉与 Context 轨道设计。
- M1 早期版本在 Auto fallback 下出现虚假后端文案，被拒并要求真实运行时真相源。

## 纠正与分歧

- 命令匹配视觉范围曾覆盖完整命令 token 之外，修订为仅强调匹配前缀。

## 未决问题

- 无结构性未决问题；关联的 v0.1.0 release 在 v0.1.0 可用性 Cycle 中继续收尾。
