---
kind: cycle-summary
cycle: C09-ui-rendering-fixes
status: active
started: 2026-08-06
finished: null
builds_on: []
successors: []
---

# VSPi 终端渲染与历史浏览修复总结

## 目的与边界

修复用户报告的三个终端渲染/历史浏览问题：Question 确认界面空行、Resume 会话选择器顶部偏移、历史滚动混乱。仅处理这三个问题，不扩展其他功能。

## 最终结果

- M1 completed：Question review 界面获得 footer 空行，与选项模式一致。
- M2 completed：Sessions picker 垂直居中，标题离开第 0 行。
- M3 部分完成：历史翻页 app 层已修复（连续翻页不跳过头）；真实终端渲染层 Inspect 帧仍不完整，遗留为下一步。

## 验证结果

- 110 个相关测试通过（含更新后的 Sessions 居中断言）。
- mock:terminal trace 回归 0 violations。
- Mock/PTY 帧确认 M1、M2 布局与 M3 app 层行为。

## 重要决定与经验

- Mock-first 对终端布局修复有效：先用 80×40 Mock 确认几何，再进生产代码。
- 不伪造完成：渲染层遗留问题如实记录原因与线索（ScrollbackTUI.commitStatic rebase 与 pi-tui 差分渲染交互）。

## 后续候选

- Inspect 渲染层遗留：深挖 `ScrollbackTUI.commitStatic` rebase 与 pi-tui 差分渲染的交互，或在后续 Cycle 单独处理。
