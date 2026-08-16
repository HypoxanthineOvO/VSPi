# VSPi

[![Release](https://img.shields.io/github/v/release/HypoxanthineOvO/VSPi?display_name=tag&sort=semver)](https://github.com/HypoxanthineOvO/VSPi/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

VSPi 是 VSPLab 开发的，基于 Pi 的中文终端编程助手。

> 需要 Node.js `>=22.19.0`。

## Quick Start

Release 的 `latest` 地址始终指向最新稳定版本。

Linux / MacOS：

```bash
curl -fL 'https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz' -o /tmp/vspi-latest.tgz && npm install -g /tmp/vspi-latest.tgz
```

GitLab stable latest：

```bash
curl -fL 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/permalink/latest/downloads/vspi-latest.tgz' -o /tmp/vspi-latest.tgz && npm install -g /tmp/vspi-latest.tgz
```

GitHub stable latest：

```bash
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz"
```

Windows PowerShell：

```powershell
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz"
```

安装后检查：

```bash
vspi --version
```

## 首次配置

运行配置入口：

```bash
vspi config
```

选择 **VSPLab** 可配置内置服务；选择 **自定义中转站** 时，VSPi 会依次询问名称、Base URL、接口类型和 API Key，然后尝试从 `<Base URL>/models` 发现模型。端点不支持发现时，可手动输入模型 ID。

也可以直接进入自定义流程或单独管理登录：

```bash
vspi config custom
vspi login kimi-coding
vspi login
vspi logout kimi-coding
```

Provider 元数据保存到 Pi global `models.json`；API Key 和订阅凭据由 Pi `AuthStorage` 保存到 `~/.pi/agent/auth.json`。Secret 不写入模型配置。`vspi init` 在 v1 中仍是兼容 alias，但会提示迁移到 `vspi config`。

## 开始使用

完成配置后运行：

```bash
vspi
```

常用启动方式：

```bash
vspi                  # 开始新对话
vspi continue         # 继续最近一次对话
vspi resume           # 选择历史对话
vspi run "解释这段代码" # 执行一次任务并直接输出结果
```

使用过程中：

- 在输入框中输入内容，按 `Enter` 发送。
- 按 `Tab` 补全 `/` 命令。
- 按 `Shift+Tab` 在输入框、对话记录和计划面板之间切换。
- 按 `Alt+Enter` 添加一条稍后处理的消息。
- 按 `Ctrl+C` 中断当前任务；空闲时再次按下可退出。
- 按 `Ctrl+V` 或 `Alt+V`，可将剪贴板图片发送给支持图片输入的模型。

输入 `/` 可以查看所有可用命令。

## 安全边界

VSPi 提供 Safe、Standard、YOLO 和 Auto 四档执行策略。Safe 最严格、询问最多；Auto 不再询问，执行前请确认你信任当前项目。

## 更新

```bash
vspi update
```

自更新会读取最新稳定版本、校验 SHA-256，并更新当前 npm 或 Volta 安装位置。更新成功后重新运行 `vspi` 即可。

## 详细文档

- [使用手册](Docs/usage.md)
