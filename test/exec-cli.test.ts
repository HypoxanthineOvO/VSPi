import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseExecArguments, runExec } from "../src/cli/exec.js";

describe("parseExecArguments", () => {
  it("解析新会话 prompt（多段 argv 合并）", () => {
    expect(parseExecArguments(["修复", "登录", "bug"])).toEqual({ prompt: "修复 登录 bug" });
  });

  it("resume 关键字族：resume / continue / -c / --continue 均续接最近会话", () => {
    for (const keyword of ["resume", "continue", "-c", "--continue", "--resume"]) {
      expect(parseExecArguments([keyword, "继续刚才的任务"])).toEqual({
        prompt: "继续刚才的任务",
        resume: "latest",
      });
    }
  });

  it("resume <id> <prompt> 续接指定会话", () => {
    expect(parseExecArguments(["resume", "abc123", "继续刚才的任务"])).toEqual({
      prompt: "继续刚才的任务",
      resume: { id: "abc123" },
    });
  });

  it("resume latest <prompt> 是显式的最近会话", () => {
    expect(parseExecArguments(["resume", "latest", "继续刚才的任务"])).toEqual({
      prompt: "继续刚才的任务",
      resume: "latest",
    });
  });

  it("全局 flag 从任意位置剥离，不影响 prompt", () => {
    expect(parseExecArguments(["--policy", "YOLO", "--trust-project", "跑一次"])).toEqual({ prompt: "跑一次" });
    expect(parseExecArguments(["跑一次", "--recovery"])).toEqual({ prompt: "跑一次" });
    expect(parseExecArguments(["--policy=Standard", "跑一次", "--workflow"])).toEqual({ prompt: "跑一次" });
  });

  it("缺少 prompt 与裸 resume 都报用法错误", () => {
    expect("error" in parseExecArguments([])).toBe(true);
    expect("error" in parseExecArguments(["resume"])).toBe(true);
    expect("error" in parseExecArguments(["resume", "latest"])).toBe(true);
  });
});

describe("runExec（fixture 后端）", () => {
  const previousFixture = process.env.VSPi_FIXTURE;
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];

  beforeEach(() => {
    process.env.VSPi_FIXTURE = "1";
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    if (previousFixture === undefined) delete process.env.VSPi_FIXTURE;
    else process.env.VSPi_FIXTURE = previousFixture;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("新会话执行并把最终 assistant 文本写到 stdout", async () => {
    await runExec(["你好，fixture"]);
    const output = stdoutChunks.join("");
    expect(output).toContain("Fixture 回应");
    expect(output).toContain("你好，fixture");
    expect(process.exitCode).toBeUndefined();
  });

  it("resume latest 在没有历史会话时降级为新会话并正常执行", async () => {
    await runExec(["resume", "第一句话"]);
    const output = stdoutChunks.join("");
    expect(output).toContain("Fixture 回应");
    expect(process.exitCode).toBeUndefined();
  });

  it("resume 指定 id 找不到会话时报错并以非零退出", async () => {
    await runExec(["resume", "missing-id", "继续"]);
    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("找不到会话 missing-id");
  });

  it("用法错误输出到 stderr 并返回退出码 2", async () => {
    await runExec([]);
    expect(process.exitCode).toBe(2);
    expect(stderrChunks.join("")).toContain("用法：vspi exec");
  });
});
