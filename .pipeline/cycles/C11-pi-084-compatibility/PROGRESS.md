---
kind: progress
cycle: C11-pi-084-compatibility
plan: PLAN.md
status: closed
updated: 2026-08-09T12:05:00+08:00
current: complete
next: 无；C11 已接受并关闭
---

# Pi 0.84 TUI 迁移与 Markdown 增强进度

## 当前状态

Cycle 最终结果已由用户接受，C11 已关闭。

## 完整计划状态

| ID | 阶段 | 状态 | 当前结果 / 证据 | 下一步 |
| --- | --- | --- | --- | --- |
| `M1` | 建立 0.82.1→0.84.1 兼容基线 | `completed` | Pi/coding-agent/tui 0.84.1、TypeBox 1.3.7 单一依赖树；check 与 49 个定向测试通过 | 自动进入 M2 |
| `M2` | 建立 dual TUI shell | `completed` | `TuiAltScreen` + `ScrollView`/`VStack` 独立 transcript/dock；Settings 可切换 renderer/scrollbar | 自动进入 M3 |
| `M3` | 完成 fullscreen 与性能适配 | `completed` | PageUp/Home/End/wheel 与固定 dock contract 通过；10k tail indexed reads <500；regular static commit 保留 | 自动进入 M4 |
| `M4` | 增强 Markdown 呈现 | `completed` | upstream Markdown/LaTeX + grok-mermaid 0.2.2；task/table/link/code/公式/图表/降级/streaming fixtures 通过 | 进入 S1 |
| `S1` | Fullscreen 与 Markdown 真实产物审阅 | `completed` | 用户接受默认 fullscreen、regular fallback 与 Markdown 产物 | 自动进入 M5 |
| `M5` | 完成回归、文档与交付证据 | `completed` | check；build；110 files/800 tests；fullscreen+regular PTY；tarball install；smoke；prod audit 0 vulnerabilities | 提交最终审阅 |

## 已知事实

- 升级前 VSPi 依赖 Pi 0.82.1；本 Cycle 已迁移到 0.84.1。
- 0.83.0 升级 TypeBox 并移除多项 deprecated API；VSPi 未直接使用被移除 API，但 direct `typebox@1.1.38` 会与 Pi 0.84.1 的 1.3.7 产生泛型类型冲突。
- 0.84.0 将 Pi TUI 的 `TUI` 运行类拆为 `TUI` interface、`TuiBase`、`TuiMainScreen`、`TuiAltScreen`；VSPi 的 `ScrollbackTUI extends TUI` 等调用会编译失败。
- upstream fullscreen 使用 alt screen、`ScrollView` 与固定 dock，但不是长历史虚拟化；VSPi 的 window/cache/Inspect 仍是必要性能层。
- RemoteSession、PiClient 与 agent-core v4 仍为 experimental，本 Cycle 明确暂缓。

## 下一步

无。
