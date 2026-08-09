---
kind: execution-log
cycle: C08-persistent-goal-runner
updated: 2026-08-09T12:24:00+08:00
---

# VSPi 持久 Goal Runner 执行记录

## 2026-08-01 - Proposal revision 4 就绪，状态 needs_revision

- **计划项：** `G3`
- **目的：** 持久 Goal Runner proposal 收敛至 revision 4（proposal_ready）。
- **结果：** delivery `vspi-persistent-goal-runner` revision 4，revision_state proposal_ready，status needs_revision；等待修订反馈。
- **证据：** `.pipeline/runtime/objects/delivery/vspi-persistent-goal-runner/runtime.yaml`；用户反馈 `feedback-57c0bec2`（`.pipeline/memory/records/goal-6ad4d973ba9e/`）。
- **计划影响：** Cycle active；按反馈修订后重新提交。
- **遇到的问题：** 持久 runner 与终端瀑布、Mock-first 恢复需要多次联合修订（decision-6e1c2b53、decision-ab205a44）。
- **下一步：** 处理修订反馈，达成 proposal_ready 后重新提交。

## 2026-08-09 - G1–G3 现状核验、Pi 0.84 回归修复并关闭 C08

- **计划项：** `G1`、`G2`、`G3` → Cycle close
- **反馈映射：** `feedback-57c0bec2` 要求 Terminal Inspector 在 child PTY 外提供稳定 Frame ID、四列行标、变化标记、坐标、pause/step 与可选列标尺；现有 `scripts/terminal-mock.ts` 已逐项实现并共享 trace frame buffer。
- **发现与修复：** fresh 80×40 trace 发现 Pi TUI 0.84 的 `resetRenderState()` 会令 Resume epoch 下一帧误判 width change，产生额外 clear/Home。`ScrollbackTUI` 改用公开 render-state API 建立零尺寸首帧，并新增 epoch 后首帧回归测试。
- **Goal Core 证据：** 持久化、唯一 owner、lost-owner pause、显式 resume、native followUp、pending acceptance、round/token/no-progress 边界、workspace 隔离与模型工具权限测试通过。
- **最终验证：** `npm run check`、`npm run build`、全量 110 files / 801 tests 通过；80×40 `mock:terminal --trace` 为 `violations: []`，`preResizeClearViewport: 0`、`resumeHome: 0`、`hydrationPartial: 0`。
- **兼容说明：** legacy Delivery revision 4 / `needs_revision` 是只读历史快照，未修改；当前语义 Cycle 记录 fresh 收口证据。
- **下一步：** 无；C08 closed。
