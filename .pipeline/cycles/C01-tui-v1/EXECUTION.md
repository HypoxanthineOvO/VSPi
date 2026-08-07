---
kind: execution-log
cycle: C01-tui-v1
updated: 2026-07-23T10:25:13+08:00
---

# VSPi TUI v1 主线执行记录

## 2026-07-23 - M1 真实启动状态与最终帧时序完成

- **计划项：** `M1`
- **目的：** 引入 typed StartupStatus 并重排启动编排，最终 splash 在 app/backend 初始化后、TUI.start 前提交。
- **结果：** Animated 与 reduced-motion 都保证 final splash 带结尾换行；model/mode 来自运行时，Safe 不存在时绝不出现；backend/attachment 初始化失败保持 clean shutdown。
- **证据：** `evidence/r5-m1-fix-test.txt`、`evidence/r5-m1-fix-implement.txt`、`evidence/r5-m1-reaudit.txt`（test/implement/audit 分离）。
- **遇到的问题：** 早期版本在 Auto fallback 下展示 Home · auto/safe · Web 残留，通过运行时真相源修正。
- **下一步：** M2。

## 2026-07-23 - M2 命令高亮、用户消息与 Context 轨道完成

- **计划项：** `M2`
- **目的：** 修正命令匹配视觉范围，重做用户消息浅色圆角块，Context 进入稳定中间轨道。
- **结果：** `/` 只打开目录且无匹配 SGR；`/ex` 仅 ex 强调；用户消息在 40/80/120、truecolor/256/ASCII、单行/多行/附件/Inspect 下呈现圆角浅色块；80 列 Context/Token/费用分别从可见列 24/52/70 开始，长路径不推动轨道；Revision 4 的 151 项基线通过。
- **证据：** `evidence/r5-m2-test.txt`、`evidence/r5-m2-fix-test.txt`、`evidence/r5-m2-implement.txt`、`evidence/r5-m2-fix-implement.txt`、`evidence/r5-m2-reaudit.txt`。
- **遇到的问题：** 命令匹配视觉范围曾覆盖前缀之外，通过强调范围修正解决。
- **下一步：** M3。

## 2026-07-23 - M3 Revision 5 发布复审与 Cycle 接受

- **计划项：** `M3`
- **目的：** 更新 README 与 TUI Mock，完成独立发布审计后进入一次 Cycle acceptance。
- **结果：** 全量 check/test/build/smoke/source+dist、40/80/120、ASCII/256/truecolor、80×24 PTY、真实 pi 与 clean shutdown 通过；附件/Bridge/Update/Markdown/错误恢复与 npm pack 临时安装不回归；最终无 High/Medium finding。
- **证据：** `evidence/r5-m3-test.txt`、`evidence/r5-m3-implement.txt`、`evidence/r5-m3-audit.txt`；worker_routing 评估为 critical（独立审计，blast_radius high、uncertainty low）。
- **计划影响：** Cycle 关闭。
- **遇到的问题：** 无。
- **下一步：** 关联 v0.1.0 release（git commit c0f5829）与后续可用性 Cycle。
