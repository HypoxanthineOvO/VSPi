import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAgentProjectConfig, loadAgentProjectConfig, saveAgentProjectConfig } from "../src/agents/config.js";

describe("project agent configuration", () => {
  it("uses conservative defaults and rejects values above the trusted-project hard ceilings", async () => {
    expect(defaultAgentProjectConfig()).toMatchObject({
      maxDepth: 3,
      maxAgentsPerTree: 12,
      maxConcurrency: 16,
      maxRunTokens: 120_000,
      maxTreeTokens: 500_000,
      maxTreeCostUsd: 20,
      maxRunSeconds: 900,
    });

    const cwd = await mkdtemp(join(tmpdir(), "vspi-agents-limits-"));
    const depth = defaultAgentProjectConfig();
    depth.maxDepth = 6;
    await expect(saveAgentProjectConfig(cwd, true, depth)).rejects.toThrow("maxDepth");
    const tree = defaultAgentProjectConfig();
    tree.maxAgentsPerTree = 129;
    await expect(saveAgentProjectConfig(cwd, true, tree)).rejects.toThrow("maxAgentsPerTree");
    const concurrency = defaultAgentProjectConfig();
    concurrency.maxConcurrency = 17;
    await expect(saveAgentProjectConfig(cwd, true, concurrency)).rejects.toThrow("maxConcurrency");
  });

  it("loads project teammates only for trusted projects and persists normalized state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-agents-config-"));
    const config = defaultAgentProjectConfig();
    config.maxConcurrency = 7;
    config.modelPools.vsplab = { roles: { researcher: "vsplab/gpt-5.6-luna" } };
    config.teammates.push({
      id: "frontend",
      role: "Frontend",
      description: "Owns frontend implementation",
      routing: "required",
      match: ["frontend"],
      systemPrompt: "Frontend role",
      tools: ["read", "edit", "write"],
      preferredModel: "kimi/k2",
      fallbackModels: ["openai/gpt-5"],
    });
    const path = await saveAgentProjectConfig(cwd, true, config);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      maxConcurrency: 7,
      modelPools: { vsplab: { roles: { researcher: "vsplab/gpt-5.6-luna" } } },
    });
    expect((await loadAgentProjectConfig(cwd, true)).teammates[0]).toMatchObject({ id: "frontend" });
    expect((await loadAgentProjectConfig(cwd, false)).teammates).toEqual([]);
  });

  it("fails closed on malformed config and project path symlinks", async () => {
    const malformed = await mkdtemp(join(tmpdir(), "vspi-agents-malformed-"));
    await mkdir(join(malformed, ".vspi"));
    await writeFile(join(malformed, ".vspi", "agents.json"), '{"version":1,"teammates":"bad"}');
    await expect(loadAgentProjectConfig(malformed, true)).rejects.toThrow("teammates");

    const linked = await mkdtemp(join(tmpdir(), "vspi-agents-linked-"));
    const outside = await mkdtemp(join(tmpdir(), "vspi-agents-outside-"));
    await symlink(outside, join(linked, ".vspi"));
    await expect(loadAgentProjectConfig(linked, true)).rejects.toThrow("symlink");
  });
});
