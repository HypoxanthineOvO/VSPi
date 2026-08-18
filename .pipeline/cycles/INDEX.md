---
kind: cycle-index
status: active
---

# Cycle 索引

## Active Cycles

| Cycle | 名称 | 状态 | 建立于 |
| --- | --- | --- | --- |
| - | - | - | - |

## Closed Cycles

| Cycle | 名称 | 状态 | 关联 Delivery | 版本 |
| --- | --- | --- | --- | --- |
| [C18-windows-self-update-spawn](C18-windows-self-update-spawn/SUMMARY.md) | Windows 自更新安装器修复 | closed（补丁发布完成，等待 Windows 实机复核） | - | v1.1.1 |
| [C17-prompt-cache-deepseek-adaptation](C17-prompt-cache-deepseek-adaptation/SUMMARY.md) | 前缀缓存与 DeepSeek Harness 适配 | closed（S1/S2 接受，双平台发布完成） | - | v1.1.0 |
| [C16-render-performance-repair](C16-render-performance-repair/SUMMARY.md) | 渲染性能修复（对标 Codex） | closed（用户接受 regular 为默认；Markdown 回归已修复） | - | - |
| [C15-render-algorithm-performance-audit](C15-render-algorithm-performance-audit/AUDIT.md) | 渲染算法性能审计 | closed（用户接受审计结论，修复进 C16） | - | - |
| [C14-streaming-render-regression](C14-streaming-render-regression/SUMMARY.md) | Streaming 渲染体感回归 | closed（用户接受基本可用线） | - | v1.0.0 |
| [C13-pi-editor-latency-repair](C13-pi-editor-latency-repair/SUMMARY.md) | Pi Editor 与模型目录性能修订 | closed（用户接受） | - | v0.6.4 candidate |
| [C12-release-train](C12-release-train/SUMMARY.md) | VSPi v0.6.x Release Train | closed（0.6.3 未接受） | - | v0.6.0-v0.6.3 |
| [C01-tui-v1](C01-tui-v1/SUMMARY.md) | VSPi TUI v1 主线 | closed | vspi-tui-v1 | v0.1.0 |
| [C02-v0-1-0-usability](C02-v0-1-0-usability/SUMMARY.md) | VSPi v0.1.0 本地日用版本 | closed | vspi-v0-1-0-usability | v0.1.0 |
| [C03-v0-2-0-workflow-integration](C03-v0-2-0-workflow-integration/SUMMARY.md) | VSPi v0.2.0 Workflow 集成 | closed | vspi-v0-2-0-workflow-integration | v0.2.0 |
| [C04-live-run-control](C04-live-run-control/SUMMARY.md) | VSPi Goal 运行控制 | closed | vspi-live-run-control | v0.2.0 |
| [C05-subagent-teams-goal](C05-subagent-teams-goal/SUMMARY.md) | Subagent 与 Teammate 能力（Goal 交付） | closed | vspi-subagent-teams-goal | 0.3.11 |
| [C06-terminal-mock-recovery](C06-terminal-mock-recovery/SUMMARY.md) | 终端 Mock 与 Recovery 工具链 | closed | vspi-terminal-mock-recovery | 0.3.x |
| [C07-subagent-teams](C07-subagent-teams/SUMMARY.md) | Subagent/Teammate corrective Plan | closed | vspi-subagent-teams（legacy 只读） | - |
| [C10-history-refresh-repair](C10-history-refresh-repair/SUMMARY.md) | History Refresh 语义结构修复 | closed | - | - |
| [C11-pi-084-compatibility](C11-pi-084-compatibility/SUMMARY.md) | Pi 0.84 fullscreen TUI 与 Markdown 增强 | closed | - | - |
| [C09-ui-rendering-fixes](C09-ui-rendering-fixes/SUMMARY.md) | 终端渲染与历史浏览修复 | closed | - | - |
| [C08-persistent-goal-runner](C08-persistent-goal-runner/SUMMARY.md) | 持久 Goal Runner 与终端瀑布修订 | closed | vspi-persistent-goal-runner（legacy 只读） | - |

## 说明

- 历史 Cycle 依据已接受 Delivery 对象重建，遵循决策 `decision-742e1882`（不捏造接受记录）。
- Legacy Delivery 对象保持原始状态不回写；当前完成度以语义 Cycle 与 fresh 验证证据为准。
