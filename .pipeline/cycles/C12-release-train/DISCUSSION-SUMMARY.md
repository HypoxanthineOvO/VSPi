---
kind: discussion-summary
cycle: C12-release-train
updated: 2026-08-09T16:56:25+08:00
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

- 无；用户已明确开始授权。

## R7 Windows 启动失败

- 用户原文（Windows PowerShell）：`vspi.cmd` 启动失败，`Error: listen EACCES: permission denied C:\Users\hyx02\.pi\agent\session-leases\...sock`。
- 根因：Windows 上 `net.listen(路径)` 不接受文件系统路径，必须使用 `\\.\pipe\...` named pipe。
- 处理：0.6.1 corrective release 修复 named-pipe lease 并重新走完整发布流程；用户使用 0.6.1 完成 Windows 最终验收。
