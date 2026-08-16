---
kind: discussion-summary
cycle: C14-streaming-render-regression
updated: 2026-08-16T19:16:00+08:00
---

# Streaming 渲染回归讨论摘要

## 已确认反馈

- 用户在 C13 最终候选中感觉渲染卡顿，回复缺少连续流式呈现。
- 真实会话开始 streaming 后出现高 CPU/风扇；用户要求尽量全盘复用 Pi 官方 Render 方案，减少 VSPi 自建 render pipeline。
- 用户明确指出现场单次刷新可达几十秒，现有毫秒级 synthetic benchmark 不足以证明核心问题已定位；必须用真实会话规模重放或 live profile 补齐证据。
- 用户要求通过 direct `vspi -> 输入文字 -> 等待` 的真实 OpenCode Go DeepSeek V4 Flash PTY 验证；C14 修复验收后立即进入 v1.0.0 发布流程。
- S1 拒绝后用户补充：fullscreen 向上滚动最卡，向下稍好但仍不流畅；优先审计 ScrollView 离开 follow-end 后的历史 layout/paint 与 window rebasing。
- 用户进一步隔离：VSCode Remote SSH 的集成 Terminal 特别卡，同一远端改用 Windows Terminal SSH 较流畅；C14 主路径转为 terminal frontend compatibility/output cost。
- 用户明确限定真实症状为大于 5 秒的可见延迟与本机风扇明显加速；远端 Node/xterm-headless 的毫秒级数据不足以证明复现或根因，必须取得 VSCode/Electron renderer backlog 证据。
- 用户拒绝只对VSCode生效的特判，要求通用限制TUI整体刷新率；同时确认重点场景是滚动与streaming字符输出并发导致高频大frame。
- 第三轮候选去同步flush后DSR max从3.82s降到0.80s，但用户确认纯滚动仍会出现>5s可见卡顿，并指出Pi默认每个wheel event只滚1行不合理；剩余主因是每次1行逻辑位移仍重写40-60行viewport。
- 多轮native scroll候选逐步处理scrollbar ANSI、large coalesced shift与任意子window；最坏DSR从1.85s降至0.62s且不再彻底卡死，但用户仍明确拒绝半秒级高位反向滚动卡顿，要求达到Codex类TUI流畅度。
- 最终trace与Pi源码确认纯scroll仍每帧调用fullscreen child `render()`，VSPi重复执行整段history的window selection/transcript/dock构建；决定增加应用层semantic revision cache，使scroll只做layout viewport crop。

## 未确认假设

- 跨帧整页 cache 删除增加了每次 frame 的计算量。
- Provider 或 Pi backend 合并 chunk，导致 message update 本身稀疏。
- TUI requestRender 节流或 terminal differential write cadence 异常。

## Discussion Ledger

### 2026-08-16 - 用户反馈

> 我怎么感觉现在渲染卡的 1b 啊，完全没有流式渲染的感觉，不会是改炸了吧

### 2026-08-16 - 官方 Render 方向

> 我的建议是我们全盘用官方的 Render 方案？我感觉我们手搓的总是会带来一些麻烦~可以尽量复用就是
