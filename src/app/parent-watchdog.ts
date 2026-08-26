export interface ParentDeathWatchdogOptions {
  /** Poll interval for the launcher PID. */
  intervalMs?: number;
  /** Grace period after startup before the first check. */
  initialGraceMs?: number;
  /** TTY check; defaults to stdin being an interactive TTY. */
  isTtyAttached?: () => boolean;
  /** Injectable PID reader for tests; defaults to process.ppid. */
  readPpid?: () => number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Force-disable the watchdog. */
  disabled?: boolean;
}

/**
 * Exit the interactive TUI when its launcher process disappears. The C13 freeze
 * incident left VSPi orphaned under init while the shell stayed blocked writing
 * to the PTY; a parent-death watchdog restores the terminal by shutting down
 * instead of idling with a dead launcher. Only active when stdin is a real TTY
 * and can be disabled with VSPi_NO_PARENT_WATCHDOG=1.
 *
 * /reload 的老进程会作为前台 job 驻留到 successor 退出（见 spawnReloadChild），
 * 因此续接进程的 parent 不会变 1，watchdog 不会误杀；老进程意外崩溃时 watchdog
 * 收掉孤儿化的续接进程、把终端还给 shell，是预期自愈路径，不要为 reload 注入豁免。
 */
export function startParentDeathWatchdog(
  onParentDeath: () => void,
  options: ParentDeathWatchdogOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 2_000;
  const initialGraceMs = options.initialGraceMs ?? 10_000;
  const ttyAttached = options.isTtyAttached ?? (() => Boolean(process.stdin.isTTY));
  const readPpid = options.readPpid ?? (() => process.ppid);
  const now = options.now ?? (() => Date.now());
  if (options.disabled ?? process.env.VSPi_NO_PARENT_WATCHDOG === "1") return () => {};
  if (!ttyAttached()) return () => {};
  const initialParent = readPpid();
  if (initialParent === 1) return () => {};

  const startedAt = now();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (now() - startedAt < initialGraceMs) return;
    if (readPpid() === 1 && readPpid() !== initialParent) {
      stopped = true;
      clearInterval(timer);
      onParentDeath();
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
