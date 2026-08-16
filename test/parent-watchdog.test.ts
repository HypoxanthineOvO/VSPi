import { afterEach, describe, expect, it, vi } from "vitest";
import { startParentDeathWatchdog } from "../src/app/parent-watchdog.js";

afterEach(() => {
  vi.useRealTimers();
  delete process.env.VSPi_NO_PARENT_WATCHDOG;
});

describe("startParentDeathWatchdog", () => {
  it("stays inert without an interactive TTY", () => {
    const onParentDeath = vi.fn();
    const stop = startParentDeathWatchdog(onParentDeath, {
      isTtyAttached: () => false,
      readPpid: () => 1,
    });
    stop();
    expect(onParentDeath).not.toHaveBeenCalled();
  });

  it("respects the startup grace period before reacting to parent death", () => {
    vi.useFakeTimers();
    let ppid = 123;
    const onParentDeath = vi.fn();
    startParentDeathWatchdog(onParentDeath, {
      isTtyAttached: () => true,
      readPpid: () => ppid,
      intervalMs: 10,
      initialGraceMs: 100,
    });
    ppid = 1;
    vi.advanceTimersByTime(50);
    expect(onParentDeath).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onParentDeath).toHaveBeenCalledTimes(1);
  });

  it("fires when the launcher disappears and stop() disarms it", () => {
    vi.useFakeTimers();
    let ppid = 123;
    const onParentDeath = vi.fn();
    const stop = startParentDeathWatchdog(onParentDeath, {
      isTtyAttached: () => true,
      readPpid: () => ppid,
      intervalMs: 10,
      initialGraceMs: 0,
    });
    ppid = 1;
    vi.advanceTimersByTime(10);
    expect(onParentDeath).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(100);
    expect(onParentDeath).toHaveBeenCalledTimes(1);
  });

  it("can be disabled through the environment", () => {
    process.env.VSPi_NO_PARENT_WATCHDOG = "1";
    const onParentDeath = vi.fn();
    const stop = startParentDeathWatchdog(onParentDeath, {
      isTtyAttached: () => true,
      readPpid: () => 1,
      intervalMs: 10,
    });
    stop();
    expect(onParentDeath).not.toHaveBeenCalled();
  });
});
