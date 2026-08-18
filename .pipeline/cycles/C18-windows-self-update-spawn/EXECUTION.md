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
