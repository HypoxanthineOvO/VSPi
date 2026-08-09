---
kind: project-index
name: VSPi
status: active
---

# VSPi 项目索引

## 当前工作

- [Cycle 索引](cycles/INDEX.md)：1 个 active Cycle（C12 Release Train R7），11 个历史 Cycle closed。
- [Experiment 索引](experiments/INDEX.md)：无高置信 Experiment 记录。
- [Memory 记录](memory/records/)：130 条合法 decision/feedback/requirement/preference Record，按 scope 分组；C07 corrective decision supersede 旧 revision 0 记录；v0.6.0 release outcome 与 Windows named-pipe lease 修复已记录。
- Legacy 保留：`.pipeline/manifest.yaml` 与 `.pipeline/runtime/objects/delivery/`（8 个 Delivery 对象）继续作为旧兼容入口；C05 Delivery 仅修正 evidence path，状态、revision 与 digest 未改变。

## 历史来源与权威

- 8 个 Delivery 对象是历史 Cycle/Goal 的权威（决策 `decision-742e1882`：Release history authority and reconstruction policy）。
- Git release 锚点：v0.1.0 = commit c0f5829（无 tag），v0.2.0 ~ v0.3.11 与 v0.6.0 = main 上剥皮后的 tag commit；v0.4/v0.5 仅为未独立发布的能力里程碑。
- 没有匹配 Delivery 的 Release 记录为直接迭代（由 Git 与主 Session 支持）。

## 读取顺序

普通恢复先读本索引、当前 active Cycle 的 Plan/Progress/Execution/Discussion Summary。追溯历史进入 `cycles/` 目录；处理旧 live Delivery 进入 `.pipeline/runtime/objects/delivery/`。
