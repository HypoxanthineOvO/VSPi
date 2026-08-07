---
kind: plan
cycle: C06-terminal-mock-recovery
status: closed
updated: 2026-08-01
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi 终端 Mock 与 Recovery 工具链

## 执行目的

以 Mock-first 方式交付终端布局与恢复工具链：紧凑 Question 选项与固定 Footer 间隔（Stone），随后完成生产集成、全量回归与本地分发。

## 执行边界

Mock 阶段不构建或改动 dist；生产集成阶段使用 Stone 已确认的共享实现完成生产构建。全程使用 Frame ID + 行号坐标断言，避免生产代码出现第二套布局算法。

## 验证目标

80×40 child、4 列行号壳、Frame controls、plain/ANSI trace 与几何断言持续工作；选项连续无装饰、最后可见选项与 Footer 之间恰有一行空白且滚动不消失；全量回归与真实 PTY 通过。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 紧凑 Question 选项与固定 Footer 间隔 Mock（Stone `stone-terminal-mock-review`） | 保持紧凑连续选项、输入区、Terminal/Light、Resume、通知、短终端标题与性能回归通过，并在选项区域与 footer 之间固定加入一行不随滚动消失的空白 | Stone 审阅：选项彼此连续无装饰、最后可见选项与快捷键 footer 之间恰有一行空白；Frame ID + 行号反馈 |
| `M2` | 生产集成、全量回归与本地分发 | 将 Stone 已确认的共享实现完成生产构建，覆盖真实 PTY、Session/Goal/Question/notice 回归并刷新本地 vspi，等待最终人工验收 | Mock trace 作为前置门禁；TypeScript/Biome/目标测试/全量 Vitest/真实 PTY/build/package install/npm audit 通过；本地 wrapper 指向新 dist |

ID 在本 Cycle 内保持稳定。
