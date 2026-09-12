import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installVspiPackage,
  installVspiUpdate,
  LATEST_RELEASE_URL,
  resolvePackageInstaller,
  updateVspi,
} from "../src/v1/update/self-update.js";

const directories: string[] = [];
const githubOrigin = "https://github.com";
const assetCdnOrigin = "https://release-assets.githubusercontent.com";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VSPi GitHub self-update contract", () => {
  it('restores a saved package after installation fails without replacing user configuration', async () => {
    const root = await temporaryDirectory('vspi-upgrade-rollback-');
    const packageRoot = join(root, 'package');
    const home = join(root, 'home');
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await mkdir(home);
    const entry = join(packageRoot, 'dist', 'main.mjs');
    await writeFile(entry, 'console.log("2.0.0")');
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'vspi', version: '2.0.0', type: 'module' }));
    await writeFile(join(home, 'config.toml'), '# preserved configuration\n');
    const installed: string[] = [];
    await expect(installVspiUpdate(join(root, 'new.tgz'), '2.1.0', {
      entryPath: entry, homeDir: home,
      environment: { ...process.env, HOME: root, USERPROFILE: root, npm_config_cache: join(root, 'npm-cache') },
      install: async (path, version) => {
        installed.push(version);
        if (version === '2.1.0') throw new Error('injected installer failure');
        expect(path).toContain('vspi-2.0.0.tgz');
      },
    })).rejects.toThrow('已恢复旧安装包');
    expect(installed).toEqual(['2.1.0', '2.0.0']);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('# preserved configuration\n');
    expect(await readdir(join(home, 'server', 'update-backups'))).toHaveLength(1);
  }, 30000);
  it("discovers the latest tag without the GitHub API and verifies SHA256SUMS before install", async () => {
    const bytes = Buffer.from("package");
    const version = "2.1.0";
    const installPackage = vi.fn(async () => undefined);
    const fetch = fetchSequence(
      latestRedirect(version),
      assetRedirect(checksumUrl(version), `${assetCdnOrigin}/asset-id/SHA256SUMS`),
      response(checksumText(version, bytes), `${assetCdnOrigin}/asset-id/SHA256SUMS`),
      assetRedirect(assetUrl(version), `${assetCdnOrigin}/asset-id/package.tgz`),
      response(bytes, `${assetCdnOrigin}/asset-id/package.tgz`, 200, {
        "content-length": String(bytes.length),
      }),
    );

    await expect(updateVspi("2.0.0", { fetch, installPackage })).resolves.toEqual({
      status: "updated",
      currentVersion: "2.0.0",
      latestVersion: version,
    });
    const latestHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(latestHeaders.get("user-agent")).toBe("VSPi-Updater");
    expect(fetch.mock.calls.map((call) => call[1]?.redirect)).toEqual([
      "manual",
      "manual",
      "manual",
      "manual",
      "manual",
    ]);
    expect(
      fetch.mock.calls.map(([input]) =>
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ),
    ).not.toContain("api.github.com");
    expect(installPackage).toHaveBeenCalledOnce();
  });

  it.each([
    ["same", "2.1.0"],
    ["older", "2.2.0"],
  ])("returns up-to-date for a %s latest release without downloading", async (_label, currentVersion) => {
    const fetch = fetchSequence(latestRedirect("2.1.0"));
    await expect(updateVspi(currentVersion, { fetch })).resolves.toEqual({
      status: "up-to-date",
      currentVersion,
      latestVersion: "2.1.0",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects untrusted latest URLs and redirect targets", async () => {
    await expect(
      updateVspi("2.0.0", { latestReleaseUrl: "https://example.test/latest", fetch: vi.fn() }),
    ).rejects.toThrow("latest Release 地址不受信任");
    await expect(
      updateVspi("2.0.0", {
        fetch: vi.fn(async () =>
          response(undefined, LATEST_RELEASE_URL, 302, {
            location: "https://example.test/releases/tag/v2.1.0",
          }),
        ),
      }),
    ).rejects.toThrow("重定向地址不受信任");
    await expect(
      updateVspi("2.0.0", {
        fetch: vi.fn(async () =>
          response(undefined, LATEST_RELEASE_URL, 302, {
            location: `${githubOrigin}/HypoxanthineOvO/VSPi/releases/tag/v2.1.0-rc.1`,
          }),
        ),
      }),
    ).rejects.toThrow("不是稳定 SemVer");
  });

  it.each([
    [404, {}, "未找到 VSPi Release"],
    [429, { "retry-after": "60" }, "60 秒后重试"],
    [500, {}, "HTTP 500"],
  ])("reports GitHub latest Release HTTP %s", async (status, headers, message) => {
    await expect(
      updateVspi("2.0.0", {
        fetch: vi.fn(async () => response(undefined, LATEST_RELEASE_URL, status, headers)),
      }),
    ).rejects.toThrow(message);
  });

  it.each([
    ["arbitrary cross-origin", "https://example.test/package.tgz", "地址不受信任"],
    ["lookalike CDN host", "https://release-assets.githubusercontent.com.example.test/package.tgz", "地址不受信任"],
    ["non-standard CDN port", "https://release-assets.githubusercontent.com:8443/package.tgz", "地址不受信任"],
    ["credential-bearing CDN URL", "https://user@release-assets.githubusercontent.com/package.tgz", "地址不受信任"],
    ["HTTP downgrade", "http://release-assets.githubusercontent.com/package.tgz", "必须使用 HTTPS"],
  ])("rejects a %s redirect", async (_label, location, message) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(latestRedirect("2.1.0"))
      .mockResolvedValueOnce(response(undefined, checksumUrl("2.1.0"), 302, { location }));
    await expect(updateVspi("2.0.0", { fetch })).rejects.toThrow(message);
  });

  it("rejects missing redirect locations, too many redirects, and an untrusted final response URL", async () => {
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchSequence(latestRedirect("2.1.0"), response(undefined, checksumUrl("2.1.0"), 302)),
      }),
    ).rejects.toThrow("缺少 Location");

    const redirects = Array.from({ length: 6 }, (_, index) =>
      response(undefined, `${assetCdnOrigin}/asset-${index}`, 302, { location: `${assetCdnOrigin}/asset-${index + 1}` }),
    );
    await expect(
      updateVspi("2.0.0", { fetch: fetchSequence(latestRedirect("2.1.0"), ...redirects) }),
    ).rejects.toThrow("重定向次数过多");

    await expect(
      updateVspi("2.0.0", {
        fetch: fetchSequence(
          latestRedirect("2.1.0"),
          response("package", "https://example.test/package.tgz"),
        ),
      }),
    ).rejects.toThrow("地址不受信任");
  });

  it("rejects checksum mismatch and declared or actual oversized packages", async () => {
    const asset = assetUrl("2.1.0");
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchSequence(
          latestRedirect("2.1.0"),
          response(`${"a".repeat(64)}  vspi-2.1.0.tgz\n`, checksumUrl("2.1.0")),
          response("wrong", asset),
        ),
      }),
    ).rejects.toThrow("SHA-256");
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchSequence(
          latestRedirect("2.1.0"),
          response(`${"a".repeat(64)}  vspi-2.1.0.tgz\n`, checksumUrl("2.1.0")),
          response("small", asset, 200, { "content-length": String(64 * 1024 * 1024 + 1) }),
        ),
      }),
    ).rejects.toThrow("64 MiB");
    const oversized = Buffer.alloc(64 * 1024 * 1024 + 1);
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchSequence(
          latestRedirect("2.1.0"),
          response(checksumText("2.1.0", oversized), checksumUrl("2.1.0")),
          response(oversized, asset),
        ),
      }),
    ).rejects.toThrow("64 MiB");
  });
});

describe("VSPi package installer contract", () => {
  it("selects npm, Windows npm, and Volta without registry resolution", () => {
    expect(resolvePackageInstaller("package.tgz", "/usr/local/bin/vspi", {}, "linux")).toMatchObject({
      command: "npm",
      manager: "npm",
      args: ["install", "--global", "--no-audit", "--no-fund", expect.stringMatching(/package\.tgz$/u)],
    });
    expect(resolvePackageInstaller("package.tgz", "C:\\vspi.cmd", { ComSpec: "cmd.exe" }, "win32")).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining('npm-cli.js'), "install", "--global", "--no-audit", "--no-fund", expect.any(String)],
    });
    expect(
      resolvePackageInstaller(
        "package.tgz",
        "/volta/tools/image/packages/vspi/bin/vspi",
        { VOLTA_HOME: "/volta" },
        "linux",
      ),
    ).toMatchObject({ command: "/volta/bin/volta", manager: "volta", args: ["install", expect.stringMatching(/^vspi@/u)] });
  });

  it("verifies the package version at the active entry after installation", async () => {
    const root = await temporaryDirectory("vspi-install-");
    const entry = join(root, "bin", "vspi");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(entry, "entry");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "vspi", version: "2.0.0" }));
    await expect(
      installVspiPackage("package.tgz", "2.1.0", { entryPath: entry, execute: async () => undefined }),
    ).rejects.toThrow("仍为 2.0.0");
    await installVspiPackage("package.tgz", "2.1.0", {
      entryPath: entry,
      execute: async () => writeFile(join(root, "package.json"), JSON.stringify({ name: "vspi", version: "2.1.0" })),
    });
  });
});

function assetUrl(version: string): string {
  return `${githubOrigin}/HypoxanthineOvO/VSPi/releases/download/v${version}/vspi-${version}.tgz`;
}

function checksumUrl(version: string): string {
  return `${githubOrigin}/HypoxanthineOvO/VSPi/releases/download/v${version}/SHA256SUMS`;
}

function checksumText(version: string, bytes: Uint8Array): string {
  const checksum = sha256(bytes);
  return `${checksum}  vspi-${version}.tgz\n${checksum}  vspi-latest.tgz\n`;
}

function latestRedirect(version: string): Response {
  return response(undefined, LATEST_RELEASE_URL, 302, {
    location: `${githubOrigin}/HypoxanthineOvO/VSPi/releases/tag/v${version}`,
  });
}

function assetRedirect(url: string, location: string): Response {
  return response(undefined, url, 302, { location });
}

function response(body: unknown, url: string, status = 200, headers: Record<string, string> = {}): Response {
  const bytes =
    body instanceof Uint8Array
      ? Buffer.from(body)
      : typeof body === "string"
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body);
  const value = new Response(bytes, { status, headers });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function fetchSequence(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of responses) fetch.mockResolvedValueOnce(value);
  return fetch;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
