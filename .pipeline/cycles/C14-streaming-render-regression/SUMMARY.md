---
kind: summary
cycle: C14-streaming-render-regression
status: closed
accepted: true
updated: 2026-08-16T22:50:00+08:00
---

# C14 总结

C14 修复了 streaming 与历史滚动时的主要 terminal renderer backlog。最终版本采用通用 30 FPS frame pacing、focused keyboard 即时刷新、滚轮默认 3 行、100ms viewport 输入合并、保守的 native viewport shift，以及 fullscreen body/dock semantic cache。

用户确认当前版本“基本回到可用线，先这样吧”，接受进入 v1.0.0。验收保留一项边界：真实 VSCode Remote SSH Terminal 的高历史位置反向滚动仍可能不够理想，本轮不继续扩张为 Pi ScrollView 重构。

后续工作转为 v1.0.0 GitHub/GitLab 双平台发布。
