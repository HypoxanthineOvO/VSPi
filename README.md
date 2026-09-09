# VSPi

**把会话和后台工作留在运行时，把交互留在终端。**

VSPi 是基于 Kimi Code 引擎演进的终端编码助手。它用独立的常驻进程（daemon）承载会话、模型配置与任务，终端界面通过本机 IPC 接入：可以开始新会话、续接已有工作，也可以用非交互命令接入脚本。

[发布版本](https://github.com/HypoxanthineOvO/VSPi/releases) · [许可证](LICENSE) · [仓库开发约定](AGENTS.md)

## 安装与首次使用

**运行安装包：Node.js ≥ 22.19.0。** 建议使用 Node.js 22 或 24 的最新补丁版本。安装包与源码构建的版本要求不同，开发要求见下文。

安装 2.2.1：

```sh
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v2.2.1/vspi-2.2.1.tgz"
vspi --version
```

进入项目目录，在交互式终端中选择服务商（Provider）、配置凭据与默认模型，然后启动：

```sh
vspi init
vspi
```

已有配置时可以直接运行 `vspi`。之后使用 `vspi config` 调整 Provider，用 `vspi login <provider>` 登录账号或配置 API Key；界面内也提供 `/providers`、`/login`、`/model` 和 `/effort`。

升级使用 `vspi update`，安装完成后重新启动客户端。**更新客户端不会自动终止旧 daemon 的任务**；不同版本、构建或 Node 版本的客户端不会静默接管不兼容的 daemon。遇到身份不匹配时，先确认原任务已结束，再显式停止旧 daemon；也可以用独立 `VSPI_HOME` 并存测试新版本。

## 日常工作流

### 会话与后台任务

```sh
vspi                   # 新的交互会话，首次提交时创建会话记录
vspi continue          # 继续当前工作区最近的会话
vspi resume            # 打开会话选择界面
```

终端是运行时的前端，不是任务进程本身。在 TUI 中，`/quit` 默认断开前端，不取消正在执行的工作；`/cancel-and-exit` 才是取消并退出。`Ctrl+B` 可将当前支持的前台任务转到后台。

三个界面分工不同：

| 入口 | 用途 |
| --- | --- |
| `/sessions` | 浏览、切换会话与分支 |
| `/agents` | 浏览 Subagent 的状态与按时间排列的子对话；不展示 thinking |
| `/tasks` | 集中查看 Agent jobs、进程与问题，不展开子对话 |

运行中的 Subagent 状态显示在停靠区和 `/agents` 中，不向主对话重复插入活动卡片。子任务可配置独立模型；模型可用性与支持的思考档位由当前 Provider 目录决定。

### 计划、目标与定时提示

- `/plan` 查看当前计划；`/goal` 创建、查看或续跑持久目标，并提供暂停、恢复和接受结果的操作。
- `/cron` 查看、创建或取消定时提示。
- `/skills` 管理、安装或导入技能；安装包附带 `vspi-self`，便于在授权范围内读取自身配置与诊断信息。
- `/import` 导入 Codex 或 Claude Code 的外部历史。它是会话转换入口，不意味着外部工具的运行状态也能继续执行。

### 终端交互

常规模式使用终端原生滚动历史，全屏模式提供应用内滚动；可用 `/tui` 切换。输入区支持多行文本，生成时可以插话改向（steer）或排队追问（follow-up）。

| 命令 | 用途 |
| --- | --- |
| `/copy` | 复制最近一条已完成的正式回复 |
| `/compact` | 压缩当前上下文 |
| `/usage` | 查看用量信息 |
| `/policy` | 查看或切换权限策略 |
| `/settings`、`/theme`、`/thinking` | 调整界面、主题和思考内容展示 |
| `/reload` | 重新启动前端并续接当前会话 |

自动化能力不等于无条件授权。执行前应确认工作目录、权限策略与模型配置，尤其是涉及文件修改、进程和外部服务的任务。

### 脚本与非交互执行

```sh
vspi exec "说明当前仓库的测试入口"
vspi exec --output json "总结当前改动"
vspi exec resume latest "继续检查遗漏的测试"
vspi exec --help
```

`exec` 支持选择模型、思考档位、工作目录和会话，以及 `text`、`json`、`jsonl` 输出。它不提供交互式审批界面：需要人工批准、回答问题或调用交互式用户工具的场景，不应期待它像 TUI 一样等待输入。

## 模型与配置

VSPi 支持内置 Provider 和自定义兼容端点。VSPLab 中转站集成可补充远程模型目录，让客户端读取模型能力、上下文大小、价格与思考档位；可用模型仍取决于端点和账号权限，不能仅凭目录条目保证调用成功。

中转站明确声明的 `effortLevels` 会作为该模型的思考档位依据，不再被本地内置目录错误地缩减。仓库中的[模型目录快照](ops/vsplab/model-catalog.json)是可审阅的数据，而不是永不变化的模型能力保证。

配置默认位于 `~/.vspi/config.toml`。用 `vspi config path` 查询实际路径；设置 `VSPI_HOME` 可隔离配置、会话与 daemon。示意配置如下，模型 ID 和地址需要换成实际可用的值：

```toml
default_model = "example/YOUR_MODEL_ID"

[providers.example]
type = "openai"
base_url = "https://api.example.com/v1"

[models."example/YOUR_MODEL_ID"]
provider = "example"
model = "YOUR_MODEL_ID"
```

通过 `vspi login example` 配置凭据，不要把真实密钥提交到仓库。使用与模型匹配的协议和目录参数，不要随意填写上下文容量或价格。

```sh
vspi config path
vspi config inspect defaultModel
vspi config diagnostics
vspi config reload
```

`inspect` 和 `diagnostics` 只读连接已有 daemon；`reload` 才会重新读取磁盘配置。命令行配置 section 使用 `defaultModel` 等 Core 名称，TOML 使用 `default_model` 等磁盘字段名。`config get/inspect` 的输出会隐藏凭据，不要把脱敏后的整段值写回；修改少数字段优先使用 `config patch`，完整语法见 `vspi config --help`。

## 2.2.1 的可靠性修复

`ipc closed` 表示本机连接已经关闭，不是根因名称。此前记录中出现过目录扫描期间的 V8 堆内存耗尽。2.2.1 同时处理过量分配的路径和连接丢失后的前端恢复：

- **有界目录读取**：目录预览不再先加载整个目录再截取少量显示项。工作区列举和预览的单目录读取上限为 1 万项，多层列表与遍历共享 20 万节点预算；结果超限会明确标记截断，预览不会把数量下界冒充精确总数。
- **定向监听**：指令、MCP 配置和技能等已知候选路径通过浅层父目录监听接入，避免多个监听器为少量配置文件反复枚举整个工作区根目录；保留目录删除重建与指令文件变更提醒。
- **恢复原会话**：交互前端按退避策略重连，必要时重新启动已死亡的 daemon，再恢复原持久化会话。连续 5 次失败后提示人工处理；退出期间迟到的连接会被关闭。
- **输入区靠底**：修复常规模式下短内容、窗口放大和多行输入缩短时输入区偏到上方的问题。

验证使用了含 20 万个长文件名的隔离目录：旧预览代码在 64 MiB 堆限制下 OOM，修复后在 Node 22、24 下各完成 30 轮；真实安装包在 256 MiB 堆限制下完成会话创建和 10 轮关闭/恢复，测试期间工作区根目录的全量 `readdir` 调用数为 0。堆上限与整个进程的 RSS 是不同指标。

**这些验证覆盖本轮复现的扫描与初始化路径，不代表所有 OOM 都已消除。** 恢复连接不会自动重放崩溃时中断的提示或工具调用；需要判断任务停在哪里，再决定如何继续。

### 诊断与运行边界

```sh
vspi inspect paths
vspi inspect models
vspi daemon status
vspi daemon logs
```

`inspect` 不会启动、重启 daemon 或恢复会话。`daemon logs` 输出日志文件路径；运行时诊断文件位于对应 `VSPI_HOME` 的 `server/diagnostics/`。日志、堆快照和诊断报告可能包含敏感信息，分享前需要检查与脱敏。

`vspi daemon stop` 是显式停止运行时的操作，会影响它承载的工作，请勿把它当作无副作用的排查命令。

`vspi web` 当前输出本机 runtime 地址。**VSPi 安装包不附带独立浏览器前端，也不自动开放远程访问**；不要把这个命令等同于部署完整 Web UI 或公网服务。

## 从源码开发

源码构建需要 **Node.js ≥ 24.15.0、pnpm 10.33.0**。先安装依赖，再使用 VSPi 自己的入口：

```sh
pnpm install --frozen-lockfile
pnpm --filter vspi build
node apps/vspi/dist/main.mjs --help
pnpm --filter vspi test
pnpm run check:vspi
pnpm --filter vspi package:pack
pnpm --filter vspi package:verify
```

当前推荐先构建，再通过 `node apps/vspi/dist/main.mjs` 使用与安装包一致的入口。直接执行 TypeScript 的现有 `dev` 脚本仍有跨包装饰器转换限制，不作为本次发行验证通过的开发入口。调试时使用独立 `VSPI_HOME`，不要反复重启承载日常任务的 daemon。

| 目录 | 职责 |
| --- | --- |
| `apps/vspi/src/v1` | TUI、命令、面板与 Klient 数据投影 |
| `packages/vsp-runtime` | daemon 生命周期、租约、连接与配置迁移 |
| `packages/agent-core-v2` | 共享 agent 引擎与工作区能力 |
| `packages/kap-server`、`packages/klient` | 服务端接口与客户端 SDK |
| `packages/pi-tui` | 终端组件与渲染基础 |

VSPi 按独立版本 tag 发布到 GitHub Releases，不覆盖已发布的同名 tag 或资产。浏览器前端源码不在本仓库；修改 VSPi 的终端界面应从 `apps/vspi` 开始，而不是 `apps/kimi-code`。

## 致谢

VSPi 衍生自 [Moonshot AI 的 Kimi Code](https://github.com/MoonshotAI/kimi-code)，并使用来自 [pi-mono 的终端组件](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)。感谢上游项目与贡献者。
