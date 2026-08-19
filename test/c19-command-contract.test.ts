import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ACTION_REGISTRY, describeCommandsForPrompt } from "../src/domain/commands.js";
import { VSPI_LANGUAGE_CONTRACT } from "../src/prompts/pi-prompt-profile-extension.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

describe("C19 command contract for prompts", () => {
  it("lists every enabled canonical command from the registry", () => {
    const contract = describeCommandsForPrompt();

    for (const action of ACTION_REGISTRY) {
      if (action.availability !== "enabled") continue;
      expect(contract).toContain(`${action.label}：${action.description}`);
    }
  });

  it("stays in sync: every registry label appears, no stale labels survive", () => {
    const contract = describeCommandsForPrompt();
    const listed = ACTION_REGISTRY.filter((action) => action.availability === "enabled");

    for (const action of listed) expect(contract).toContain(action.label);
    // 注册表删除命令后，契约不应再宣传它（以一个从未存在过的命令为代表）。
    expect(contract).not.toContain("/wsl-fix");
  });

  it("warns that upstream pi docs do not describe VSPi", () => {
    const contract = describeCommandsForPrompt();

    expect(contract).toContain("VSPi 与上游 pi coding agent CLI 是不同产品");
    expect(contract).toContain("不适用于 VSPi");
    expect(contract).toContain("不得据此向用户推荐");
    expect(contract).toContain("不要建议用户输入清单外的命令");
  });

  it("guides configuration changes toward /reload instead of manual restarts", () => {
    const contract = describeCommandsForPrompt();

    expect(contract).toContain("建议用户输入 /reload 平滑重启");
    // 口径要求：通用引导，不点名任何具体配置文件或事故细节。
    expect(contract).not.toMatch(/settings\.json|shellPath|wsl/i);
  });

  it("is embedded in the language contract injected into the system prompt", () => {
    expect(VSPI_LANGUAGE_CONTRACT).toContain("# VSPi 命令契约");
    expect(VSPI_LANGUAGE_CONTRACT).toContain("/reload：");
    expect(VSPI_LANGUAGE_CONTRACT).toContain("/quit：");
  });
});

describe("C19 CLI continue/resume aliases", () => {
  it.each([
    ["-c", "continue recent session"],
    ["--continue", "continue recent session"],
    ["-r", "open session picker"],
    ["--resume", "open session picker"],
  ] as const)("%s renders one frame instead of erroring as an unknown flag", async (flag, _meaning) => {
    // --render-once 在别名归一之后仍可组合：别名被映射为子命令，一帧渲染即退出。
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/index.ts", flag, "--render-once"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          VSPi_FIXTURE: "1",
          VSPi_REDUCED_MOTION: "1",
          VSPi_TUI_MODE: "fullscreen",
        },
        timeout: 30_000,
      },
    );
    const output = `${stdout}${stderr}`;
    expect(output).not.toMatch(/未知|unknown|Bad option|Invalid/i);
  });

  it("prints help documenting the aliases", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/index.ts", "--help"],
      {
        cwd: ROOT,
        timeout: 30_000,
      },
    );
    expect(stdout).toContain("兼容 -c / --continue");
    expect(stdout).toContain("兼容 -r / --resume");
  });
});
