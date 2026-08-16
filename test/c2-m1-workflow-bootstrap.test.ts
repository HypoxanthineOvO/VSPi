import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { resolveStartupSecurity } from "../src/policy/startup-security.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { loadWorkflowCore } from "../src/workflow/core-loader.js";
import { createHypoWorkflowAdapter } from "../src/workflow/hypo-adapter.js";
import { createStartupWorkflowAdapter } from "../src/workflow/startup.js";
import type { LoadedWorkflowCore, WorkflowCoreModule } from "../src/workflow/types.js";
import { plainTheme } from "./helpers.js";

const COMMIT = "a".repeat(40);
const temporaryPaths = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
  temporaryPaths.clear();
});

describe("C2 M1 Workflow Adapter bootstrap", () => {
  it("loads an integrity-bound ESM Core through runtime-checked root exports", async () => {
    const fixture = await workflowBundleFixture();
    const loaded = await loadWorkflowCore(fixture.options);

    expect(loaded.identity).toMatchObject({
      version: "14.0.0-test.1",
      sourceCommit: COMMIT,
      archiveSha256: fixture.archiveSha256,
      contractVersion: "1",
    });
    expect(typeof loaded.core.createDeliveryStore).toBe("function");
    expect(typeof loaded.core.createWorkstreamStore).toBe("function");
  });

  it("rejects archive drift, source drift, missing exports, and unsafe installed files", async () => {
    const archiveDrift = await workflowBundleFixture();
    await expect(loadWorkflowCore({ ...archiveDrift.options, expectedArchiveSha256: "b".repeat(64) })).rejects.toThrow(
      /archive digest/i,
    );

    const sourceDrift = await workflowBundleFixture();
    await expect(loadWorkflowCore({ ...sourceDrift.options, expectedSourceCommit: "b".repeat(40) })).rejects.toThrow(
      /source commit/i,
    );

    const manifestDrift = await workflowBundleFixture();
    await writeFile(join(manifestDrift.root, "bundle-manifest.json"), "{}\n");
    await expect(loadWorkflowCore(manifestDrift.options)).rejects.toThrow(/manifest digest/i);

    const missingExport = await workflowBundleFixture({ missingExport: true });
    await expect(loadWorkflowCore(missingExport.options)).rejects.toThrow(/required export.*createWorkstreamStore/i);

    const runtimeDrift = await workflowBundleFixture();
    await mkdir(join(runtimeDrift.root, "node_modules/unbound"), { recursive: true });
    await writeFile(join(runtimeDrift.root, "node_modules/unbound/index.js"), "throw new Error('unbound runtime');\n");
    await expect(loadWorkflowCore(runtimeDrift.options)).rejects.toThrow(/unbound files/i);

    const unsafe = await workflowBundleFixture();
    const entry = join(unsafe.root, "core/src/index.js");
    const target = join(unsafe.root, "unsafe-target.js");
    await writeFile(target, await readFile(entry));
    await import("node:fs/promises").then(({ rm }) => rm(entry));
    await symlink(target, entry);
    await expect(loadWorkflowCore(unsafe.options)).rejects.toThrow(/unsafe/i);
  });

  it("branches Recovery before environment discovery or Core loading", async () => {
    const loadCore = vi.fn();
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error("Recovery touched Workflow environment");
        },
      },
    ) as NodeJS.ProcessEnv;

    const adapter = await createStartupWorkflowAdapter({
      enabled: false,
      workspace: "/workspace/recovery",
      disabledReason: "recovery",
      env,
      loadCore,
    });

    expect(await adapter.snapshot()).toEqual({
      status: "disabled",
      diagnostic: "Recovery 已禁用 Workflow Adapter",
    });
    expect(await adapter.authorize({ kind: "workflow-authority", operation: "release" })).toBe(false);
    expect(loadCore).not.toHaveBeenCalled();
  });

  it("keeps Workflow opt-in and avoids environment discovery until --workflow is explicit", async () => {
    expect(resolveStartupSecurity({ argv: [] }).workflowAdapter).toBe(false);
    expect(resolveStartupSecurity({ argv: ["--workflow"] }).workflowAdapter).toBe(true);
    expect(resolveStartupSecurity({ argv: ["--workflow", "--recovery"] }).workflowAdapter).toBe(false);

    const loadCore = vi.fn();
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error("disabled Workflow touched environment");
        },
      },
    ) as NodeJS.ProcessEnv;
    const adapter = await createStartupWorkflowAdapter({
      enabled: false,
      workspace: "/workspace/default-off",
      disabledReason: "not-enabled",
      env,
      loadCore,
    });
    expect(await adapter.snapshot()).toEqual({
      status: "disabled",
      diagnostic: "Workflow 未开启；使用 --workflow 启用只读集成",
    });
    expect(loadCore).not.toHaveBeenCalled();
  });

  it("projects the active Delivery while keeping mutation authority denied without a Receipt", async () => {
    const loaded = fakeLoadedCore();
    const adapter = createHypoWorkflowAdapter({
      workspace: "/workspace/project",
      loaded,
      clock: () => "2026-07-24T00:00:00.000Z",
    });

    const snapshot = await adapter.snapshot();
    expect(snapshot).toMatchObject({
      status: "ready",
      delivery: {
        id: "vspi-v0-2-0-workflow-integration",
        status: "executing",
        revision: 1,
        currentMilestoneId: "M1",
      },
    });
    expect(await adapter.authorize({ kind: "workflow-authority", operation: "accept" })).toBe(false);

    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setWorkflowSnapshot(snapshot);
    panel.open("plan");
    const rendered = panel.render(100, 16, plainTheme(), DEFAULT_USAGE, true).map(stripAnsi).join("\n");
    expect(rendered).toContain("VSPi V0.2.0 Workflow Integration");
    expect(rendered).toContain("执行中 · 修订 1");
    expect(rendered).toContain("契约 v1");
    expect(rendered).toContain("M1 Workflow Adapter Bootstrap");
    expect(rendered).not.toContain("pending");
    expect(rendered).not.toContain(COMMIT.slice(0, 12));
  });
});

async function workflowBundleFixture(options: { missingExport?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vspi-workflow-bundle-"));
  const archivePath = join(root, "..", `${root.split("/").at(-1)}.zip`);
  temporaryPaths.add(root);
  temporaryPaths.add(archivePath);
  await mkdir(join(root, "contracts/host/v1"), { recursive: true });
  await mkdir(join(root, "core/src"), { recursive: true });
  await writeFile(archivePath, "accepted portable bytes\n");
  const archiveSha256 = sha256(await readFile(archivePath));
  const descriptor = `${JSON.stringify(
    {
      schema_version: "1",
      contract_version: "1",
      release: { version: "14.0.0-test.1", source_commit: COMMIT },
      command_manifest: { path: "contracts/host/v1/command-manifest.json", sha256: "c".repeat(64) },
    },
    null,
    2,
  )}\n`;
  const module = `
export function createDeliveryStore() { return { resume: async () => ({}) }; }
${options.missingExport ? "" : "export function createWorkstreamStore() { return {}; }"}
export function compileVspiIntegrationContract({ generated_at }) {
  return { contract_version: "1", generated_at };
}
export function parseVspiIntegrationContract(value) { return value; }
export async function verifyPortableBundle({ manifest }) {
  return { files: manifest.files.map((item) => item.path) };
}
`;
  await writeFile(join(root, "contracts/host/v1/installed-release.json"), descriptor);
  await writeFile(join(root, "core/src/index.js"), module);
  const files = await Promise.all(
    ["contracts/host/v1/installed-release.json", "core/src/index.js"].map(async (path) => {
      const bytes = await readFile(join(root, path));
      return { path, sha256: sha256(bytes), bytes: bytes.length };
    }),
  );
  const manifest = `${JSON.stringify({ schema_version: "1", contract_version: "1", files }, null, 2)}\n`;
  await writeFile(join(root, "bundle-manifest.json"), manifest);
  const runtimeManifest = `${JSON.stringify({ schema_version: "1", files: [] }, null, 2)}\n`;
  await writeFile(join(root, "runtime-manifest.json"), runtimeManifest);
  return {
    root,
    archiveSha256,
    options: {
      root,
      archivePath,
      expectedSourceCommit: COMMIT,
      expectedArchiveSha256: archiveSha256,
      expectedManifestSha256: sha256(Buffer.from(manifest)),
      expectedRuntimeManifestSha256: sha256(Buffer.from(runtimeManifest)),
    },
  };
}

function fakeLoadedCore(): LoadedWorkflowCore {
  const core = {
    createDeliveryStore: () => ({
      resume: async () => ({
        delivery: {
          object_ref: { kind: "delivery", id: "vspi-v0-2-0-workflow-integration" },
          delivery_kind: "cycle",
          status: "executing",
          revision: 1,
          plan_hash: "d".repeat(64),
          milestones: [
            {
              id: "M1",
              title: "Workflow Adapter Bootstrap",
              status: "executing",
              stone: { id: "S-workflow-bootstrap" },
            },
            { id: "M2", title: "Workflow Plan Migration", status: "pending" },
          ],
        },
      }),
    }),
    createWorkstreamStore: () => ({}),
    compileVspiIntegrationContract: ({ generated_at }: { generated_at: string }) => ({
      contract_version: "1",
      generated_at,
    }),
    parseVspiIntegrationContract: (value: unknown) => value,
    verifyPortableBundle: async () => ({ files: ["core/src/index.js"] }),
  } satisfies WorkflowCoreModule;
  return {
    core,
    identity: {
      version: "14.0.0-test.1",
      sourceCommit: COMMIT,
      archiveSha256: "e".repeat(64),
      contractVersion: "1",
      root: "/workflow/core",
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
