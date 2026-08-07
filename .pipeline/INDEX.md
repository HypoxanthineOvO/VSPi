---
kind: project-index
name: VSPi
status: active
---

# VSPi 项目索引

## 当前工作

- [Cycle 索引](cycles/INDEX.md)：3 个 active Cycle（C07-subagent-teams、C08-persistent-goal-runner、C09-ui-rendering-fixes），6 个历史 Cycle closed。
- [Experiment 索引](experiments/INDEX.md)：无高置信 Experiment 记录。
- [Memory 记录](memory/records/)：126 条 decision/feedback/requirement 等，按 scope 分组。
- Legacy 保留：`.pipeline/manifest.yaml` 与 `.pipeline/runtime/objects/delivery/`（8 个 Delivery 对象）继续作为旧兼容入口，未被改写。

## 历史来源与权威

- 8 个 Delivery 对象是历史 Cycle/Goal 的权威（决策 `decision-742e1882`：Release history authority and reconstruction policy）。
- Git release 锚点：v0.1.0 = commit c0f5829（无 tag），v0.2.0 ~ v0.3.11 = main 上剥皮后的 tag commit。
- 没有匹配 Delivery 的 Release 记录为直接迭代（由 Git 与主 Session 支持）。

## 读取顺序

普通恢复先读本索引、当前 active Cycle 的 Plan/Progress/Execution/Discussion Summary。追溯历史进入 `cycles/` 目录；处理旧 live Delivery 进入 `.pipeline/runtime/objects/delivery/`。
