---
kind: cycle-summary
cycle: C13-pi-editor-latency-repair
status: closed
updated: 2026-08-16T18:29:19+08:00
---

# Pi Editor 与模型目录性能修订摘要

## 目的与边界

修复 v0.6.4 候选中长输入 cursor 的真实可见帧冻结，保持 0.6.2 圆角 Composer 与 Pi Editor 输入所有权；同步收口模型目录、Question、SSH Attachment Bridge、默认 Policy 和本机发布候选验证。本 Cycle 不创建 tag、Release 或远端发布。

## 最终结果

- 删除 VSPi 跨帧整页 render cache，恢复 Pi immediate render 与 differential output；fullscreen 左右 cursor 可见帧即时更新。
- 保留 Pi 0.84.2 Editor 局部性能补丁及版本/源码守卫；startup、Goal、handoff 与默认模型的可见模型标签同步刷新。
- 删除 SSH Attachment Bridge 服务、CLI、通知、设置、文档与测试；保留本地附件和 SSH 安全审批/Provider 认证。
- 普通默认 Policy 改为 Auto，Recovery 仍强制 Standard；Question Review 主提交操作提高对比度。
- 启动强制 remote model catalog refresh，1 秒超时并降级 local store；OpenCode Go 全量跟随 Pi catalog，本机 19/19 可见。
- Model/Provider 面板使用动态高度；高终端 Model cap 为 24；模型选择后进入 Effort，确认后关闭。
- package/lock/CLI 均为 0.6.4，旧本机 wrapper 已修复并由 Volta 候选替换。

## 验证证据

- `npm run check` passed；`git diff --check` passed。
- 最终全量 116 files / 868 tests passed，包含 fullscreen、regular、PTY、handoff、package install 与 interaction contracts。
- 300 messages + 10K input 的完整 section render 约 1.03ms；cursor-only fullscreen frame 回归 passed。
- CI-style package verify 为 291 files；空目录安装、Fixture smoke、Volta/PATH 0.6.4 复验 passed。
- 真实本机 Pi runtime 与安装产物 OpenCode Go 均为 available 19 / visible 19。
- 用户第三轮 S2 明确接受并关闭 C13。

## 剩余风险与后续

- Pi Editor patch 固定于 0.84.2；Pi family 升级时必须重新审计或删除补丁。
- remote catalog 每次启动强制网络，但等待上限为 1 秒且失败使用 local models-store。
- Harness read-only 报告 5 个 upstream ref 变化、0 diagnostics；公共 1.0 发布前应独立复核。
- 1.0/GitHub、`vspi init` 语义、搜索与公共文档属于后续独立 Cycle。
