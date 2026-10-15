# VSPi Desktop

VSPi Desktop 通过 SSH 连接远端 VSPi 运行时，在同一个窗口中查看会话、浏览项目文件、操作终端和编辑远端 Provider 凭据。任务和会话保存在远端；关闭桌面窗口后，运行中的 Agent 任务继续执行。

## 从源码启动

使用仓库要求的 Node.js 和 pnpm 版本。桌面主机和远端主机都需要 OpenSSH；远端需要包含 Desktop 协议的本分支 VSPi 构建，已发布的 2.6.0 尚未包含此接口。

```sh
pnpm install
pnpm --filter vspi build
pnpm --filter @vsp/vspi-desktop build
KIMI_CODE_EXPERIMENTAL_DESKTOP=1 pnpm --filter @vsp/vspi-desktop start
```

Linux 构建远端终端组件时，需要 Python、make 和 C++ 编译器。构建会将 `node-pty` 原生文件加入 VSPi 包及 daemon 的独立副本。

在连接窗口填写 SSH 别名或 `user@host`。已有 SSH 配置中的端口、跳板机和密钥代理会被沿用；也可以展开设置指定端口、远端 VSPi 可执行文件和数据目录。首次连接会显示主机指纹，密码与密钥口令通过独立认证窗口输入。浏览远端目录后创建会话，也可以从侧栏打开既有会话。

远端已有不同构建的 daemon 时，需要先处理版本不兼容提示。Desktop 不会自动停止任务或替换运行中的 daemon。开发测试应指定独立数据目录。

## 使用

- 消息默认排队；任务运行中可以选择“补充指令”或“停止”。提交未确认时，“重试确认”沿用原消息 ID。草稿保存在当前电脑，重连后不会自动发送。
- 右侧终端使用远端工作区目录，切换面板时保留。断线或退出 Desktop 会关闭这些交互终端；需要长期保留的终端进程请使用 tmux。
- 文件预览只读，文本上限 256 KiB、常见图片上限 2 MiB。HTML 和 SVG 按文本显示。目录按层读取，每层最多显示 200 项。
- Provider 设置写入当前远端运行时，对其下所有工作区生效。API Key 支持保留、替换、清除与环境变量引用；配置冲突时需重新读取。连接测试会从远端发起一次真实模型请求。

当前是 M1 开发版本。已在 Linux 上验证 Electron 44.7.0、真实 SSH 通道、独立客户端接续、终端及配置保存。Windows/macOS 安装包、两台物理设备验收、远端 OAuth、附件、完整 Agents/Side 面板和自动重连属于后续工作。完整目标见仓库根目录的 `Goal.md`。

## 验证

```sh
pnpm --filter @vsp/vspi-desktop typecheck
pnpm --filter @vsp/vspi-desktop test
pnpm --filter vspi test
pnpm --filter @moonshot-ai/klient test
pnpm --filter @vsp/vsp-runtime test
```
