# 开发指南

[返回项目首页](../../../README.md) · [使用与配置](usage.md)

源码构建需要 **Node.js ≥ 24.15.0、pnpm 10.33.0**，不同于安装包的 Node.js ≥ 22.19.0 运行要求。构建脚本在 Linux 与 Windows 上均可运行。

## 构建与验证

从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter vspi build
node apps/vspi/dist/main.mjs --help
pnpm --filter vspi test
pnpm run check:vspi
pnpm --filter vspi package:pack
pnpm --filter vspi package:verify
```

当前推荐先构建，再通过 `node apps/vspi/dist/main.mjs` 使用与安装包一致的入口。直接执行 TypeScript 的现有 `dev` 脚本仍有跨包装饰器转换限制，不作为已验证的开发入口。

调试时使用独立 `VSPI_HOME`，不要反复重启承载日常任务的 daemon。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `apps/vspi/src/v1` | TUI、命令、面板与 Klient 数据投影 |
| `packages/vsp-runtime` | daemon 生命周期、租约、连接与配置迁移 |
| `packages/agent-core-v2` | 共享 agent 引擎与工作区能力 |
| `packages/kap-server`、`packages/klient` | 服务端接口与客户端 SDK |
| `packages/pi-tui` | 终端组件与渲染基础 |

开发遵循[仓库约定](../../../AGENTS.md)及 [VSPi 目录约定](../AGENTS.md)。修改 VSPi 终端界面应从 `apps/vspi` 开始，而不是 `apps/kimi-code`；浏览器前端源码不在本仓库。

## 发布

VSPi 不通过 GitHub Actions 构建或验证发行包。发布前在本地完成全部验证，再用 `scripts/github-release-producer.mjs` 直接创建 GitHub Release——发布产物与验证过的 tarball 逐字节一致（SHA256SUMS 由被验证文件生成）。

### 发版前清单：Linux 工作机

```sh
pnpm run check:vspi
pnpm --filter vspi package:pack
pnpm --filter vspi package:verify
VSPI_PACKAGE_SMOKE_ENTRY="$PWD/apps/vspi/.tmp/package-stage/dist/main.mjs" \
  pnpm --filter vspi exec vitest run test/daemon-environment.test.ts
```

### 发版前清单：Windows 实机（SSH）

首次连接先确认环境（源码构建路径需要 Node ≥ 24.15 与 pnpm 10.33；tarball 路径只需 Node ≥ 22.19）：

```sh
node -v
corepack enable
pnpm -v
```

两条路径都要通过：

```sh
# 路径 1：源码构建（验证构建与打包脚本在 Windows 上可用）
git fetch && git checkout v<x.y.z>
pnpm install --frozen-lockfile
pnpm --filter vspi package:pack
pnpm --filter vspi package:verify

# 路径 2：tarball（验证 Linux 产出的同一个 tgz，即 Windows 用户的真实安装路径）
node apps/vspi/scripts/verify-package.mjs vspi-<x.y.z>.tgz
npm install --global vspi-<x.y.z>.tgz
vspi --version
vspi update
```

交互式 `vspi init` / `vspi config` 需要 TTY：普通 SSH 管道会被拒绝，使用 `ssh -t` 连接后再执行。

### 发布

全部通过后，在 Linux 工作机生成校验和并发布（`GITHUB_TOKEN` 需要 `contents:write` 权限的 PAT）：

```sh
VERSION=$(node -p 'require("./apps/vspi/package.json").version')
cd apps/vspi/.tmp/package-artifacts
cp "vspi-${VERSION}.tgz" vspi-latest.tgz
sha256sum "vspi-${VERSION}.tgz" vspi-latest.tgz > SHA256SUMS
cd -
GITHUB_REF_NAME="v${VERSION}" \
GITHUB_API_URL="https://api.github.com" \
GITHUB_REPOSITORY="HypoxanthineOvO/VSPi" \
GITHUB_TOKEN="<PAT>" \
node scripts/github-release-producer.mjs \
  "apps/vspi/.tmp/package-artifacts/vspi-${VERSION}.tgz" \
  "apps/vspi/.tmp/package-artifacts/vspi-latest.tgz" \
  "apps/vspi/.tmp/package-artifacts/SHA256SUMS" \
  ".tmp/vspi-github-release.json"
```

版本号、tag 与 `apps/vspi/package.json` 的一致性由 `vspi-release-identity.mjs` 校验；producer 不会覆盖已发布的同名 tag 或资产。`vspi update` 从 GitHub Release 的 `vspi-latest.tgz` 与 `SHA256SUMS` 发现并校验更新。版本修复及验证范围记录在[版本记录](releases.md)。
