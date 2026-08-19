---
kind: cycle-summary
cycle: C19-vspi-subagent-runtime-audit
status: closed
version: v1.1.2
closed: 2026-08-19T14:20:00+08:00
---

# C19 VSPi Subagent Runtime 审计与命令幻觉修复总结

## 结论

C19 Phase A 完成 Subagent Runtime P0 止血：删除讨论关键词被误判为强制委派的门禁与回合末 authority 断言，预算/scheduler 硬门禁降级为仅标黄的遥测警戒线，Teammate 入口完全隐藏，bash 只读分类按 fd 语义修正，并补上 Subagent 进度可见性与状态栏 Speed/Hit Rate 微调。Phase A+ 完成命令幻觉快速修复：系统提示词注入动态命令契约与产品差异声明，新增 `/reload` 平滑重启，postinstall 移除捆绑的上游 pi 文档，CLI 补 `-c/--continue`、`-r/--resume` 别名。

v2 Subagent Runtime（Phase B）按计划留待后续 Cycle，目标版本 v1.2.0。

## 验证

- `npm run check`（tsc + biome）通过。
- 130 files / 967 tests 全绿；PTY 11/11。
- 首次 CI 失败后补齐：`package-lock.json` 根版本同步 1.1.2，`verify-package.mjs` 接受 `trim-pi-docs.mjs` 进入 postinstall 与打包清单。
- 从 GitLab Release 下载 tarball 安装到全新临时 prefix：`vspi --version` 为 1.1.2；pi-coding-agent 的 `docs/`、`examples/`、上游 README 均不存在；`VSPi_FIXTURE=1 VSPi_REDUCED_MOTION=1 vspi --render-once` 退出码 0，TUI 干净启动。

## 发布

tag `v1.1.2` 指向 `9213b32`。GitLab pipeline 389 的 package 与 release job 均成功；Release `v1.1.2` 的 pinned 与 latest permalink 均指向有效 tarball。
