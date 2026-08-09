---
kind: discussion-summary
cycle: C09-ui-rendering-fixes
updated: 2026-08-09
raw_discussion: .pipeline/local/discussions/C09-ui-rendering-fixes/
---

# VSPi 终端渲染与历史浏览修复讨论摘要

## 已确认需求

- Question 最终检查界面：空行太少，确认文字与框体挤在两行，需要内容与确认文字之间留白。
- Resume 会话选择器：用户终端顶部多显示一行导致标题被遮挡，需要往下移（下对齐或中间对齐均可接受）。
- 历史滚动：往上滑时历史页面混乱，期望流畅的瀑布式连续浏览。

## 已作决定

- 三个问题以一个小 Cycle（C09）承载，Mock-first 验证。
- Sessions picker 采用垂直居中（剩余空间上下均分，顶部至少 2 行）。
- 历史翻页改为基于窗口边界的连续翻页，不跳过头。
- 渲染层遗留问题如实记录，不伪造完成。

## 接受与拒绝

- M1、M2 通过 Mock 帧验证并接受。
- M3 app 层与真实终端渲染层均通过；用户明确要求先完成 C09，验证后关闭。

## 纠正与分歧

- 无。

## 未决问题

- 无。原 Inspect 渲染遗留已由 C11 dual renderer 与 fresh PTY 证据闭环。
