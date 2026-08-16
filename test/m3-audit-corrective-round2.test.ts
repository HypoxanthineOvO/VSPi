import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import { loadSettings, saveSettings } from "../src/config/settings.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import type { AppSettings } from "../src/domain/types.js";
import { createProviderConfigService } from "../src/providers/config-service.js";

type SettingsTrust = { trustedProject: boolean };
type TrustAwareLoadSettings = (cwd: string, home: string, trust?: SettingsTrust) => Promise<AppSettings>;
type TrustAwareSaveSettings = (
  cwd: string,
  settings: AppSettings,
  home: string,
  trust?: SettingsTrust,
) => Promise<string>;

const trustAwareLoadSettings = loadSettings as unknown as TrustAwareLoadSettings;
const trustAwareSaveSettings = saveSettings as unknown as TrustAwareSaveSettings;

const MODEL = {
  id: "audit-model",
  name: "Audit Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

function events() {
  return { onMessage: vi.fn(), onMessageUpdate: vi.fn(), onBusy: vi.fn(), onUsage: vi.fn(), onNotice: vi.fn() };
}

function activeApi(backend: PiBackend): string | undefined {
  return (backend as unknown as { session?: AgentSession }).session?.model?.api;
}

async function capturedError(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function writeGlobalSettings(home: string): Promise<AppSettings> {
  const settings = {
    ...DEFAULT_SETTINGS,
    scope: "global" as const,
    reducedMotion: false,
  };
  await mkdir(join(home, ".config", "vspi"), { recursive: true });
  await writeFile(join(home, ".config", "vspi", "settings.json"), JSON.stringify(settings));
  return settings;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("M3 corrective round 2 settings and protocol boundaries", () => {
  it("keeps project settings behind explicit trust and rejects stable symlink reads and writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m3-settings-trust-"));
    const home = join(root, "home");
    const trustedCwd = join(root, "trusted-project");
    await mkdir(join(trustedCwd, ".vspi"), { recursive: true });
    const globalSettings = await writeGlobalSettings(home);
    const trustedProjectSettings = {
      ...DEFAULT_SETTINGS,
      scope: "project" as const,
      reducedMotion: true,
    };
    await writeFile(join(trustedCwd, ".vspi", "settings.json"), JSON.stringify(trustedProjectSettings));

    const trustedLoaded = await trustAwareLoadSettings(trustedCwd, home, { trustedProject: true });
    expect.soft(trustedLoaded).toMatchObject(trustedProjectSettings);
    await expect(
      trustAwareSaveSettings(
        trustedCwd,
        { ...trustedProjectSettings, wrapCode: !trustedProjectSettings.wrapCode },
        home,
        { trustedProject: true },
      ),
    ).resolves.toBe(join(trustedCwd, ".vspi", "settings.json"));

    const symlinkCwd = join(root, "untrusted-project");
    const outside = join(root, "outside");
    await mkdir(symlinkCwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(symlinkCwd, ".vspi"));
    const outsideSettings = {
      ...DEFAULT_SETTINGS,
      scope: "project" as const,
      reducedMotion: true,
      wrapCode: false,
    };
    const outsideSettingsPath = join(outside, "settings.json");
    const outsideSettingsRaw = JSON.stringify(outsideSettings);
    const sentinelPath = join(outside, "sentinel.txt");
    await writeFile(outsideSettingsPath, outsideSettingsRaw);
    await writeFile(sentinelPath, "OUTSIDE_SETTINGS_SENTINEL_UNCHANGED");

    const defaultUntrusted = await trustAwareLoadSettings(symlinkCwd, home);
    expect.soft(defaultUntrusted).toMatchObject(globalSettings);
    expect
      .soft(await capturedError(() => trustAwareLoadSettings(symlinkCwd, home, { trustedProject: true })))
      .toMatch(/symlink|符号链接|scope|边界/i);

    const projectUpdate = { ...outsideSettings, reducedMotion: false, wrapCode: true };
    expect
      .soft(await capturedError(() => trustAwareSaveSettings(symlinkCwd, projectUpdate, home)))
      .toMatch(/trust|信任|拒绝/i);
    expect
      .soft(
        await capturedError(() => trustAwareSaveSettings(symlinkCwd, projectUpdate, home, { trustedProject: true })),
      )
      .toMatch(/symlink|符号链接|scope|边界/i);
    expect.soft(await readFile(outsideSettingsPath, "utf8")).toBe(outsideSettingsRaw);
    expect(await readFile(sentinelPath, "utf8")).toBe("OUTSIDE_SETTINGS_SENTINEL_UNCHANGED");
  });

  it("makes a newly saved protocol override a stale legacy api in the production ModelRuntime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m3-protocol-precedence-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".vspi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          audit: {
            name: "Audit",
            baseUrl: "http://127.0.0.1:11111",
            apiKey: "FAKE_LOCAL_MODEL_KEY",
            api: "openai-completions",
            models: [MODEL],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "audit", defaultModel: MODEL.id }),
    );
    await writeFile(
      join(cwd, ".vspi", "models.json"),
      JSON.stringify({
        providers: {
          audit: {
            name: "Audit",
            baseUrl: "http://127.0.0.1:11111",
            api: "openai-completions",
            protocol: "OpenAI compatible",
          },
        },
      }),
    );

    const config = createProviderConfigService({ cwd, agentDir, trustedProject: true, builtins: [] });
    const before = await config.loadCatalog();
    await config.saveProjectProvider(
      "audit",
      { name: "Audit", baseUrl: "http://127.0.0.1:11111", protocol: "Anthropic Messages" },
      { expectedHash: before.hash },
    );

    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const backend = new PiBackend({ cwd, continueRecent: false, trustedProject: true });
    try {
      await backend.start(events());
      expect(activeApi(backend)).toBe("anthropic-messages");
    } finally {
      await backend.dispose();
    }
  });
});
