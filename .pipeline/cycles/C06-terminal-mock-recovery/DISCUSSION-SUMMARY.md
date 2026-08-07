---
kind: discussion-summary
cycle: C06-terminal-mock-recovery
updated: 2026-08-01
raw_discussion: .pipeline/memory/records/cycle-45bcc593a933/
---

# VSPi 终端 Mock 与 Recovery 工具链讨论摘要

## 已确认需求

- Question 选项普通短选项逐行连续排列，彼此之间没有空行、横线、导轨或内层方框。
- 最后一个可见选项与 Question 快捷键底栏之间恰有一整行空白，多选项、长说明、首末项滚动和短终端中不消失。
- Mock 使用 80×40 child、4 列行号壳、Frame controls、plain/ANSI trace 与几何断言。

## 已作决定

- Mock-first：先在 terminal/light 80×40 环境中确认几何，再进入生产构建。
- 选项布局经历多轮决策修订：带标尺终端 Mock 与瀑布恢复纠错（decision-164d0064）、彩色终端 Mock 与 Question 独占交互面（decision-582c1510）、无间隔紧凑选项（decision-a9f8f997）、独立方框选项与语义滚动（decision-d3cdb7ff）、横向分隔 Question（decision-3ce0c2c3）、紧凑选项与固定 Footer 间隔（decision-4edd7696）。
- 通知降噪（decision-5544eee7）同步处理。

## 接受与拒绝

- 用户通过 Stone `stone-terminal-mock-review` 接受最终布局（连续选项 + 固定一行间隔）。
- 中间多轮布局（方框、横向分隔等）被迭代或拒绝，最终收敛为紧凑连续样式。

## 纠正与分歧

- 选项之间的空行与装饰在早期版本存在，经几何断言逐步清除。

## 未决问题

- 无结构性未决问题。
