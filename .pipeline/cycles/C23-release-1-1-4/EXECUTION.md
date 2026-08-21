---
kind: execution
cycle: C23-release-1-1-4
updated: 2026-08-21T16:30:00+08:00
---

# Execution Checkpoints

## 2026-08-21 - 修复实现与发布授权

- 版本：`1.1.4`，SemVer patch。
- 范围：Sessions 多行标题渲染错乱修复（后端 `sessionDisplayLabel` + UI `singleLine` 双层净化、Notice 压平）、会话行运行状态（`● 使用中` / `当前`）、120 列 Token 槽位 30→34 保住 Hit Rate 尾数、思考块 Markdown 结构色统一灰调（`thinkingMarkdown`）、Commentary 恢复正文本色。
- 用户明确指示"发布 v1.1.4"。

## 2026-08-21 - 发布前验证

- `npm run check`：通过。
- 全量 Vitest：130 个文件、976 个用例通过，含真实 PTY、Session continuity、package install 与 release surface。
- `npm pack` + `verify-package`：通过。
- 空目录安装与 `vspi --version` 验证通过。

## 2026-08-21 - 双远端发布完成

- Release commit：`45fe9d7`。
- Annotated tag：`v1.1.4`，GitLab/GitHub 均已推送。
- GitLab pipeline `#398`：package 与 release jobs 成功。
- GitHub Actions run `32463418339`：Release workflow 成功。
- GitLab/GitHub 的 pinned/latest 四个 tarball SHA-256 均为 `520acefda78ad8c7232eec72833126c437cc9816596811df25cc736522136ab2`（远端 CI 打包，与本地哈希不同属正常）。
- 四个远端 tarball 的 `package.json.version` 均为 `1.1.4`。
