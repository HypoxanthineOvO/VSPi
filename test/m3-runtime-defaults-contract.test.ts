import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeDefaultsService } from "../src/config/runtime-defaults.js";

describe("M3 runtime Model/Effort defaults", () => {
  it("merges trusted project defaults over global defaults and persists each scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m3-defaults-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m3-defaults-project-"));
    const service = createRuntimeDefaultsService({ cwd, home, trustedProject: true });
    await service.save("global", { model: { provider: "openai", id: "global-model" }, effort: "低" });
    await service.save("project", { model: { provider: "anthropic", id: "project-model" }, effort: "高" });

    expect(await service.load()).toMatchObject({
      value: { model: { provider: "anthropic", id: "project-model" }, effort: "高" },
      diagnostics: [],
    });
  });

  it("ignores project defaults and rejects project writes when trust is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m3-untrusted-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m3-untrusted-project-"));
    const trusted = createRuntimeDefaultsService({ cwd, home, trustedProject: true });
    await trusted.save("global", { model: { provider: "openai", id: "global-model" }, effort: "中" });
    await trusted.save("project", { model: { provider: "google", id: "ignored-project-model" }, effort: "高" });
    const untrusted = createRuntimeDefaultsService({ cwd, home, trustedProject: false });

    expect((await untrusted.load()).value).toEqual({
      model: { provider: "openai", id: "global-model" },
      effort: "中",
    });
    await expect(untrusted.save("project", { effort: "低" })).rejects.toThrow(/trust|拒绝/i);
  });

  it("reports damaged defaults and falls back without leaking file contents", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m3-damaged-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m3-damaged-project-"));
    const service = createRuntimeDefaultsService({ cwd, home, trustedProject: true });
    await service.save("global", { effort: "低" });
    await service.save("project", { effort: "高" });
    await writeFile(service.paths.project, "{ DAMAGED_DEFAULT_SECRET");

    const loaded = await service.load();
    expect(loaded.value).toEqual({ effort: "低" });
    expect(loaded.diagnostics.join(" ")).toMatch(/runtime-defaults\.json|无效|JSON/i);
    expect(loaded.diagnostics.join(" ")).not.toContain("DAMAGED_DEFAULT_SECRET");
  });
});
