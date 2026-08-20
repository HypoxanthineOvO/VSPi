---
kind: cycle-summary
cycle: C22-release-1-1-3
status: closed
updated: 2026-08-20T21:18:58+08:00
---

# VSPi 1.1.3 发布总结

## 结果

- `package.json`、`package-lock.json` 与 release notes 已发布为 `1.1.3`。
- Release commit：`b0d636272636d9d1c94bca9596da44f9c52990f3`。
- Annotated tag：`v1.1.3`。
- GitLab 与 GitHub 的 main/tag、pipeline/workflow、Release 与资产全部完成。

## 验证

- `npm run check` 与全量 Vitest 通过。
- 本地 `npm pack`、`verify-package`、空目录安装和版本运行通过。
- GitLab pipeline `#397` 与 GitHub Actions run `32373363206` 成功。
- 双远端 pinned/latest 四个 tarball 哈希一致：`a6b7822626ad3c3b29476fc477175a10379797990bbe9503f89022f60e25dd18`。
- 四个远端 tarball 包内版本均为 `1.1.3`。

## Release

- GitLab：<https://gitlab.vsplab.cn/heyx/vspi/-/releases/v1.1.3>
- GitHub：<https://github.com/HypoxanthineOvO/VSPi/releases/tag/v1.1.3>
