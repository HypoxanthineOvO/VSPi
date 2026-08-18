---
kind: execution
cycle: C18-windows-self-update-spawn
updated: 2026-08-18T00:00:00+08:00
---

# Windows 自更新安装器修复执行记录

## 2026-08-18 - M1 启动

- **现象：** Windows PowerShell、Node.js 24.19.0、VSPi 0.6.1 在更新至 1.1.0 时于 installer 阶段抛出 `spawn EINVAL`。
- **定位：** Release SHA 与 trusted asset 解析已通过；失败点是 Windows 上直接 `execFile("npm.cmd")`。
- **决定：** 用户接受修复并发布补丁版本；v1.1.0 保持不可变。

## 2026-08-18 - M1 完成并进入 M2

- **实现：** `resolvePackageInstaller` 接受可测试 platform；Windows npm 使用环境 `ComSpec`/`COMSPEC`，缺失时 fallback `cmd.exe`，参数为 `/d /s /c npm.cmd install --global --no-audit --no-fund <tarball>`。Volta 继续直启 `volta.exe`，非 Windows 继续直启 `npm`。
- **依据：** Node 官方文档明确 `.cmd` 不能由 `execFile` 直启，并列出 spawn `cmd.exe` + `.cmd` 参数作为支持方式；不使用已弃用风险的 `shell:true`。
- **验证：** updater 11/11；`npm run check`；完整 129 files / 954 tests；实际 package install；333-file verifier；production audit 0 vulnerabilities。
- **发布候选：** v1.1.1 tarball SHA-256 `2600961bb954d936cc72ce6619f6d21d5bdb094808cdc88acc6fbd56f85bb7dc`。

## 2026-08-18 - M2 完成与 v1.1.1 发布

- **提交与 tag：** `3cd4aee`，annotated tag `v1.1.1` 已推送 GitLab/GitHub。
- **Release：** GitLab/GitHub 均发布 pinned、latest、SHA256SUMS 三个资产，GitHub Release workflow 全部成功。
- **资产一致性：** GitHub runner 重建 tarball 因环境差异产生不同压缩字节；用已通过本机完整门禁的三项候选资产 clobber GitHub assets。最终两平台 latest 内容完全一致，SHA-256 均为 `2600961bb954d936cc72ce6619f6d21d5bdb094808cdc88acc6fbd56f85bb7dc`。
- **真实更新：** 本机 VSPi 1.1.0 通过 GitLab latest API、SHA 校验和 npm installer 成功升级至 1.1.1，安装后版本核验通过。
- **Windows 边界：** Windows 专用 `ComSpec → npm.cmd` 由平台注入 contract tests 覆盖；最终实机确认由原报告机器重试 `vspi update` 完成。
