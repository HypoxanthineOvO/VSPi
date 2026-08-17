---
kind: discussion-summary
cycle: C16-render-performance-repair
updated: 2026-08-17T16:36:00+08:00
---

# 渲染性能修复讨论摘要

## 已确认反馈

- 用户接受 C15 审计结论，决定开 C16：P1 修复三路全试，目标「优化到 Codex 的 Level」。
- 用户判断：滚动原生交给终端是 P1-3 的主要问题与主要解法（fullscreen=alt-screen 禁用了终端原生 scrollback，滚动全部变成应用→终端的整屏换位帧流）。
- 用户真实体验 regular（非 FullScreen）后确认“丝滑又流畅”，决定将其固定为默认 `tuiMode`；fullscreen 保留为可选模式。
- 用户反馈 renderer 切换后 Markdown 呈现要求丢失，举例为无序列表；已确认是 upstream assistant 路径绕过 VSPi rendered-lines 后处理并完成修复。

## 未确认假设

- 无。

## Discussion Ledger

### 2026-08-17 - 用户决定开 C16

> 开 C16 吧！都试下一下？有办法优化到 Codex 的 Level 吗？你说的那个 1-3 三选一是什么？

### 2026-08-17 - 用户确认滚动方向

> 我感觉那个滚动原生是一个交给终端的，这个应该是主要问题吧？

### 2026-08-17 - 默认模式决定：先体验

> 用户选择先用 /tui 手动切换体验两种模式，暂不改默认 tuiMode；体感结论出来后再定默认。

### 2026-08-17 - S1 验收与 Markdown 回归反馈

> 刚才 VSPi 改成那个非 FullScreen 之后就变得丝滑又流畅了！那就固定下来默认这个了
>
> 然后问题是现在的那个 Markdown 渲染要求 似乎因为改渲染器没了！比如无级列表什么的，你把这个修复一下
