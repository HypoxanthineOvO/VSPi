# 版本记录

[返回项目首页](../../../README.md) · [下载发行包](https://github.com/HypoxanthineOvO/VSPi/releases)

自 2.2.4 起发行包改为本地构建并经 Windows 实机验证后直接发布，发版流程见[开发指南](development.md#发布)；此前版本未做 Windows 实机验证，相关表述以各条目记录为准。

## 2.2.4 — VSPLab 域名迁移与 Windows 支持

[发行包](https://github.com/HypoxanthineOvO/VSPi/releases/tag/v2.2.4)

- VSPLab 成为内置 Provider：`vspi init` 列表置顶可选，配置后默认接入 `api.vsplab.tech`（可用 `VSPLAB_BASE_URL` 或 `base_url` 覆盖）；旧配置里的 `api.vsplab.cn` 地址在 daemon 启动迁移时自动改写，迁移前自动备份。
- Windows 安装与升级适配：打包与安装验证脚本跨平台化（`vspi.cmd`/`npm.cmd` 经 cmd 调用，npm 验证环境隔离 `USERPROFILE`）；detached daemon 隐藏控制台窗口；命名管道路径不再误执行文件 unlink。
- 发行流程改为本地构建、Windows 实机验证后直接发布，不再依赖 GitHub Actions；`vspi update` 与安装命令不变。
- VSPLab 模型目录：DeepSeek V4.1 Flash 转正（移除内测 `expires-on-0910` 后缀并补充发布日期），flash 系列价格按官方 9 月 10 日新定价（空闲时段、7.2 汇率）修正，目录与线上部署内容逐字节对齐。

### 验证范围

Linux 侧 `check:vspi` 全量通过（agent-core-v2 / kap-server / vsp-runtime / vspi 共约 7600 项，klient 有 2 项与本版无关的本机环境预存失败），安装包在 Node 24 与 22.19 下完成隔离安装与真实 daemon 启停回归。Windows 实机按源码构建与 tarball 两条路径验证（构建打包、隔离安装、named-pipe daemon 启停、全局安装与 `vspi update`），过程记录见开发指南发版清单。

## 2.2.3 — 文档整理

[发行包](https://github.com/HypoxanthineOvO/VSPi/releases/tag/v2.2.3)

- 精简项目首页和安装包 README，集中展示产品特色、快速开始和常用操作。
- 将配置、诊断、开发说明及历史修复记录移入 VSPi 专属文档，保留原有信息与验证边界。
- 本版除版本标识外不修改运行代码或权限行为。

## 2.2.2 — 权限状态与嵌套 CLI

[发行包](https://github.com/HypoxanthineOvO/VSPi/releases/tag/v2.2.2) · [相关改动](https://github.com/HypoxanthineOvO/VSPi/pull/4)

- 状态栏和权限面板同步当前 Agent 的实际权限，其他客户端修改权限时也会更新，不再把前端默认的 Auto 当成后端状态。
- 草稿权限只用于首次创建会话；切换、恢复和重连已有会话时读取持久化权限，不重放旧的前端选择。初始化期间降权、迟到默认值与状态响应也有回归保护。
- daemon 内通过 PATH 调用的 `vspi` 固定使用其启动 Node 和程序文件，默认连接该 daemon 的 `VSPI_HOME`，保留调用者显式指定的 `VSPI_HOME`。避免多份安装或项目本地依赖让诊断命令误执行旧版程序。

后端的权限规则未放宽。Safe 与 Standard 都映射到 `manual`，恢复后显示为 Standard；计划模式和显式拒绝规则仍然生效。

### 验证范围

前端与真实包测试在 Node 22.19.0、24.16.0 下各 239 项通过。隔离 daemon 实验验证了多客户端权限更新、重新绑定时保留 Auto，以及模拟 daemon 崩溃后保留 manual。真实 Bash 调用在 PATH 前部故意放置旧 CLI 时，仍使用当前程序与隔离 HOME；该用例已加入发布流水线。

这覆盖已复现的状态同步与入口选择问题，不代表所有工具拒绝都属于权限下降；计划限制和拒绝规则需要单独判断。固定 PATH 入口不是进程沙箱，也不拦截用户显式执行另一个绝对路径的程序。

## 2.2.1 — 目录扫描与断线恢复

[发行包](https://github.com/HypoxanthineOvO/VSPi/releases/tag/v2.2.1) · [相关改动](https://github.com/HypoxanthineOvO/VSPi/pull/3)

`ipc closed` 表示本机连接已经关闭，不是根因名称。此前记录中出现过目录扫描期间的 V8 堆内存耗尽，本版同时处理过量分配的路径和断线后的前端恢复：

- 目录预览不再先加载整个目录再截取少量显示项。工作区列举和预览的单目录读取上限为 1 万项，多层列表与遍历共享 20 万节点预算；超限标记截断，预览不会把数量下界冒充精确总数。
- 指令、MCP 配置和技能等已知候选路径通过浅层父目录监听接入，避免多个监听器反复枚举整个工作区根目录；保留目录删除重建与指令文件变更提醒。
- 交互前端按退避策略重连，必要时重新启动已死亡的 daemon，再恢复原持久化会话。连续 5 次失败后提示人工处理；退出期间迟到的连接会被关闭。
- 修复常规模式下短内容、窗口放大和多行输入缩短时输入区偏到上方的问题。
- 安装包运行要求降至 Node.js ≥ 22.19.0，源码构建要求仍为 Node.js ≥ 24.15.0。

### 验证范围

压力测试使用含 20 万个长文件名的隔离目录：旧预览代码在 64 MiB 堆限制下 OOM，修复后在 Node 22、24 下各完成 30 轮；真实安装包在 256 MiB 堆限制下完成会话创建和 10 轮关闭/恢复，测试期间工作区根目录的全量 `readdir` 调用数为 0。

堆上限与整个进程的 RSS 是不同指标。这些验证覆盖本轮复现的扫描与初始化路径，不代表所有 OOM 都已消除。恢复连接不会自动重放崩溃时中断的提示或工具调用，需要判断任务停在哪里再继续。

上述版本未做 Windows/macOS 实机验证。
