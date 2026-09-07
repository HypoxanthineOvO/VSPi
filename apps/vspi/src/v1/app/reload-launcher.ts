import { spawn } from "node:child_process";

/**
 * /reload 默认启动器：spawn `vspi continue` 接管同一 TTY，本进程随后经 lease handoff 退出。
 *
 * 关键：spawn 后不要 `child.unref()`。本进程必须作为 shell 的前台 job（foreground job）
 * 驻留到 successor 退出：若本进程提前退出，shell 会认为前台 job 结束而收回 TTY、重画
 * 提示符（某些环境还会注入 hooks 字符串），与仍在读 TTY 的 successor 冲突，表现为
 * EIO / 会话炸掉（李超凡报告并修复，MR !1）。ref'd 的 child handle 会在本进程 UI 关闭后
 * 挂住事件循环，实现"驻留到 successor 退出"。
 *
 * 注意：不要给子进程注入 `VSPi_NO_PARENT_WATCHDOG=1`。老进程驻留期间 successor 的
 * parent 一直存活，parent-death watchdog 天然不触发；而若本进程意外崩溃，watchdog 在
 * 宽限期后收掉被收养的 successor、把终端还给 shell，正是预期的自愈路径。
 */
export function spawnReloadChild(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1] ?? "vspi", "continue"], {
      stdio: ["inherit", "inherit", "inherit"],
      detached: false,
    });
    child.once("spawn", () => {
      // Keep the old process alive as the shell's foreground job until the
      // successor exits. Otherwise the shell reclaims the TTY while the
      // successor is still reading it, which can surface as EIO.
      resolve();
    });
    child.once("error", reject);
  });
}
