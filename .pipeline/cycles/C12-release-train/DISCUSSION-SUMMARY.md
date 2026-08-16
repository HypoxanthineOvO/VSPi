---
kind: discussion-summary
cycle: C12-release-train
updated: 2026-08-15T17:41:14+08:00
---

# VSPi v0.6.0 Release Train 讨论摘要

## 用户可见原文

- “OK，你搞一手，Record 那种 nt 问题不管，你把该修复的修复好然后做 Release，然后最后给我一个可以用的安装指令我去我的 Windows 上安装我们 VSPi”

## 已确认需求

- 修复发布所需的 Record Store 与产品问题，完成真实 GitLab Release。
- 最终提供在 Windows 上可执行的 VSPi 安装命令。
- 不发布到公共 npm registry。

## 已作决定

- 真实发布版本为 `v0.6.0`。
- `v0.4.0` Agent Teams 与 `v0.5.0` Persistent Goals 写入 release notes 作为未独立发布的能力里程碑，不创建无法绑定独立可构建提交的历史 tag。
- 发布资产由现有 GitLab CI 从同一已验证 tarball 生成并上传。

## 未决问题

- C12 内无继续执行项；0.6.3 的 Composer、模型目录和 Windows 验收问题转入 C13。

## R7 Windows 启动失败

- 用户原文（Windows PowerShell）：`vspi.cmd` 启动失败，`Error: listen EACCES: permission denied C:\Users\hyx02\.pi\agent\session-leases\...sock`。
- 根因：Windows 上 `net.listen(路径)` 不接受文件系统路径，必须使用 `\\.\pipe\...` named pipe。
- 处理：0.6.1 corrective release 修复 named-pipe lease 并重新走完整发布流程；用户使用 0.6.1 完成 Windows 最终验收。

## R8 Windows TUI 验收反馈

- 用户发现新 TUI 下旧的历史会话刷新机制发生错乱，建议移除不再必要的旧机制。
- 用户发现 permission 切换为 Auto 有时失败，要求修复完整切换路径。
- 用户要求模型优先按代际从新到旧排序；同代模型再按价格从高到低排序。
- 该反馈拒绝了 C12 当前最终结果；R1-R7 的发布证据保持完成，新增 R8 进行定向修订和重新验收。
- 实现决定：fullscreen 以 alt-screen/ScrollView 为 transcript 唯一显示权威，不执行 regular TUI 的 append-only surface epoch 或 committed-history rebase；regular 模式保留原机制。
- 实现决定：Policy runtime 切换成功即生效；可选的 Session 恢复元数据写入失败只显示 warning，不回滚用户选择。
- 实现决定：保留 Provider 分组优先级；组内按显式发布日期或 identity 代际降序，同代按输入与输出 USD 单价之和降序，最后以名称/id 稳定排序。
- 发布决定：0.6.2 只包含 R8 三项修订、测试、文档、版本与语义记录；工作区现有 Provider request compatibility 改动不进入该发布。
- 发布结果：R8-only commit `18a9284`；main pipeline `#368` 与 tag pipeline `#369` 全绿；annotated tag/Release `v0.6.2` 已创建。
- 公开复验：匿名 pinned/latest 资产字节一致，SHA-256 `a3400a01e34a4c76051cce68625a832afdf297675a0269ca79cbc9ff3fd606ad`；clean install 与 Fixture smoke 均为 0.6.2，tarball 不含 Provider compatibility 实现。

## 0.6.3 Windows 验收拒绝与 C13 交接

- 用户拒绝 0.6.3 的 Windows 实机结果：输入框被窄宽字符替换后视觉明显退化，开屏动画消失，更新到最新模型列表后交互严重卡顿。
- 调查确认 0.6.3 将 composer 的圆角 Unicode 边框全局替换为 ASCII `+--+`，并将六行 block-art splash 替换为四行 ASCII Logo；这不是修复光标宽度问题所必需的最小改动。
- 当前 Pi runtime 仍固定为 0.84.1，而 npm 最新稳定版为 0.84.2；模型面板在每帧渲染中多次重新过滤与排序完整模型列表。
- 用户确认 0.6.2 的开屏表现满意，并要求尽量复用 Pi 官方绘图与输入组件；原始性能问题是输入后向左移动光标会卡死。
- 用户选择新建 C13，不继续扩张 C12；Composer 所有权先通过官方/包裹版原型和性能证据讨论，不直接实现。
- 项目级视觉要求继续适用：终端宽度兼容修复不得通过无差别 ASCII 降级破坏已批准的 Unicode 组件和品牌动画。
