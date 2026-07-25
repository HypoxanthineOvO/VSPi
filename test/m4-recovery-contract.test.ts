import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { loadStartupSecurityModule } from "./m4-contract.js";

const execFile = promisify(execFileCallback);

const RECOVERY_MODEL = {
  id: "recovery-model",
  name: "Recovery Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

function backendEvents() {
  return { onMessage: vi.fn(), onMessageUpdate: vi.fn(), onBusy: vi.fn(), onUsage: vi.fn(), onNotice: vi.fn() };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("M4 recovery startup boundary", () => {
  it("forces Standard Host approval and disables project authority/resources while retaining a global-only scope", async () => {
    const module = await loadStartupSecurityModule();
    expect(module, "M4 must expose a read-only startup security snapshot").toBeDefined();
    if (!module) return;
    expect(
      module.resolveStartupSecurity({
        argv: ["--recovery", "--workflow", "--policy", "YOLO", "--trust-project"],
        globalPolicy: "Auto",
        projectPolicy: "YOLO",
      }),
    ).toEqual({
      recovery: true,
      policy: "Standard",
      boundary: "Host",
      trustedProject: false,
      resourceScope: "global-only",
      projectSettings: false,
      extensions: false,
      workflowAdapter: false,
    });
  });

  it("reports Recovery visibly and does not execute malicious project resources in the real CLI", async () => {
    const repo = resolve(import.meta.dirname, "..");
    const root = await mkdtemp(join(tmpdir(), "vspi-m4-recovery-cli-"));
    const cwd = join(root, "project");
    const home = join(root, "home");
    const sentinel = join(root, "PROJECT_RESOURCE_MUST_NOT_RUN");
    const extension = join(cwd, ".pi", "extensions", "malicious.mjs");
    await mkdir(dirname(extension), { recursive: true });
    await mkdir(join(cwd, ".vspi"), { recursive: true });
    await mkdir(join(home, ".config", "vspi"), { recursive: true });
    await writeFile(
      extension,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "EXECUTED");\n`,
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ extensions: [extension], defaultProjectTrust: "always" }),
    );
    await writeFile(
      join(cwd, ".vspi", "settings.json"),
      JSON.stringify({ scope: "project", reducedMotion: false, bridgeEnabled: true, policy: "YOLO" }),
    );
    await writeFile(join(cwd, ".vspi", "models.json"), "{ malicious invalid json");
    await writeFile(
      join(home, ".config", "vspi", "settings.json"),
      JSON.stringify({ scope: "global", reducedMotion: true, bridgeEnabled: false }),
    );

    const { stdout, stderr } = await execFile(
      join(repo, "node_modules", ".bin", "tsx"),
      [join(repo, "src", "index.ts"), "--render-once", "--recovery", "--policy", "YOLO", "--trust-project"],
      {
        cwd,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), VSPi_FIXTURE: "1" },
        timeout: 15_000,
      },
    );
    const output = `${stdout}\n${stderr}`;
    const plainOutput = stripAnsi(output);
    expect(plainOutput).toMatch(/Recovery|恢复模式/i);
    expect(plainOutput).toContain("Policy Standard · Host");
    expect(plainOutput).not.toContain("Policy YOLO");
    await expect(access(sentinel)).rejects.toThrow();
  });

  it("forces projectTrusted false and disables every Pi ResourceLoader project surface inside the backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m4-recovery-pi-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const extension = join(cwd, ".pi", "extensions", "malicious.mjs");
    const extensionSentinel = join(root, "RECOVERY_PI_EXTENSION_MUST_NOT_RUN");
    await mkdir(dirname(extension), { recursive: true });
    await mkdir(join(cwd, ".vspi"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills", "project-skill"), { recursive: true });
    await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
    await mkdir(join(cwd, ".pi", "themes"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      extension,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(extensionSentinel)}, "EXECUTED");\n`,
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ extensions: [extension], defaultProjectTrust: "always" }),
    );
    await writeFile(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_MUST_NOT_LOAD");
    await writeFile(join(cwd, ".pi", "skills", "project-skill", "SKILL.md"), "# Project skill must not load");
    await writeFile(join(cwd, ".pi", "prompts", "project.md"), "Project prompt must not load");
    await writeFile(join(cwd, ".pi", "themes", "project.json"), JSON.stringify({ name: "Project Theme" }));
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          recovery: {
            name: "Recovery",
            baseUrl: "http://127.0.0.1:11111",
            apiKey: "FAKE_RECOVERY_LOCAL_KEY",
            api: "openai-completions",
            models: [RECOVERY_MODEL],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "recovery", defaultModel: RECOVERY_MODEL.id }),
    );
    await writeFile(
      join(cwd, ".vspi", "models.json"),
      JSON.stringify({ providers: { recovery: { baseUrl: "http://127.0.0.1:22222" } } }),
    );

    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const backend = new PiBackend({ cwd, continueRecent: false, trustedProject: true, recovery: true } as never);
    try {
      await backend.start(backendEvents());
      const session = (backend as unknown as { session?: AgentSession }).session;
      if (!session) throw new Error("Recovery Pi session did not start");
      expect.soft(session.settingsManager.isProjectTrusted()).toBe(false);
      expect.soft(session.model?.baseUrl).toBe("http://127.0.0.1:11111");
      expect.soft(session.resourceLoader.getExtensions().extensions).toEqual([]);
      expect.soft(session.resourceLoader.getSkills().skills).toEqual([]);
      expect.soft(session.resourceLoader.getPrompts().prompts).toEqual([]);
      expect.soft(session.resourceLoader.getThemes().themes).toEqual([]);
      expect.soft(session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect.soft(session.resourceLoader.getSystemPrompt()).toBeUndefined();
      expect(session.resourceLoader.getAppendSystemPrompt()).toEqual([]);
    } finally {
      await backend.dispose();
    }
    await expect(access(extensionSentinel)).rejects.toThrow();
  });
});
