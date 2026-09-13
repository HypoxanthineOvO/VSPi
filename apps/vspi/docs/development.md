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

### Feedback 与实验分发工具

构建另行输出 `feedback-server.mjs`、`feedback-admin.mjs`、`distribution-admin.mjs`、`distribution-install.mjs`，不包含在普通客户端发布包中，供管理员操作包使用。2.4.0 默认提供 `/feedback`、`vspi feedback`；签名更新仍由 `KIMI_CODE_EXPERIMENTAL_VSPI_DISTRIBUTION` 显式启用，并要求镜像部署和可信公钥先就绪。普通更新仍走 GitHub；不要把本地验收等同于远端部署或自动通知就绪。

用 `node apps/vspi/dist/feedback-server.mjs /absolute/path/server.json` 启动。配置文件应为私有文件，包含 `directory`、`port`（1024–65535，默认只监听 127.0.0.1）、`submitters`（每项包含 `id`、独立随机 `token`，至少 32 字符）。不要复用模型 API Key。远端配置、反向代理、DNS/TLS 和 Hermes 读取权限必须经管理员审阅后单独部署。

仅支持 `POST /api/feedback`，需要独立 Bearer 凭证、`Content-Type: application/json` 和 `X-Feedback-Consent: reviewed-v1`。单包最多 1 MiB，默认最多两个活动上传、32 个连接、每凭证每分钟 10 次请求；存储默认 256 MiB 预算（含保守元数据开销），最多 1000 条反馈，达到上限拒绝新提交，不自动删除用户数据。容量管理和持久处理游标仍需纳入部署验收。

先写私有 `staging/` 和 owner PID，验证和脱敏后写入 `bundle.json`、`manifest.json`、`summary.md`，同步磁盘并原子发布到 `ready/<id>/` 后才确认成功。重复提交还会核对已存包的完整性。重启仅回收可核实 owner 已死亡的未确认临时目录，不明归属保留并计入预算。正式 unit 使用 flock 保证单接收进程，配额和限流不是分布式的。

Hermes 通过 list/show/ack 受限 SSH 命令读取 ready；只有独立回执目录可写，不能读取配置组的提交凭据。凭据 reload 不重启接收端。部署文件和管理员包生成器见[操作包说明](../../../ops/vspi-services/README.md)。

本地验证：`pnpm -C apps/vspi exec vitest run test/feedback.test.ts test/distribution.test.ts test/tui-render.test.ts`、`VSPI_TEST_CADDY=/path/to/caddy node --test scripts/prepare-vspi-admin.test.mjs`。未提供实际 Caddy 二进制时，对应解析测试会显式跳过，不算部署配置验收通过。已覆盖的脱敏规则不代表任意未知秘密都能识别，仍须让使用者预览具体上传内容。

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

VSPi 不通过 GitHub Actions 构建或验证发行包。发布前在本地完成声明范围内的验证，再用 `scripts/github-release-producer.mjs` 直接创建 GitHub Release——发布产物与验证过的 tarball 逐字节一致（SHA256SUMS 由被验证文件生成）。2.3.0 经确认采用 Linux 先行、Windows 验收后置；不得把未验收的平台写成已通过。

### 发版前清单：Linux 工作机

```sh
pnpm run check:vspi
node --test scripts/github-release-producer.test.mjs
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

全部通过后，在 Linux 工作机生成校验和并发布（`GITHUB_TOKEN` 需要 `contents:write` 权限的 PAT；本机网络需代理出网时，加 `NODE_USE_ENV_PROXY=1` 让 Node 的 fetch 走 `http_proxy`/`https_proxy`）：

```sh
VERSION=$(node -p 'require("./apps/vspi/package.json").version')
cd apps/vspi/.tmp/package-artifacts
cp "vspi-${VERSION}.tgz" vspi-latest.tgz
sha256sum "vspi-${VERSION}.tgz" vspi-latest.tgz > SHA256SUMS
cd -
NODE_USE_ENV_PROXY=1 GITHUB_REF_NAME="v${VERSION}" \
GITHUB_API_URL="https://api.github.com" \
GITHUB_REPOSITORY="HypoxanthineOvO/VSPi" \
GITHUB_TOKEN="<PAT>" \
node scripts/github-release-producer.mjs \
  "apps/vspi/.tmp/package-artifacts/vspi-${VERSION}.tgz" \
  "apps/vspi/.tmp/package-artifacts/vspi-latest.tgz" \
  "apps/vspi/.tmp/package-artifacts/SHA256SUMS" \
  ".tmp/vspi-github-release.json"
```

版本号、tag 与 `apps/vspi/package.json` 的一致性由 `vspi-release-identity.mjs` 校验；producer 不会覆盖已发布的同名 tag 或资产。`vspi update` 从共享 `latest` 标签定位版本化 tgz，并校验 `SHA256SUMS`。版本修复及验证范围记录在[版本记录](releases.md)。

`GITHUB_RELEASE_NOTES` 提供包含适用平台、安装说明与风险的发布正文（校验和仍自动添加）。若未来明确需要独立于共享更新通道发布，可设置 `GITHUB_RELEASE_MAKE_LATEST=false`；2.3.0 按最后确认的要求走普通正式发布，不使用该分流选项，Windows 未验收风险直接写入发布说明。
