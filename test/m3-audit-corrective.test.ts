import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/backend/pi-backend.js";
import { createRuntimeDefaultsService } from "../src/config/runtime-defaults.js";
import { createProviderConfigService } from "../src/providers/config-service.js";

const MODEL = {
  id: "audit-model",
  name: "Audit Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

async function productionWorkspace(projectBaseUrl = "http://127.0.0.1:22222") {
  const root = await mkdtemp(join(tmpdir(), "vspi-m3-production-trust-"));
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
    JSON.stringify({ providers: { audit: { baseUrl: projectBaseUrl, protocol: "OpenAI compatible" } } }),
  );
  return { root, cwd, agentDir };
}

function events() {
  return { onMessage: vi.fn(), onMessageUpdate: vi.fn(), onBusy: vi.fn(), onUsage: vi.fn(), onNotice: vi.fn() };
}

function activeBaseUrl(backend: PiBackend): string | undefined {
  return (backend as unknown as { session?: AgentSession }).session?.model?.baseUrl;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("M3 audit corrective production boundaries", () => {
  it("registers project Providers only after explicit VSPi trust approval", async () => {
    const workspace = await productionWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", workspace.agentDir);
    vi.stubEnv("DEEPSEEK_API_KEY", "");

    const defaultUntrusted = new PiBackend({ cwd: workspace.cwd, continueRecent: false });
    await defaultUntrusted.start(events());
    expect.soft(activeBaseUrl(defaultUntrusted)).toBe("http://127.0.0.1:11111");
    expect.soft(defaultUntrusted.isProjectTrusted()).toBe(false);
    await defaultUntrusted.dispose();

    const explicitUntrusted = new PiBackend({
      cwd: workspace.cwd,
      continueRecent: false,
      trustedProject: false,
    });
    await explicitUntrusted.start(events());
    expect.soft(activeBaseUrl(explicitUntrusted)).toBe("http://127.0.0.1:11111");
    expect.soft(explicitUntrusted.isProjectTrusted()).toBe(false);
    await explicitUntrusted.dispose();

    const trusted = new PiBackend({ cwd: workspace.cwd, continueRecent: false, trustedProject: true } as never);
    await trusted.start(events());
    expect(activeBaseUrl(trusted)).toBe("http://127.0.0.1:22222");
    expect(trusted.isProjectTrusted()).toBe(true);
    await trusted.dispose();
  });

  it("rejects symlinked project config scopes before read or write and leaves outside data unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m3-symlink-scope-"));
    const cwd = join(root, "project");
    const outside = join(root, "outside");
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(outside, join(cwd, ".vspi"));
    const sentinelPath = join(outside, "sentinel.txt");
    await writeFile(sentinelPath, "OUTSIDE_SENTINEL_UNCHANGED");

    const providers = createProviderConfigService({ cwd, agentDir, trustedProject: true, builtins: [] });
    const before = await providers.loadCatalog();
    expect.soft(before.providers).toEqual([]);
    expect.soft(before.diagnostics.join(" ")).toMatch(/symlink|符号链接|scope|边界/i);
    let providerWriteError = "";
    try {
      await providers.saveProjectOverlay({ providers: {} }, { expectedHash: before.hash });
    } catch (error) {
      providerWriteError = error instanceof Error ? error.message : String(error);
    }
    expect.soft(providerWriteError).toMatch(/symlink|符号链接|scope|边界/i);

    const defaults = createRuntimeDefaultsService({ cwd, home, trustedProject: true });
    const loaded = await defaults.load();
    expect.soft(loaded.value).toEqual({ effort: "中" });
    expect.soft(loaded.diagnostics.join(" ")).toMatch(/symlink|符号链接|scope|边界/i);
    let defaultsWriteError = "";
    try {
      await defaults.save("project", { effort: "高" });
    } catch (error) {
      defaultsWriteError = error instanceof Error ? error.message : String(error);
    }
    expect.soft(defaultsWriteError).toMatch(/symlink|符号链接|scope|边界/i);
    expect(await readFile(sentinelPath, "utf8")).toBe("OUTSIDE_SENTINEL_UNCHANGED");
    let outsideModelsExists = true;
    let outsideDefaultsExists = true;
    await access(join(outside, "models.json")).catch(() => {
      outsideModelsExists = false;
    });
    await access(join(outside, "runtime-defaults.json")).catch(() => {
      outsideDefaultsExists = false;
    });
    expect.soft(outsideModelsExists).toBe(false);
    expect.soft(outsideDefaultsExists).toBe(false);
  });

  it("re-resolves Provider/model identity from the rebuilt ModelRuntime after ordinary and default new", async () => {
    const workspace = await productionWorkspace("http://127.0.0.1:11111");
    vi.stubEnv("PI_CODING_AGENT_DIR", workspace.agentDir);
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const backend = new PiBackend({ cwd: workspace.cwd, continueRecent: false, trustedProject: true } as never);
    await backend.start(events());
    expect(activeBaseUrl(backend)).toBe("http://127.0.0.1:11111");
    const config = createProviderConfigService({
      cwd: workspace.cwd,
      agentDir: workspace.agentDir,
      trustedProject: true,
      builtins: [],
    });
    const current = await config.loadCatalog();
    await config.saveProjectProvider(
      "audit",
      { name: "Audit", baseUrl: "http://127.0.0.1:22222", protocol: "OpenAI compatible" },
      { expectedHash: current.hash },
    );

    await backend.newSession({ defaults: false, continuePlan: false });
    expect.soft(activeBaseUrl(backend)).toBe("http://127.0.0.1:22222");
    await backend.newSession({ defaults: true, continuePlan: false });
    expect(activeBaseUrl(backend)).toBe("http://127.0.0.1:22222");
    await backend.dispose();
  });
});
