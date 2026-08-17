---
kind: execution
cycle: C15-render-algorithm-performance-audit
updated: 2026-08-16T23:10:00+08:00
---

# Execution Checkpoints

## 2026-08-16 - C15 建立与 M1 启动

- **计划项：** `M1`
- **目的：** 用户要求新建 Workflow Cycle，对 VSPi 渲染算法的性能问题进行系统审计。
- **范围：** 审计 C14 交付后的现行渲染链路（frame pacer、terminal-frame-optimizer shift 检测、semantic/transcript cache、组件构建成本），产出带量化证据的问题分级报告，默认不在本 Cycle 内做架构级修复。
- **基线来源：** C14 的无正文 trace 方法（write/bytes/rewritten rows/DSR）、direct PTY 与 xterm-headless 双路径，以及“毫秒级 synthetic benchmark 不构成真实复现”的证据边界。
- **已知输入：** C14 接受时保留的遗留边界——真实 VSCode Remote SSH Terminal 高历史位置反向滚动仍不理想，列为 M3 必测场景。
- **下一步：** M1 定义 KPI 与场景矩阵，并把 C14 期间的 trace 手段固化为可重复运行的工具或脚本。

## 2026-08-16 - M1 基线口径与工具盘点

- **计划项：** `M1`
- **产出：** `BASELINE.md`：审计对象分层（pacer / shift 检测 / semantic + transcript cache / 组件构建 / 上游 Pi）、5 类 KPI、6 个场景矩阵（C 高历史位置反向滚动为最高优先级）、三层测量环境。
- **工具盘点结论：** 仓库内仅有功能性回归测试（tui-frame-pacer / terminal-frame-optimizer / fullscreen-tui），C14 的 perf、无正文 write/DSR trace、xterm-headless replay 均为会话内临时手段，未固化。
- **缺口：** M1 剩余工作为把无正文 trace 固化为 `scripts/` 可重复工具，方可支撑 M2 micro-profile 与 M3 场景矩阵取证。
- **下一步：** 实现无正文 trace 工具并实测 A/B 两场景验证可用性。

## 2026-08-17 - M1 工具固化与首轮实测

- **计划项：** `M1`
- **产出：** `scripts/render-trace.mjs`：node-pty + xterm-headless 6.0.0，逐 write 记录 bytes/rowUpdates/viewport diff/帧分类/500ms CPU 采样；场景脚本 JSON 驱动（输入/resizes）。
- **校准发现：** VSPi 默认剥离 ?2026（`adaptInteractiveTerminalOutput`，C14 去同步 flush 决策），帧分割不能依赖 2026；改用 pty write 粒度 + 帧型正则分类。
- **验证：** fixture 短流（25 帧/12.8KB）、大历史+滚动（955 帧/363KB/31帧每秒上限）、regular 对照、resize、真实模型 75s（1013 帧/316KB）。
- **结论：** M1 完成，工具可重复支撑 M3 取证。

## 2026-08-17 - M2 代码路径与 M2b 竞品取证

- **计划项：** `M2`/`M2b`
- **M2 关键事实：** pi-tui 行级 diff（CUP+EL+整行，tui-alt-screen.js:1109-1136）+ 16ms 自身下限；VSPi 33ms pacer 叠加；optimizer 依赖帧内 BEGIN_SYNC 存在；键盘 input 每 keystroke bump `fullscreenRenderRevision`；鼠标被 handleViewportInput consume 不破坏 semantic cache。
- **M2b 取证方式：** OpenCode v1.14.30 GitHub tag 源码 + OpenTUI main 源码（Zig cell 级 diff、targetFps=30、Ghostty VT parser、no-op 抑制）；Codex main 源码（FrameScheduler 合并 + 120fps 上限、commit 队列每帧一行 drain、inline viewport）+ 本机实测（309 帧、每帧包 2026、无 alt-screen）；Claude Code 2.1.233 二进制 strings（Ink 架构佐证，节流参数未确认）。

## 2026-08-17 - M3 场景矩阵与 M4 报告

- **计划项：** `M3`/`M4`
- **核心数据：** fullscreen 滚动峰值 57.3KB/s、31帧/s、~650 行/s 重写；regular 同场景 9.3KB/s 峰、滚动期≈零内容输出；真实模型 CPU 26.5%/87.9%、帧间隔 p95 225ms；全量 write 中 60% 为 <40B 空帧（最高 22 次/秒）。
- **报告：** `AUDIT.md`：问题分级 P1×3（空帧未抑制、streaming 单帧停顿、fullscreen 滚动结构性成本）+ P2×2 + P3×1，含修复去向建议（C16）与证据缺口（真实 VSCode DSR 需用户采样）。
- **下一步：** S1 用户审阅。
