# VSPi

**把会话和后台工作留在运行时，把交互留在终端。**

VSPi 是基于 Kimi Code 引擎演进的终端编码助手。常驻进程（daemon）承载会话、模型配置与后台任务，终端界面和非交互命令通过本机 IPC 接入。

[发布版本](https://github.com/HypoxanthineOvO/VSPi/releases) · [使用指南](apps/vspi/docs/usage.md) · [版本记录](apps/vspi/docs/releases.md) · [许可证](LICENSE)

## 主要特点

- **前端与后台工作分离**：退出终端前端，不必取消运行中的任务；之后可以续接会话。
- **Subagent 协作**：子任务可配置独立模型，分别查看子对话与后台任务状态。
- **长程任务**：通过 `/goal` 管理持久目标，配合计划、定时提示和技能完成工作。
- **模型接入**：支持内置 Provider、自定义兼容端点，以及 VSPLab 中转站的动态模型目录。
- **终端与脚本**：支持原生滚动历史、全屏模式、中途插话，以及文本、JSON、JSONL 输出。

## 快速开始

### 新安装

运行安装包需要 **Node.js ≥ 22.19.0**，支持 Linux、macOS 与 Windows（Windows 上 npm 会生成 `vspi.cmd`，daemon 通过命名管道 IPC 通信）。

```sh
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v2.2.4/vspi-2.2.4.tgz"
vspi --version
```

进入项目目录，在交互式终端中配置服务商、凭据与默认模型，然后启动：

```sh
vspi init
vspi
```

已有配置时直接运行 `vspi`。用 `vspi config` 调整服务商，在界面内用 `/model` 和 `/effort` 选择模型及思考档位。首次配置时可直接选择内置的 VSPLab 中转站（默认接入 `api.vsplab.tech`）。

### 更新

已安装用户升级到最新发布版：

```sh
vspi update
```

`vspi update` 从 GitHub Release 获取 `vspi-latest.tgz`，校验 SHA-256 后经 npm/Volta 安装；升级完成后重启前端即可。要固定安装或降级到某个版本，重新执行对应版本的新安装命令。

升级不会自动停止旧 daemon：正在运行的任务保持原版本继续执行；前端重连遇到版本不匹配时，先确认原任务结束，再显式运行 `vspi daemon stop` 切换到新版本运行时。

## 常用操作

```sh
vspi continue                         # 继续当前工作区最近的会话
vspi resume                           # 选择历史会话
vspi exec "说明当前仓库的测试入口"       # 非交互执行
vspi exec --output json "总结当前改动" # JSON 输出
vspi update                           # 更新到最新发布版
```

界面内用 `/agents` 浏览子对话，`/tasks` 查看后台任务，`/goal` 管理目标；其他操作见[使用指南](apps/vspi/docs/usage.md)和 `vspi --help`。

**`/quit` 只断开前端，`/cancel-and-exit` 才取消当前运行并退出。**

## 配置与文档

配置默认位于 `~/.vspi/config.toml`，用 `vspi config path` 查询实际路径。设置 `VSPI_HOME` 可隔离配置、会话和 daemon。

```sh
vspi config --help
vspi config reload
```

不要把真实密钥提交到仓库。需要手动配置、权限说明或排查问题时，请查阅：

- [使用与配置](apps/vspi/docs/usage.md)：交互命令、模型、权限、诊断与运行边界。
- [版本记录](apps/vspi/docs/releases.md)：各版本修复与验证范围。
- [开发指南](apps/vspi/docs/development.md)：项目结构、验证和打包流程。

## 从源码开发

源码构建需要 **Node.js ≥ 24.15.0、pnpm 10.33.0**。

```sh
pnpm install --frozen-lockfile
pnpm --filter vspi build
node apps/vspi/dist/main.mjs --help
pnpm run check:vspi
```

开发时使用独立 `VSPI_HOME`，避免影响日常任务。更多说明见[开发指南](apps/vspi/docs/development.md)和[仓库约定](AGENTS.md)。

## 致谢

VSPi 衍生自 [Moonshot AI 的 Kimi Code](https://github.com/MoonshotAI/kimi-code)，并使用来自 [pi-mono 的终端组件](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)。感谢上游项目与贡献者。
