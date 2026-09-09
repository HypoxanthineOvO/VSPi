# 开发指南

[返回项目首页](../../../README.md) · [使用与配置](usage.md)

源码构建需要 **Node.js ≥ 24.15.0、pnpm 10.33.0**，不同于安装包的 Node.js ≥ 22.19.0 运行要求。

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

VSPi 通过独立版本 tag 触发 [GitHub Release 流程](../../../.github/workflows/vspi-release.yml)，不覆盖已发布的同名 tag 或资产。

发布流水线验证版本身份、安装包内容和 Node 22/24 兼容性，并运行真实 daemon 内的 CLI 自调用回归。版本修复及验证范围记录在[版本记录](releases.md)，不继续累积到项目首页。
