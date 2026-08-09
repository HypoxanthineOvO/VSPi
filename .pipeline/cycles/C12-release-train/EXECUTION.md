---
kind: execution-log
cycle: C12-release-train
updated: 2026-08-09T16:56:25+08:00
---

# VSPi v0.6.0 Release Train 执行记录

## 2026-08-09 - R1 发布边界与 Goal 建立

- **计划项：** `R1`
- **目的：** 将 `v0.3.11` 后已接受能力整理为真实可安装的发布边界。
- **结果：** 选择当前完整状态作为 `v0.6.0`；`v0.4.0` Agent Teams 与 `v0.5.0` Persistent Goals 作为未独立发布的能力里程碑，不创建虚假追溯 tag；公共 npm 不在发布渠道内。
- **证据：** Git 仅有一个混合产品提交和后续 dirty changes，缺少两个独立可构建历史提交；用户已授权修复、Release 与 Windows 安装交付。
- **计划影响：** 无。
- **遇到的问题：** Record Store 中 C07 corrective decision 的 id/hash 与 durable content 不一致，进入 R2 修复。
- **下一步：** `R2`。

## 2026-08-09 - R2 完整性与版本准备

- **计划项：** `R2`
- **目的：** 修复语义 Record、版本元数据、发布说明和安装表面。
- **结果：** C07 corrective decision 迁移到正确 durable identity `decision-edcc60dc...`，保留正文、来源和 supersedes；Core 成功重建 128 条 Record。package/lock 提升到 0.6.0；新增 Fullscreen Runtime release notes、Windows PowerShell 安装说明和 GitLab Release notes 注入；包白名单允许已声明的 testing/debugging 文档。
- **证据：** Core rebuild 128；package/lock/root package 版本均为 0.6.0；4 files / 16 targeted tests passed；`git diff --check` passed。
- **计划影响：** 无。
- **遇到的问题：** 删除保护拒绝 delete+add 形式，改用无数据丢失的受控 Record rename。
- **下一步：** `R3`。

## 2026-08-09 - R3 本地发布门禁

- **计划项：** `R3`
- **目的：** 以源码、终端、安全和真实安装四层门禁验证发布候选。
- **结果：** check、全量测试、build、smoke、独立 PTY、80×40 terminal trace、audit、pack、包白名单、SHA-256 与空目录安装均通过。
- **证据：** 113 files / 827 tests；PTY 3 files / 11 tests；terminal trace 28 frames / 0 violations；audit 0 vulnerabilities；tarball 287 files / 465160 bytes / SHA-256 `638b6fb1e3d9d6380013ca9c0130bedae292aa2b2a69b722a4d8b95f3cd7d3bf`；安装后 `vspi --version` 为 0.6.0。
- **计划影响：** 无。
- **遇到的问题：** 首次 check 发现 release payload 格式问题并修复；打包后摘要脚本误读 pack JSON 数组，但 package/install 已成功，修正摘要读取后 checksum 再次通过。
- **下一步：** `R4`。

## 2026-08-09 - R4 主线 CI 第一次运行

- **计划项：** `R4`
- **目的：** 验证 commit `1b665635` 的主线发布候选。
- **结果：** pipeline `#347` 的 quality 通过，test 为 112 files / 826 tests passed、1 failed；package/install 因 test failure 正确跳过。
- **证据：** 唯一失败为 `agents-security.test.ts` 的真实 bubblewrap sandbox 回归；锁定 CI 镜像缺少 `/usr/bin/bwrap`。
- **计划影响：** R4 保持 in progress；新增不可变 CI 镜像 `22.22.0-3`，精确安装 Debian bubblewrap 0.8.0-2+deb12u1。
- **遇到的问题：** 本地环境已安装 bwrap，原本未暴露 CI 镜像依赖缺口。
- **下一步：** 构建并验证新镜像，更新 digest 后重跑主线 pipeline。

## 2026-08-09 - R4 CI 镜像发布

- **计划项：** `R4`
- **目的：** 为真实 Subagent sandbox 回归提供不可变 CI 依赖。
- **结果：** `ci-node:22.22.0-3` 已发布并锁定 digest；普通非 privileged Docker 中 bwrap 在 namespace 边界 fail closed，宿主与容器两种路径的安全测试均 3/3 通过。
- **证据：** image digest `sha256:851dd7ad97ef3937761bdff450e349c08ac5d173e9b7ecc1bb01ca875c40f491`；bubblewrap 0.8.0、fd 10.4.2、rg 15.1.0。
- **计划影响：** `.gitlab-ci.yml` 切换到新 digest。
- **遇到的问题：** Docker runner 不允许嵌套 user namespace；测试契约接受命令执行前的 namespace fail-closed，同时继续要求控制文件字节不变。
- **下一步：** 提交并推送 CI digest，等待新 main pipeline。
