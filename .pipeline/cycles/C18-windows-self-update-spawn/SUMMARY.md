---
kind: cycle-summary
cycle: C18-windows-self-update-spawn
status: closed
version: v1.1.1
closed: 2026-08-18T14:04:00+08:00
---

# C18 Windows 自更新安装器修复总结

## 结论

Windows npm 自更新不再直接 `execFile("npm.cmd")`，而是通过环境 `ComSpec`
（缺失时 `cmd.exe`）执行 `.cmd`，修复 Node.js 24 的 `spawn EINVAL`。Volta 与
非 Windows npm 路径保持原行为。

## 验证

- updater 11/11，完整 129 files / 954 tests，`npm run check` 全部通过。
- 实际 package install、333-file verifier、production audit 通过。
- 本机真实 VSPi 1.1.0 → 1.1.1 自更新成功。
- Windows 专用 invocation 通过 ComSpec 与 fallback 深比较；仍需原 Windows
  机器执行一次实机复核。

## 发布

tag `v1.1.1` 指向 `3cd4aee`。GitLab/GitHub Release 均包含 pinned、latest、
SHA256SUMS；两个 latest 内容一致，SHA-256 为
`2600961bb954d936cc72ce6619f6d21d5bdb094808cdc88acc6fbd56f85bb7dc`。
