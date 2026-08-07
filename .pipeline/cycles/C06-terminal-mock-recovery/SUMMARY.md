---
kind: cycle-summary
cycle: C06-terminal-mock-recovery
status: closed
started: 2026-07-30
finished: 2026-08-01
builds_on:
  - C03-v0-2-0-workflow-integration
successors: []
---

# VSPi 终端 Mock 与 Recovery 工具链总结

## 目的与边界

以 Mock-first 方式交付终端布局与恢复工具链：紧凑 Question 选项与固定 Footer 间隔，以及生产集成与本地分发。

## 最终结果

- 紧凑连续 Question 选项：普通短选项逐行连续、无装饰，最后可见选项与 Footer 之间恰有一整行空白且滚动不消失。
- Mock 工具链：80×40 child、4 列行号壳、Frame controls、plain/ANSI trace 与几何断言持续工作。
- 生产集成：共享实现完成生产构建，本地 vspi 已刷新；Mock trace 作为前置门禁，无第二套布局算法。

## 验证结果

- Stone `stone-terminal-mock-review` 用户审阅通过。
- TypeScript、Biome、目标测试、全量 Vitest、真实 PTY、build、package install 与 npm audit 通过。
- 证据包含 Frame/行坐标、full redraw 计数、字节预算、Resume trace 与文件 SHA-256。

## 重要决定与经验

- Mock-first + Frame ID/行号几何断言是终端布局质量的可靠保障。
- 生产代码必须复用 Mock 已确认的共享实现，避免两套布局算法漂移。

## 后续候选

- 无；后续终端能力由新 Cycle 承接。
