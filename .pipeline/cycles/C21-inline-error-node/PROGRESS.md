---
kind: progress
cycle: C21-inline-error-node
plan: PLAN.md
status: completed
updated: 2026-08-20T21:09:09+08:00
current: none
next: none
---

# 瀑布流可展开错误节点进度

实现与验证已完成。Provider/model 错误以单行 `× 请求失败 · model` 进入瀑布流；Inspect 中使用 `Enter`/`→`/`←` 展开或收起格式化详情，`Ctrl+O` 可直达最近错误。live 与 resume 均保留该节点，本地操作错误继续使用 Status notice。
