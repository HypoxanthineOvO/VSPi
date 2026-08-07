---
kind: discussion-summary
cycle: C09-ui-rendering-fixes
updated: 2026-08-06
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
- M3 app 层修复通过验证；渲染层遗留问题待处理。

## 纠正与分歧

- 无。

## 未决问题

- Inspect 帧在真实终端的渲染不完整（只显示部分内容），根因与工作区未提交的 scrollback 机制修改（ScrollbackTUI.commitStatic rebase）交互有关，待深挖或转后续候选。
