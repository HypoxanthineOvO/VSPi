---
kind: execution
cycle: C22-release-1-1-3
updated: 2026-08-20T21:16:00+08:00
---

# Execution Checkpoints

## 2026-08-20 - 发布授权

- 版本：`1.1.3`，SemVer patch。
- 范围：C20/C21 provider 错误投影、紧凑瀑布流错误节点、Inspect 展开和 JSON pretty-print。
- 用户明确选择完整发布：release notes、bump、验证、commit/tag，并推送 GitLab 与 GitHub。

## 2026-08-20 - 发布前验证

- `npm run check`：通过（253 个文件）。
- 全量 Vitest：通过，包含真实 PTY、Session continuity、package install 与 release surface。
- `npm pack` + `verify-package`：`vspi-1.1.3.tgz`，337 个文件，通过。
- 空目录安装：142 个 package 安装成功，`vspi --version` 输出 `1.1.3`。
