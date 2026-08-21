---
kind: cycle-summary
cycle: C23-release-1-1-4
status: closed
updated: 2026-08-21T16:32:30+08:00
---

# VSPi 1.1.4 发布总结

## 结果

- `package.json`、`package-lock.json` 与 release notes 已发布为 `1.1.4`。
- Release commit：`45fe9d7`。
- Annotated tag：`v1.1.4`。
- GitLab 与 GitHub 的 main/tag、pipeline/workflow、Release 与资产全部完成。

## 验证

- `npm run check` 与全量 Vitest（130 文件、976 用例）通过。
- 本地 `npm pack`、`verify-package`（337 文件）、空目录安装和版本运行通过。
- GitLab pipeline `#398` 与 GitHub Actions run `32463418339` 成功。
- 双远端 pinned/latest 四个 tarball 哈希一致：`520acefda78ad8c7232eec72833126c437cc9816596811df25cc736522136ab2`。
- 四个远端 tarball 包内版本均为 `1.1.4`。

## Release

- GitLab：<https://gitlab.vsplab.cn/heyx/vspi/-/releases/v1.1.4>
- GitHub：<https://github.com/HypoxanthineOvO/VSPi/releases/tag/v1.1.4>
