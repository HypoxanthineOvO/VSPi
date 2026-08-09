---
kind: plan
cycle: C11-pi-084-compatibility
status: closed
mode: plan
updated: 2026-08-09
progress: PROGRESS.md
execution: EXECUTION.md
---

# Pi 0.84 TUI 迁移与 Markdown 增强计划

## 执行目的

将 VSPi 从 `@earendil-works/pi-*` 0.82.1 迁移到 0.84.1，以 upstream fullscreen viewport 为主 TUI，并保留 regular/main-screen 回退；在 upstream Markdown/LaTeX/Mermaid 能力上延续 VSPi 的 Box、主题与窗口化性能控制。

## 执行边界

- 覆盖 Pi coding-agent、TUI、TypeBox 的兼容迁移，以及 fullscreen/regular renderer、布局、输入、overlay、历史浏览、终端恢复和 Markdown 呈现。
- VSPi 默认使用 fullscreen；regular/main-screen 保留为用户设置与兼容回退，并继续使用原生终端 scrollback。
- 保留 transcript window、render cache 和 Inspect 逻辑；upstream `ScrollView` 负责 viewport/滚动交互，不承担长历史虚拟化。
- 保留现有 Box、Question/Approval、Panels、Composer 和主题语言，按 transcript surface 与 dock surface 重组，不重做产品视觉。
- 本 Cycle 不采用或试验 RemoteSession、PiClient、pi-agent-core v4、AgentHarness v2、Provider 新功能和 Session Handoff 替换；这些内容等待 upstream protocol 稳定后另议。
- 不发布版本；Stone 接受后完成回归、文档与交付证据。

## 验证目标

- 依赖树统一到 Pi 0.84.1 与 TypeBox 1.3.7，不存在重复 TypeBox 导致的 `ToolDefinition` 类型身份冲突。
- fullscreen 中 transcript 独立滚动，queued/activity/panel dock、Composer 与 status 稳定；regular 中原生 scrollback、静态提交和退出恢复不回退。
- 长历史不会因为 upstream `ScrollView` 的全量 child render 而移除现有 window/cache 边界；Inspect 可继续访问窗口外历史。
- LaTeX、Mermaid 与普通 Markdown 在 VSPi 主题、Box、表格、代码块和窄终端下正确呈现，不发生后处理误判或布局溢出。
- 40/80/120 列、鼠标/键盘滚动、模式切换、overlay、图片降级与真实终端退出均有验证证据。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 建立 0.82.1→0.84.1 兼容基线 | 升级 Pi 包与 TypeBox，迁移 `TUI` class→`TuiMainScreen`/`TuiAltScreen`/interface 编译断点，保持既有 backend 行为 | `npm ls` 无重复/invalid 依赖；`npm run check` 通过；breaking-change contract tests 覆盖关键 SDK 边界 |
| `M2` | 建立 dual TUI shell | 将单体 `VspiApp.render()` 重组为可复用 transcript surface 与 dock surface；接入 upstream renderer 切换，Box、Panels、Composer 与 overlay 继续复用 | component/layout 测试覆盖 fullscreen/regular、焦点、surface 高度和切换状态保留；40/80/120 snapshot 稳定 |
| `M3` | 完成 fullscreen 与性能适配 | fullscreen 使用 upstream `ScrollView`、`VStack`、滚动条、鼠标/键盘导航和固定 dock；保留 VSPi transcript window/cache/Inspect，regular 保留静态提交与原生 scrollback | 长历史与 streaming 性能回归；Inspect、PageUp/PageDown、鼠标滚动、overlay、模式切换、PTY 与退出恢复测试通过 |
| `M4` | 增强 Markdown 呈现 | 接入 upstream LaTeX、Mermaid 与 display transformer，在其上保留 VSPi 标题、列表、表格、代码块、Box 和主题处理 | fixture 覆盖公式、矩阵、Mermaid、表格/图形边框冲突、streaming、窄终端、无 Unicode/颜色降级与缓存失效 |
| `S1` | Fullscreen 与 Markdown 真实产物审阅 | 用户看到 Pi 0.84.1 fullscreen 下的 VSPi：长 transcript 滚动、固定 dock、现有 Box/Panel、Inspect、regular 切换，以及 LaTeX/Mermaid 示例 | 接受标准：视觉与交互符合 VSPi 规范；长历史无明显卡顿；regular 回退和退出恢复正常；Markdown 无溢出或误判 |
| `M5` | 完成回归、文档与交付证据 | 处理 S1 接受后的收尾，记录 TUI 模式、Markdown 设置、兼容性和明确暂缓项，通过全量质量门禁 | `npm run check`、`npm test`、`npm run build`、`npm run smoke`、PTY/terminal mock 与真实终端 smoke 通过 |

ID 在本 Cycle 内保持稳定。
