# 贡献指南

感谢关注 VSPi！本文面向想提交代码的开发者，说明开发环境、Commit / PR 规范与发布流程。提 PR（或 MR）前请先读完本文。

## 仓库布局

VSPi 有两个远端：

| 远端 | 地址 | 用途 |
| ---- | ---- | ---- |
| GitLab（主仓） | `gitlab.vsplab.cn:heyx/vspi` | 日常开发、CI 打包、内部 MR |
| GitHub（镜像） | `github.com/HypoxanthineOvO/VSPi` | 公开镜像、Release 发布、外部 PR |

- 内部贡献：在 GitLab 主仓从 `main` 拉分支，完成后提 Merge Request。
- 外部贡献：Fork GitHub 镜像，从 `main` 拉分支，完成后提 Pull Request。

两侧规范一致，下文统称 PR。

## 开发环境

- Node.js `>= 22.19.0`（CI 固定使用 22.22.0）
- 安装依赖：`npm ci`（会自动执行 postinstall 补丁脚本，请勿跳过）

常用命令：

```bash
npm run dev        # tsx 直接运行源码
npm run check      # tsc --noEmit + biome（提交前必须通过）
npm test           # vitest 全量测试（pretest 自动先 build）
npm run check:fix  # biome 自动修复格式与 import 排序
npm run smoke      # fixture 模式渲染一帧，快速冒烟
npm run test:pty   # PTY 端到端子集（较慢，改动 TUI/会话时跑）
```

## Commit 规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，标题保持一行、祈使语气：

```
<type>: <summary>
```

常用 type：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`。

- 标题不超过 72 字符，结尾不加句号。
- 正文可选；涉及行为变更时写清动机与影响面（参考 `git log` 中既有提交）。
- 一个 commit 聚焦一件事，避免混合无关改动。

## 分支命名

从 `main` 拉出，格式 `<type>/<短描述>`：

```
feat/vsplab-composite-catalog
fix/reload-watchdog
docs/contributing
```

## PR 规范

**标题**：与最终 squash 合入的 commit 标题一致，即 `<type>: <summary>`。

**描述**必须包含三部分：

1. **动机 / 问题**：为什么改；修 bug 时写清现象与根因（可附 issue 链接）。
2. **改动点**：主要变更列表；涉及接口 / 配置 / 协议变化时显式列出。
3. **验证方式**：跑了哪些命令与测试；UI 改动附截图或录屏。

**提交前 Checklist**：

- [ ] `npm run check` 无错误
- [ ] `npm test` 全量通过；新增行为附带测试，**bug 修复必须带回归测试**
- [ ] 未引入内部工作目录（`.pipeline/`、`.artifacts/`、`tmp/` 等均不入库）
- [ ] 行为变化已同步更新 `Docs/` 与 `README.md`
- [ ] 未提交任何凭据：内置 Provider 只允许携带公开元数据（baseUrl、协议、模型目录），API Key 一律走环境变量或 `vspi login`

## 测试约定

- 测试统一放在 `test/`，命名 `*.test.ts`，使用 [Vitest](https://vitest.dev/)。
- 单测保持离线：优先使用 fixture 后端（`VSPi_FIXTURE=1`），不得依赖真实 API Key 或外网。
- 涉及进程 / TTY 行为的测试优先写到普通 vitest；确需真实终端时放入 `test:pty` 子集。

## 发布流程（维护者）

1. 更新 `package.json` 版本号并合入 `main`。
2. 打 tag：`git tag vX.Y.Z && git push origin vX.Y.Z`（两个远端都要推）。
3. `v*` tag 触发 GitLab CI 打包（`npm pack` + `scripts/ci/verify-package.mjs` 校验）与 GitHub Release 工作流（发布 `vspi-latest.tgz`）。
4. 发布后在 GitHub 创建 Release Notes。

## 联系方式

问题与建议优先开 issue；内部同学也可在 GitLab MR 中直接 @ 维护者评审。
