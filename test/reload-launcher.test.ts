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

  it("spawns vspi continue on the same TTY with the watchdog disabled", async () => {
    const child = fakeChild();
    const pending = spawnReloadChild();
    expect(spawnMock).toHaveBeenCalledOnce();

    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args[args.length - 1]).toBe("continue");
    // 同 TTY 接管：stdio 全部 inherit，不脱离进程组。
    expect(options).toMatchObject({ stdio: ["inherit", "inherit", "inherit"], detached: false });
    // 回归：老进程退出后子进程会被 init 收养（ppid→1），必须豁免 parent-death watchdog，
    // 否则 10s 宽限期后续接会话被误杀（李超凡报告的 /reload 会话炸掉）。
    expect(options.env).toMatchObject({ VSPi_NO_PARENT_WATCHDOG: "1" });
    expect(options.env).not.toBe(process.env);

    child.emit("spawn");
    await expect(pending).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("propagates spawn errors", async () => {
    const child = fakeChild();
    const pending = spawnReloadChild();
    child.emit("error", new Error("ENOENT"));
    await expect(pending).rejects.toThrow("ENOENT");
  });
});
