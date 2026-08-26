# CI 与发布维护

VSPi 使用项目锁定的 Docker Runner 和版本化 Node 镜像。CI 从 `package.json` 派生包版本；发布 Tag 必须使用对应的 `v<version>` 格式。

## 一次性主机配置

GitLab Omnibus 和 Docker Runner 均位于 `genesis`。在仓库根目录启用本机 Registry、注册项目 Runner 并发布 CI 镜像：

```bash
sudo ./ci/admin/configure-registry.sh
./ci/admin/register-runner.sh
./ci/admin/publish-ci-image.sh
```

Registry 脚本会备份 `/etc/gitlab/gitlab.rb` 和已有的 Registry Nginx 站点，遇到不受本脚本管理的 Registry 配置时停止。内部 Registry 只监听 `127.0.0.1:5000`，外部 `5050` 端口由系统 Nginx 承载，并复用主站自动续期的 Let's Encrypt 证书。Runner 脚本通过 GitLab API 创建项目级 Runner，仅在写入系统 Runner 配置时请求 sudo；注册失败会删除新建但未启用的 Runner。

系统 Runner 的 `/etc/gitlab-runner/config.toml` 使用 `concurrent = 2`；VSPi Runner 自身也限制最多两个并发 Job。调整并发前必须同时评估同机其他项目的 Runner 负载。

发布新 CI 镜像后，以 Registry 返回的不可变 digest 替换 `.gitlab-ci.yml` 中的默认镜像。Dockerfile、基础镜像或已安装工具发生变化时，递增 `ci/image/VERSION`；禁止覆盖已有镜像 Tag。

Pi 原生 `find` 与 `grep` 分别依赖 `fd` 和 `rg`，Subagent workspace 安全回归依赖 `bubblewrap`。CI 不允许在测试运行时查询 GitHub latest 或临时下载工具；`fd`/`rg` 的固定版本官方归档在 Generic Package `vspi-ci-tools/1` 中，Dockerfile 使用 `ci/image/TOOLS.sha256` 对应的 SHA-256 校验；`bubblewrap` 固定到基础 Debian 发行版的完整包版本。升级工具时必须递增 CI 镜像版本并使用新的不可变 digest。

## Pipeline 契约

当前 GitLab Pipeline 仅由 Tag 触发。创建发布 Tag 前，维护者必须在目标提交本地完成以下四项等价验证：

- `quality`：TypeScript 与 Biome 检查。
- `test`：限制并发的确定性 Vitest 测试。
- `package`：只构建一个 npm tarball，验证包内容并生成 SHA-256。
- `install-smoke`：在干净目录中按正常生命周期安装同一个 tarball，并执行 CLI。

SemVer Tag Pipeline 执行 `package` 和不可中断的 `release` Job。它把 package 阶段的原始 tarball 上传到 Generic Package Registry，并创建指向不可变包地址的 GitLab Release；发布阶段绝不重新构建。版本、文件名和 tag 都从 `package.json` 派生，测试不得写死当前发布版本。

GitLab 项目设置要求 main 仅 Maintainer 可 push/merge 且禁止 force push，`v*` Tag 仅 Maintainer 可创建。Container Registry 每日执行清理，保留最近 10 个镜像 Tag，并且只清理 90 天以上的旧 Tag。

## 发布流程

1. 把 `package.json` 和 `package-lock.json` 更新到目标版本。
2. 在目标提交上依次完成 `npm run check`、限制并发的全量 Vitest、tarball 校验和干净目录安装 smoke。
3. 先把该提交推送到 GitLab 与 GitHub 的 `main`，确认两个远端指向同一提交。
4. 在已验证提交上创建受保护的 `v<version>` Tag，并推送到两个远端。
5. 检查 GitLab Tag Pipeline、GitHub Release workflow、包上传、Release 资产、校验和、匿名下载与全局安装。

禁止移动已经发布的 Tag；错误发布必须用新的 patch 版本修复。
