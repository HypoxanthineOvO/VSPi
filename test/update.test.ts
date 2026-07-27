import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, installVspiPackage, resolvePackageInstaller, updateVspi } from "../src/update/self-update.js";

const ORIGIN = "https://gitlab.vsplab.cn";

function release(version: string, body: Buffer, overrides: Record<string, unknown> = {}) {
  const filename = `vspi-${version}.tgz`;
  const directAssetUrl = `${ORIGIN}/heyx/vspi/-/releases/v${version}/downloads/${filename}`;
  return {
    tag_name: `v${version}`,
    description: `SHA-256: \`${createHash("sha256").update(body).digest("hex")}\``,
    assets: { links: [{ name: filename, direct_asset_url: directAssetUrl }] },
    ...overrides,
  };
}

function updateFetch(version: string, body: Buffer, overrides: Record<string, unknown> = {}) {
  const metadata = release(version, body, overrides);
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/v4/")) {
      return new Response(JSON.stringify(metadata), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(Uint8Array.from(body), { status: 200 });
  });
}

describe("VSPi self-update", () => {
  it("compares stable versions numerically", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.1", "0.3.0")).toBe(-1);
    expect(() => compareVersions("latest", "0.2.1")).toThrow(/无效/);
  });

  it("returns without downloading or installing when the current version is latest", async () => {
    const body = Buffer.from("same release");
    const fetch = updateFetch("0.2.1", body);
    const installPackage = vi.fn(async () => {});

    await expect(updateVspi("0.2.1", { fetch, installPackage })).resolves.toEqual({
      status: "up-to-date",
      currentVersion: "0.2.1",
      latestVersion: "0.2.1",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(installPackage).not.toHaveBeenCalled();
  });

  it("downloads, verifies, installs and removes a newer release tarball", async () => {
    const body = Buffer.from("verified package bytes");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "vspi-update-test-"));
    const fetch = updateFetch("0.2.3", body);
    let installedPath = "";
    const installPackage = vi.fn(async (path: string) => {
      installedPath = path;
      expect(await readFile(path)).toEqual(body);
    });

    await expect(updateVspi("0.2.1", { fetch, installPackage, temporaryRoot })).resolves.toEqual({
      status: "updated",
      currentVersion: "0.2.1",
      latestVersion: "0.2.3",
    });
    expect(installPackage).toHaveBeenCalledOnce();
    expect(installedPath).toContain("vspi-0.2.3.tgz");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("refuses checksum mismatches and untrusted release assets", async () => {
    const body = Buffer.from("package bytes");
    const installPackage = vi.fn(async () => {});
    const badChecksum = updateFetch("0.2.3", body, { description: `SHA-256: \`${"0".repeat(64)}\`` });
    await expect(updateVspi("0.2.1", { fetch: badChecksum, installPackage })).rejects.toThrow(/SHA-256/);

    const badAsset = updateFetch("0.2.3", body, {
      assets: {
        links: [{ name: "vspi-0.2.3.tgz", direct_asset_url: "https://example.com/vspi-0.2.3.tgz" }],
      },
    });
    await expect(updateVspi("0.2.1", { fetch: badAsset, installPackage })).rejects.toThrow(/受信任/);
    expect(installPackage).not.toHaveBeenCalled();
  });

  it("updates a Volta-managed entry through Volta instead of a second npm global prefix", () => {
    const invocation = resolvePackageInstaller(
      "/tmp/vspi-0.3.2.tgz",
      "/home/test/.volta/tools/image/packages/vspi/lib/node_modules/vspi/dist/index.js",
      { VOLTA_HOME: "/home/test/.volta" },
    );

    expect(invocation).toEqual({
      command: "/home/test/.volta/bin/volta",
      args: ["install", "vspi@/tmp/vspi-0.3.2.tgz"],
      manager: "volta",
    });
  });

  it("uses npm when the current entry is outside Volta's managed package", () => {
    const invocation = resolvePackageInstaller(
      "/tmp/vspi-0.3.2.tgz",
      "/usr/local/lib/node_modules/vspi/dist/index.js",
      { VOLTA_HOME: "/home/test/.volta" },
    );

    expect(invocation.manager).toBe("npm");
    expect(invocation.args).toEqual(["install", "--global", "--no-audit", "--no-fund", "/tmp/vspi-0.3.2.tgz"]);
  });

  it("does not report success when the current installation remains on the old version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-update-entry-"));
    try {
      const entryPath = join(directory, "dist", "index.js");
      await mkdir(join(directory, "dist"));
      await writeFile(entryPath, "");
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: "vspi", version: "0.2.2" }));

      await expect(
        installVspiPackage("/tmp/vspi-0.3.2.tgz", "0.3.2", {
          entryPath,
          environment: {},
          execute: async () => {},
        }),
      ).rejects.toThrow(/仍为 0\.2\.2.*多个全局安装位置/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("accepts an update only after the current entry reports the expected version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-update-entry-"));
    try {
      const entryPath = join(directory, "dist", "index.js");
      const manifestPath = join(directory, "package.json");
      await mkdir(join(directory, "dist"));
      await writeFile(entryPath, "");
      await writeFile(manifestPath, JSON.stringify({ name: "vspi", version: "0.2.2" }));

      await expect(
        installVspiPackage("/tmp/vspi-0.3.2.tgz", "0.3.2", {
          entryPath,
          environment: {},
          execute: async () => {
            await writeFile(manifestPath, JSON.stringify({ name: "vspi", version: "0.3.2" }));
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
