import { access, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicyConfigModule } from "./m4-integration-contract.js";

async function configModule() {
  const module = await loadPolicyConfigModule();
  expect(module, "M4 must expose guarded PolicyConfigService").toBeDefined();
  return module;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vspi-m4-policy-config-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(cwd, ".vspi"), { recursive: true });
  await mkdir(join(home, ".config", "vspi"), { recursive: true });
  return { root, cwd, home };
}

describe("M4 guarded Policy configuration", () => {
  it("loads global upper/default, trusted project lowering, and intersected network allowlist", async () => {
    const module = await configModule();
    if (!module) return;
    const paths = await fixture();
    await writeFile(
      join(paths.home, ".config", "vspi", "policy.json"),
      JSON.stringify({ policy: "Auto", networkAllowlist: ["http://127.0.0.1:11111", "http://127.0.0.1:22222"] }),
    );
    await writeFile(
      join(paths.cwd, ".vspi", "policy.json"),
      JSON.stringify({ policy: "Standard", networkAllowlist: ["http://127.0.0.1:11111"] }),
    );
    const loaded = await module
      .createPolicyConfigService({ cwd: paths.cwd, home: paths.home, trustedProject: true })
      .load();
    expect(loaded).toMatchObject({
      globalPolicy: "Auto",
      projectPolicy: "Standard",
      effectivePolicy: "Standard",
      networkAllowlist: ["http://127.0.0.1:11111"],
      diagnostics: [],
    });
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects project elevation, secrets, sensitive headers, and command values", async () => {
    const module = await configModule();
    if (!module) return;
    const paths = await fixture();
    await writeFile(join(paths.home, ".config", "vspi", "policy.json"), JSON.stringify({ policy: "Standard" }));
    const service = module.createPolicyConfigService({ cwd: paths.cwd, home: paths.home, trustedProject: true });
    const current = await service.load();
    await expect(service.save("project", { policy: "Auto" }, { expectedHash: current.hash })).rejects.toThrow(
      /elevat|提升|上限|Policy/i,
    );
    for (const value of [
      { policy: "Safe" as const, apiKey: "POLICY_SECRET" },
      { policy: "Safe" as const, headers: { Authorization: "Bearer POLICY_SECRET" } },
      { policy: "Safe" as const, approval: "!security find-generic-password -w" },
    ]) {
      await expect(service.save("project", value, { expectedHash: current.hash })).rejects.toThrow(
        /secret|credential|header|command|不允许/i,
      );
    }
  });

  it("ignores project policy when untrusted or Recovery and forces Recovery Standard", async () => {
    const module = await configModule();
    if (!module) return;
    const paths = await fixture();
    await writeFile(join(paths.home, ".config", "vspi", "policy.json"), JSON.stringify({ policy: "Auto" }));
    await writeFile(join(paths.cwd, ".vspi", "policy.json"), JSON.stringify({ policy: "Safe" }));
    const untrusted = await module
      .createPolicyConfigService({ cwd: paths.cwd, home: paths.home, trustedProject: false })
      .load();
    expect(untrusted).toMatchObject({ globalPolicy: "Auto", effectivePolicy: "Auto" });
    expect(untrusted.projectPolicy).toBeUndefined();
    const recovery = await module
      .createPolicyConfigService({ cwd: paths.cwd, home: paths.home, trustedProject: true, recovery: true })
      .load();
    expect(recovery).toMatchObject({ globalPolicy: "Auto", effectivePolicy: "Standard", networkAllowlist: [] });
    expect(recovery.projectPolicy).toBeUndefined();
  });

  it("fails closed for stable project symlinks and stale hashes without changing outside data", async () => {
    const module = await configModule();
    if (!module) return;
    const root = await mkdtemp(join(tmpdir(), "vspi-m4-policy-config-symlink-"));
    const cwd = join(root, "project");
    const home = join(root, "home");
    const outside = join(root, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    await mkdir(join(home, ".config", "vspi"), { recursive: true });
    await writeFile(join(home, ".config", "vspi", "policy.json"), JSON.stringify({ policy: "Standard" }));
    await writeFile(join(outside, "sentinel.txt"), "POLICY_OUTSIDE_UNCHANGED");
    await symlink(outside, join(cwd, ".vspi"));
    const service = module.createPolicyConfigService({ cwd, home, trustedProject: true });
    const loaded = await service.load();
    expect(loaded.diagnostics.join(" ")).toMatch(/symlink|符号链接|scope|边界/i);
    await expect(service.save("project", { policy: "Safe" }, { expectedHash: loaded.hash })).rejects.toThrow(
      /symlink|符号链接|scope|边界/i,
    );
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("POLICY_OUTSIDE_UNCHANGED");

    const normal = await fixture();
    await writeFile(join(normal.home, ".config", "vspi", "policy.json"), JSON.stringify({ policy: "Standard" }));
    const atomic = module.createPolicyConfigService({ cwd: normal.cwd, home: normal.home, trustedProject: true });
    const before = await atomic.load();
    await atomic.save("project", { policy: "Safe" }, { expectedHash: before.hash });
    const policyPath = join(normal.cwd, ".vspi", "policy.json");
    expect(JSON.parse(await readFile(policyPath, "utf8"))).toEqual({ policy: "Safe" });
    expect((await stat(policyPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(normal.cwd, ".vspi"))).filter((entry) => /\.tmp$|\.lock$/.test(entry))).toEqual([]);
    await expect(atomic.save("project", { policy: "Safe" }, { expectedHash: before.hash })).rejects.toThrow(
      /conflict|hash|stale|冲突/i,
    );
  });

  const invalidNetworkTargets = [
    ["userinfo", "https://POLICY_USER:POLICY_PASSWORD@example.invalid/api", "POLICY_PASSWORD"],
    ["query", "https://example.invalid/api?token=POLICY_QUERY_SECRET", "POLICY_QUERY_SECRET"],
    ["fragment", "https://example.invalid/api#credential=POLICY_FRAGMENT_SECRET", "POLICY_FRAGMENT_SECRET"],
  ] as const;

  it.each(invalidNetworkTargets)(
    "rejects %s network URLs before global and project persistence",
    async (_kind, url, secret) => {
      const module = await configModule();
      if (!module) return;
      for (const scope of ["global", "project"] as const) {
        const paths = await fixture();
        const service = module.createPolicyConfigService({ cwd: paths.cwd, home: paths.home, trustedProject: true });
        const before = await service.load();
        let caught: unknown;
        try {
          await service.save(scope, { policy: "Standard", networkAllowlist: [url] }, { expectedHash: before.hash });
        } catch (error) {
          caught = error;
        }
        expect.soft(caught).toBeInstanceOf(Error);
        expect.soft(String(caught)).not.toContain(secret);
        const target =
          scope === "global"
            ? join(paths.home, ".config", "vspi", "policy.json")
            : join(paths.cwd, ".vspi", "policy.json");
        await expect.soft(access(target)).rejects.toThrow();
      }
    },
  );

  it.each(invalidNetworkTargets)(
    "rejects %s network URLs during global and project load without echo",
    async (_kind, url, secret) => {
      const module = await configModule();
      if (!module) return;
      for (const scope of ["global", "project"] as const) {
        const paths = await fixture();
        if (scope === "global") {
          await writeFile(
            join(paths.home, ".config", "vspi", "policy.json"),
            JSON.stringify({ policy: "Auto", networkAllowlist: [url] }),
          );
        } else {
          await writeFile(
            join(paths.home, ".config", "vspi", "policy.json"),
            JSON.stringify({ policy: "Auto", networkAllowlist: ["https://example.invalid/api"] }),
          );
          await writeFile(
            join(paths.cwd, ".vspi", "policy.json"),
            JSON.stringify({ policy: "Standard", networkAllowlist: [url] }),
          );
        }
        const loaded = await module
          .createPolicyConfigService({ cwd: paths.cwd, home: paths.home, trustedProject: true })
          .load();
        expect.soft(loaded.diagnostics.join(" ")).toMatch(/invalid|credential|query|fragment|凭据|查询|片段|不允许/i);
        expect.soft(loaded.diagnostics.join(" ")).not.toContain(secret);
        expect.soft(loaded.networkAllowlist).not.toContain(url);
        if (scope === "project") expect.soft(loaded.projectPolicy).toBeUndefined();
      }
    },
  );

  it("continues to accept credential-free HTTP(S) origins and paths", async () => {
    const module = await configModule();
    if (!module) return;
    const paths = await fixture();
    const service = module.createPolicyConfigService({ cwd: paths.cwd, home: paths.home, trustedProject: true });
    const before = await service.load();
    await service.save(
      "global",
      { policy: "Auto", networkAllowlist: ["https://example.invalid", "https://example.invalid/api/v1"] },
      { expectedHash: before.hash },
    );
    expect((await service.load()).networkAllowlist).toEqual([
      "https://example.invalid",
      "https://example.invalid/api/v1",
    ]);
  });
});
