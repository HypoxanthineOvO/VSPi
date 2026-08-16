---
kind: progress
cycle: C13-pi-editor-latency-repair
plan: PLAN.md
status: closed
updated: 2026-08-16T18:29:19+08:00
current: complete
next: 无；C13 已由用户接受并关闭
---

# Pi Editor 与模型目录性能修订进度

## 当前状态

M1-M4、S1 与 S2 全部完成并由用户接受。最终候选修复 fullscreen cursor 可见帧、模型目录与选择流程，删除 SSH Attachment Bridge，默认 Policy 改为 Auto，并完成 Question、动态模型标签、自适应 Model/Provider 高度与 OpenCode Go 目录修订。C13 已关闭；未创建 tag、Release 或远端发布。

## 完整计划状态

| ID | 阶段 | 状态 | 当前结果 / 证据 | 下一步 |
| --- | --- | --- | --- | --- |
| `M1` | 官方 Editor 与 0.6.2 包裹版原型 | `completed` | 64 列真实产物已比较；10K/120 左移+重绘：baseline 1494ms，grapheme+layout cache 原型 7.1ms（211.9x） | S1 |
| `S1` | Composer 所有权审阅 | `completed` | 用户选择 0.6.2 圆角 hybrid，同时要求采用更快渲染算法 | M2 |
| `M2` | Pi Editor 与 fullscreen 帧修订 | `completed` | 删除 `renderRevision/renderSectionsCache`；端到端回归验证仅输入左键即可改变 fullscreen cursor marker 和完整可见帧；300 消息 + 10K 输入完整 section 重建约 1.03ms/次 | M3 |
| `M3` | 模型目录、Question 与产品清理 | `completed` | `/model` 使用动态 body rows 且高终端 cap=24；wide Provider 同类固定 5 行已修；OpenCode Go 全量 catalog 19/19 可见；model→Effort 两阶段交互及 lookup fallback 已验证 | M4 |
| `M4` | 全量终端与发布门禁 | `completed` | package/lock 均为 0.6.4；check 通过；116 files / 868 tests；全量内含 PTY；pack verify 291 files；临时安装、Volta/PATH smoke 与安装产物 OpenCode Go 19/19 探针通过 | S2 |
| `S2` | 本机最终验收 | `completed` | 用户第三轮明确选择“接受并关闭 C13”；接受高终端 Model/Provider、OpenCode Go、Model→Effort 及此前 corrective 结果 | 无 |

## 阻塞

- 无。

## 下一步

无；后续 1.0/GitHub 发布准备应另开独立 Cycle，不改写 C13 的已接受范围。
