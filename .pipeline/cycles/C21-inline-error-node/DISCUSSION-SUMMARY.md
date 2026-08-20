---
kind: discussion-summary
cycle: C21-inline-error-node
updated: 2026-08-20T21:09:09+08:00
---

# Discussion Summary

用户认为大边框错误卡片仍过重，希望采用和 assistant `· xxxx` 相近的单行节点，只替换前导符号；打开后的观感与展开工具调用信息一致。用户随后批准按最小改动原则实施。

最终实现使用 `× 请求失败 · model` 单行折叠节点；选中时沿用 Inspect 的 `▌`，展开后在下方两格缩进显示详情。没有引入大卡片、背景块或 `pi-coding-agent` 私有组件。
