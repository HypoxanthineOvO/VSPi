<div align="center">

# VSPi

[![Release](https://img.shields.io/github/v/release/HypoxanthineOvO/VSPi?display_name=tag&sort=semver)](https://github.com/HypoxanthineOvO/VSPi/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

</div>

VSPi 是基于 [Pi](https://github.com/earendil-works/pi-coding-agent) 开发的终端 Coding Agent。它保留了 Pi 的简洁内核和全部 Provider 协议支持，在此之上重点打磨了四件事：

- **更舒服的人机交互**：内置 Question Tool，当 Agent 需要你做决策时，会弹出结构化的选择面板（单选 / 多选 / 排序 / 自由输入），而不是让你在一大段文字里找问题、再手动敲回复；更舒适的瀑布流，区分任务执行、思维链和模型输出；更清晰的界面显示：除了模型、上下文和路径等常规内容之外，提供吞吐量、缓存命中率、Token 计费等统计信息。
- **更好的渲染效果**：对终端里的 Markdown 做了深度优化——标题、代码块高亮、LaTeX 公式、Mermaid 图表，长回复也能清爽可读。
- **前缀缓存机制**：精心设计的上下文结构让稳定前缀最大化命中 Provider 的 Prompt Cache，长会话的 Token 成本和首 Token 延迟显著下降。
- **DeepSeek Harness**：集成了 DeepSeek Harness 极简版工具调用（persistent bash + str_replace editor），自动识别 DeepSeek 模型并注入官方推荐的工具与 Persona，激发最强 DeepSeek。

> 需要 Node.js `>=22.19.0`。

## 安装

```bash
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz"
```

<details>
<summary>其他安装方式（Linux curl）</summary>

Linux / macOS：

```bash
curl -fL 'https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz' -o /tmp/vspi-latest.tgz && npm install -g /tmp/vspi-latest.tgz
```

</details>

安装后检查：

```bash
vspi --version
```

## 快速开始

运行配置入口，选择内置服务或任意自定义中转站（自动从 `/models` 发现模型）：

```bash
vspi config
```

然后开聊：

```bash
vspi                      # 开始新对话
vspi continue             # 继续最近一次对话
vspi run "解释这段代码"    # 单次任务，直接输出结果
```

## 功能一览

| 功能             | 说明                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| Question Tool    | Agent 主动发起结构化提问，面板式作答，决策不再靠打字                   |
| Markdown 渲染    | 标题 / 代码高亮 / LaTeX / Mermaid，终端里的完整渲染                    |
| 前缀缓存         | 稳定前缀命中 Prompt Cache，省钱、降延迟                                |
| DeepSeek Harness | 检测到 DeepSeek 模型自动启用极简工具集，释放模型上限                   |
| 多协议支持       | 继承 Pi 的全部 Provider 协议，任意 OpenAI / Anthropic 兼容端点皆可接入 |
| 图片输入         | `Ctrl+V` / `Alt+V` 直接粘贴剪贴板截图发给模型                          |
| 会话管理         | `vspi continue` / `vspi resume` 续接历史对话                           |
| 计划与目标       | `/plan`、`/goal` 跟踪多步任务进度                                      |
| 安全策略         | Safe / Standard / YOLO / Auto 四档执行策略，`/policy` 随时切换         |
| 自更新           | `vspi update` 一键升级到最新稳定版（SHA-256 校验）                     |

输入 `/` 查看所有可用命令；`Tab` 补全命令，`Shift+Tab` 在面板间切换，`Ctrl+C` 中断当前任务。

## 更新

```bash
vspi update
```

## 详细文档

- [使用手册](Docs/usage.md)
- [TUI 设计与响应式规范](Docs/tui-v1.md)
- [测试与调试](Docs/testing-and-debugging.md)
- [各模型 Harness 说明](Docs/harness/README.md)
