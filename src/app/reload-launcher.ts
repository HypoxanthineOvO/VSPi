import { spawn } from "node:child_process";

/**
 * /reload 默认启动器：spawn `vspi continue` 接管同一 TTY，本进程随后经 lease handoff 退出。
 *
 * 关键：必须给子进程注入 `VSPi_NO_PARENT_WATCHDOG=1`。子进程的 parent 是本进程，
 * lease 移交后本进程退出，子进程随即被 init 收养（ppid→1）。parent-death watchdog
 * 无法区分"launcher 意外死亡"与"/reload 预期孤儿化"，若不禁用会在 10s 宽限期后
 * 把续接会话误杀——表现为 /reload 后约 10–12 秒会话退出（李超凡报告的 reload 不稳定）。
 */
export function spawnReloadChild(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1] ?? "vspi", "continue"], {
      stdio: ["inherit", "inherit", "inherit"],
      detached: false,
      env: { ...process.env, VSPi_NO_PARENT_WATCHDOG: "1" },
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}
