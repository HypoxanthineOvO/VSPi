---
kind: plan
cycle: C13-pi-editor-latency-repair
mode: plan
status: closed
updated: 2026-08-16T18:29:19+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C12-release-train
---

# Pi Editor 与模型目录性能修订

## 执行目的

在恢复 0.6.2 已接受开屏与视觉基线的同时，定位并消除输入后向左移动光标的卡死，升级 Pi 0.84.2 模型目录，并修复模型列表加载与渲染卡顿。本 Cycle 产物为 v0.6.4 发布候选（用户确认）。

## 执行边界

- 优先使用 Pi 官方公开 Editor、cursor、scroll 和 model runtime API；不以全局字符替换规避性能问题。
- 保留 0.6.3 已验证方向的 regular history restore、局部 identity cache 与 Provider request compatibility；禁止跨 TUI frame 缓存整页 surface。
- 0.6.2 的开屏时序和品牌画面是接受基线，不新增更早版本的逐帧动画。
- Composer 保留 0.6.2 圆角外框，输入、IME、autocomplete、cursor 与滚动继续由 Pi Editor 所有。
- 本 Cycle 不自动发布；发布版本和远端副作用在原型方向确认后写入完整 Proposal。
- 删除 SSH Attachment Bridge 的自动服务、通知、设置、CLI 与文档；保留本地附件、SSH 命令审批和远程 Provider 认证。
- 默认 Execution Policy 改为 `Auto`；Policy 的项目降级、Recovery 与显式切换安全契约继续适用。
- Pi family 继续同版本升级；新模型目录通过有界 remote catalog refresh 更新，不单独强制替换 shrinkwrap 内的 `pi-ai`。

## 验证目标

- 本机 CJK 终端中，长文本输入后连续向左移动光标不会卡死、错位或触发非线性重绘；如另有实际 Windows 使用场景，再补充 Windows 验证。
- Composer 不再依赖不必要的 private state、ANSI/cursor marker 扫描或重复布局；保留附件、autocomplete 与 IME 行为。
- Pi coding-agent/TUI/transitive pi-ai 统一为 0.84.2；GLM-5.3 等目标模型按既有 curated 规则可见。
- 模型与 Provider 初始化不重复触发 availability refresh；模型列表搜索/移动不重复排序完整目录。
- fullscreen、regular、40/80/120 列与本机 PTY 门禁覆盖视觉、交互和性能。

## 完整 Proposal

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 官方 Editor 与 0.6.2 包裹版原型 | 展示同一输入、光标与长文本下的真实外观和调用链差异 | terminal mock、render trace、按键延迟基准 |
| `S1` | Composer 所有权审阅 | 用户选择保留 0.6.2 圆角外框，并复用 Pi Editor 的输入、IME、autocomplete 与滚动语义 | 接受标准：圆角视觉保留；性能修复落在 upstream 算法层，不再全局替换字符 |
| `M2` | Pi Editor 与 fullscreen 帧修订 | 保留版本守卫的 Editor 局部优化，移除会冻结 cursor/animation 的 VSPi 跨帧整页 cache，复用 Pi 官方 immediate render 与 differential output | fullscreen/regular 可见帧 cursor 回归；paste/emoji/CJK/IME/autocomplete/undo/vertical navigation；10K 输入与移动 benchmark |
| `M3` | 模型目录、Question 与产品清理 | Pi family 保持 0.84.2 同版；接入有界 remote catalog refresh；修复 Question Submit 对比度和动态模型显示；彻底删除 SSH Attachment Bridge；默认 Policy 改为 Auto | catalog refresh/缓存/超时、Question truecolor、model switch visible frame、无 Bridge surface、Policy default/Recovery 契约 |
| `M4` | 全量终端与发布门禁 | 收口版本一致性与产品清理，完成源码、PTY、打包、安装和本机 PATH 验证 | package/lock/CLI 一致；check/test/build/smoke/PTY/audit/pack/install 与 diff review |
| `S2` | 本机最终验收 | 用户在本机安装候选版本并验证输入、开屏和模型列表 | 本机实机接受或返回 M2/M3 修订；Windows 仅当实际使用场景存在时补充 |

ID 在 Proposal 确认后冻结。2026-08-16 的 S2 实机拒绝不新增或重排 ID，而是按同一 M2→M3→M4→S2 顺序重开修订。M2 的 compatibility patch 必须可重复、可验证、在不匹配 Pi 版本或源摘要时 fail closed，并能在 upstream 修复发布后删除。
