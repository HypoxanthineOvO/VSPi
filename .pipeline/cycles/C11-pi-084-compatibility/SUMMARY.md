---
kind: cycle-summary
cycle: C11-pi-084-compatibility
status: closed
updated: 2026-08-09
---

# Pi 0.84 Fullscreen TUI 与 Markdown 增强摘要

## 目的与边界

将 VSPi 升级到 Pi 0.84.1，以 fullscreen 为默认 TUI、regular/main-screen 为兼容回退，并在 upstream Markdown/LaTeX 上增强 Mermaid 与 VSPi 主题呈现。本 Cycle 不采用 RemoteSession、PiClient 或 Agent Core v4，也不发布版本。

## 最终结果

- Pi coding-agent/TUI 统一到 0.84.1，TypeBox 统一到 1.3.7；生产依赖审计为 0 vulnerabilities。
- Fullscreen 使用 `TuiAltScreen`、`ScrollView` 与 `VStack` 拆分可滚动 Transcript 和固定 dock；Settings 可切换 regular、滚动条与 Mermaid 模式，切换保留 Session/draft/focus。
- Regular 保留 static commit、原生 terminal scrollback 与退出恢复；`VSPi_TUI_MODE` 可固定单次启动 renderer。
- Fullscreen tail-follow 最多读取 80 blocks/60K chars；10K 历史测试 indexed reads 小于 500，Inspect 锚点仍使用精确历史索引。
- Markdown 保留 upstream renderer/LaTeX，新增 grok-mermaid 0.2.2 的完成态/流式转换、窄屏与无 Unicode 降级；HTTP(S) 链接点击使用 allowlist 与无 shell launcher。
- Pi 0.84 auth interaction spread 与 brace-expansion 5.0.9 package install 兼容断点已修复。

## 验证证据

- `npm run check` passed。
- `npm test` 在 pretest build 后 110 files / 800 tests passed。
- Fullscreen PTY、regular scrollback PTY、Session handoff 与真实 npm tarball install passed。
- `npm run smoke` passed；`npm audit --omit=dev` 为 0 vulnerabilities；`git diff --check` passed。
- S1 与 Cycle 最终结果均由用户明确接受。

## 重要决定与经验

- Upstream viewport 负责终端滚动交互，VSPi window/cache 继续负责长会话复杂度边界。
- Pi 内部 Mermaid transformer 未公开 export；应用层应依赖公开的 grok-mermaid，而不是穿透 package exports。
- 依赖升级必须验证 class method 经 object spread 的行为语义，不能只依赖 TypeScript interface 兼容。
- Fullscreen 与 regular PTY 必须显式固定 renderer 并分别验证应用内 viewport 和原生 scrollback。

## 后续候选

- RemoteSession、PiClient 与 Agent Core v4 等 upstream protocol 稳定后另开 Cycle 评估。
