import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { spawnReloadChild } = await import("../src/app/reload-launcher.js");

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  spawnMock.mockReturnValueOnce(child);
  return child;
}

describe("spawnReloadChild", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    spawnMock.mockReset();
    process.argv = originalArgv;
  });

  it("spawns vspi continue on the same TTY and keeps the old process as the foreground job", async () => {
    const child = fakeChild();
    const pending = spawnReloadChild();
    expect(spawnMock).toHaveBeenCalledOnce();

    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args[args.length - 1]).toBe("continue");
    // 同 TTY 接管：stdio 全部 inherit，不脱离进程组。
    expect(options).toMatchObject({ stdio: ["inherit", "inherit", "inherit"], detached: false });

    child.emit("spawn");
    await expect(pending).resolves.toBeUndefined();
    // 回归（MR !1，李超凡）：不得 unref。老进程必须作为 shell 前台 job 驻留到 successor
    // 退出，否则 shell 收回 TTY 与 successor 冲突（EIO / 会话炸掉）。
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("does not exempt the successor from the parent-death watchdog", async () => {
    const child = fakeChild();
    const pending = spawnReloadChild();
    // 老进程驻留期间 successor 的 parent 存活，watchdog 不触发；老进程意外崩溃时
    // watchdog 收掉孤儿化的 successor 并把终端还给 shell 是预期自愈路径。
    const options = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options?.env).toBeUndefined();
    child.emit("spawn");
    await expect(pending).resolves.toBeUndefined();
  });

  it("propagates spawn errors", async () => {
    const child = fakeChild();
    const pending = spawnReloadChild();
    child.emit("error", new Error("ENOENT"));
    await expect(pending).rejects.toThrow("ENOENT");
  });
});
