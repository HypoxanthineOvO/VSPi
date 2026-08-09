---
kind: cycle-summary
cycle: C08-persistent-goal-runner
status: closed
started: 2026-07-27
finished: 2026-08-09
builds_on:
  - C04-live-run-control
successors: []
---

# VSPi 持久 Goal Runner 总结

## 目的与边界

实现 VSPi 持久 Goal Runner 与终端瀑布、Mock-first 恢复修订；旧 Delivery 对象只读保留。

## 最终结果

- Goal 可跨进程持久恢复；失去 owner 后转 paused，只有显式 `/goal resume` 重新取得当前 Session owner，不自动重发模型请求。
- 普通 final 通过 Pi native `followUp` 续跑；pending acceptance、阻塞、取消及轮次/token/no-progress 边界停止自动续跑。
- Goal store 使用 workspace 隔离、CAS revision、semantic hash、immutable revision、atomic HEAD 与 writer lock，并拒绝 symlink/control text。
- Terminal Inspector 修订完成；Pi 0.84 regular renderer 的 Resume epoch 额外 clear/Home 回归已修复。

## 验证结果

- `npm run check` 与 `npm run build` 通过。
- 全量 Vitest：110 files / 801 tests passed。
- 80×40 Terminal Mock：child 尺寸精确、restored surface 1、partial hydration 0、pre-resize clear 0、Resume Home 0、violations 0。

## 重要决定与经验

- Goal 恢复只落盘状态、不自动重发请求；唯一 execution owner 通过显式 resume 获取。
- 持久能力与终端瀑布/Mock 恢复联合修订，避免两套恢复语义漂移。

## 后续候选

- 无。legacy runtime/delivery 保持 2026-08-01 的 revision 4 / `needs_revision` 历史状态，不再作为当前源码完成度判断。
