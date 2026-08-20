---
kind: execution
cycle: C20-compact-error-details
updated: 2026-08-20T20:53:00+08:00
---

# Execution Checkpoints

## 2026-08-20 - Feature 启动

- **观察：** error notice 当前保存并渲染完整字符串；任意输入会清掉 notice，且没有独立详情入口。
- **决定：** 保留完整错误于应用内存，主 notice 改为固定短提示；复用 preview 表面展示详情；新增未占用的 `Ctrl+O` 快捷键。
- **验证目标：** 长错误不会出现在主界面；JSON 可读缩进；详情可打开和关闭；普通 notice 不受影响。

## 2026-08-20 - 实施与验证完成

- **链路修复：** assistant `message_end(stopReason: "error")` 的 `errorMessage` 现在转发到 error notice；`aborted` 不转发。
- **TUI：** error notice 固定为紧凑提示；`Ctrl+O` 打开最近错误详情，`Esc` 关闭；Session reset 清除旧详情。
- **格式化：** 支持完整 JSON、JSON 字符串和最后一个 `data:` marker 后的 JSON suffix；无效 JSON 保留原文。
- **验证：** `test/app-error-recovery.test.ts` + `test/pi-backend.test.ts` 共 26 项通过；interaction/layout/fullscreen 共 18 项通过；`npx tsc --noEmit` 与 Biome 通过。
