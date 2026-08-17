---
kind: cycle-summary
cycle: C17-prompt-cache-deepseek-adaptation
status: closed
version: v1.1.0
closed: 2026-08-17T23:51:00+08:00
---

# C17 前缀缓存与 DeepSeek Harness 适配总结

## 结论

C17 已完成并发布为 VSPi 1.1.0。Cache accounting、Speed、compaction Context
恢复、assistant 输出层级、稳定 prompt、按需 continuity status 与人民币价格口径
已进入产品。direct/relay DeepSeek V4 Pro/Flash 默认启用 anchored-standard，保留
`VSPI_DEEPSEEK_HARNESS=0` 关闭开关。

## DeepSeek 边界

每个 cache epoch 首请求使用固定 persona 与 `bash`、`str_replace_editor`，promotion
后恢复完整 VSPi/Pi prompt、工具、AGENTS、skills 与 profile。双工具继续经过
Policy/Approval 与单写者边界；editor 强制 workspace/symlink containment，persistent
bash 支持实时 streaming、秒制 timeout、abort/timeout 进程组清理和有界输出缓冲。

## 验证与发布

- `npm run check` 通过；完整 129 files / 952 tests 通过。
- direct DeepSeek V4 Pro/Flash paired A/B、双工具和 resume 实测通过。
- 实际 tarball 空项目安装、bin smoke 与 production dependency audit 通过。
- tag `v1.1.0` 指向 `eb0edf7`；GitLab/GitHub Release 均包含 pinned、latest 与
  checksum 三个资产。
- 两个平台 latest 下载内容一致，SHA-256 为
  `17fd11362494dc6ebcd2e9cae404b974e1f3681a3e29680eee2707a4558bf199`。

## 发布事件

GitHub tag workflow 首次因 verifier 未允许依法新增的 `THIRD_PARTY_NOTICES.md`
而失败；Release 使用同一 verified assets 手工完成。`47f48b9` 已修复 verifier，
本机按 workflow 原命令验证 333 个包文件和 release/package 测试通过。

README 由用户使用本机 VSPi 1.1.0 重写为简洁产品入口；按用户反馈，README
不再由静态测试锁定，详细交互契约继续由 `Docs/tui-v1.md` 与行为测试维护。
