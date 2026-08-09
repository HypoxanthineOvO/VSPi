---
kind: plan
cycle: C09-ui-rendering-fixes
status: closed
updated: 2026-08-09
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi 终端渲染与历史浏览修复

## 执行目的

修复用户报告的三个终端渲染/历史浏览问题：Question 确认界面空行过少、Resume 会话选择器顶部偏移、历史滚动页面混乱。

## 执行边界

本 Cycle 只处理用户报告的三个 UI 问题，不扩展其他功能。Mock-first 验证：每个修复在 80×40 terminal/light Mock 与真实 PTY 场景下确认几何与行为。

## 验证目标

- Question 最终检查（review）界面在内容与确认文字之间保留一行空白，与选项模式一致。
- Sessions 会话选择器垂直居中，标题不再贴屏幕第 0 行。
- 历史浏览（PageUp/Inspect）连续翻页、窗口内容完整，不跳过头、不产生历史空洞。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | Question 确认界面空行修复 | review 模式在内容与 footer 确认文字之间保留一行空白，不再挤在两行 | Mock 帧断言：review 内容末行与 footer 之间有空行 |
| `M2` | Resume 会话选择器对齐修复 | Sessions picker 垂直居中，标题离开第 0 行，顶部至少留 2 行 | Mock 帧断言：title 行位置 > 0；相关单元测试更新 |
| `M3` | 历史滚动与 Inspect 浏览修复 | PageUp 连续翻页不跳过头，窗口内容完整；Inspect 帧在真实终端完整渲染 | Mock/PTY 帧断言：连续 PageUp 依次显示各轮响应；渲染层遗留问题单独跟进 |

ID 在本 Cycle 内保持稳定。
