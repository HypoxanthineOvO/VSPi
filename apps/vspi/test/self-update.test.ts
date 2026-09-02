import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installVspiPackage,
  RELEASE_API_URL,
  resolvePackageInstaller,
  updateVspi,
} from "../src/v1/update/self-update.js";

const directories: string[] = [];
const releaseFixture = JSON.parse(
  readFileSync(new URL("./fixtures/github-latest-release.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const githubOrigin = "https://github.com";
const assetCdnOrigin = "https://release-assets.githubusercontent.com";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VSPi GitHub self-update contract", () => {
  it("accepts a GitHub release fixture, sends API headers, and follows an official asset redirect", async () => {
    const bytes = Buffer.from("package");
    const version = "2.1.0";
    const asset = assetUrl(version);
    const installPackage = vi.fn(async () => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(release(version, sha256(bytes)), RELEASE_API_URL))
      .mockResolvedValueOnce(response(undefined, asset, 302, { location: `${assetCdnOrigin}/asset-id/package.tgz` }))
      .mockResolvedValueOnce(
        response(bytes, `${assetCdnOrigin}/asset-id/package.tgz`, 200, { "content-length": String(bytes.length) }),
      );

    await expect(updateVspi("2.0.0", { fetch, installPackage })).resolves.toEqual({
      status: "updated",
      currentVersion: "2.0.0",
      latestVersion: version,
    });
    const apiHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(apiHeaders.get("accept")).toBe("application/vnd.github+json");
    expect(apiHeaders.get("user-agent")).toBe("VSPi-Updater");
    expect(fetch.mock.calls.slice(1).map((call) => call[1]?.headers)).toEqual([undefined, undefined]);
    expect(fetch.mock.calls.map((call) => call[1]?.redirect)).toEqual(["manual", "manual", "manual"]);
    expect(installPackage).toHaveBeenCalledOnce();
  });

  it.each([
    ["same", "2.1.0"],
    ["older", "2.2.0"],
  ])("returns up-to-date for a %s latest release without downloading", async (_label, currentVersion) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(release("2.1.0", "a".repeat(64)), RELEASE_API_URL));
    await expect(updateVspi(currentVersion, { fetch })).resolves.toEqual({
      status: "up-to-date",
      currentVersion,
      latestVersion: "2.1.0",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("loads the real GitHub latest fixture and rejects its legacy body without SHA-256", async () => {
    await expect(
      updateVspi("1.4.4", { fetch: vi.fn(async () => response(releaseFixture, RELEASE_API_URL)) }),
    ).rejects.toThrow("VSPi 1.4.5 Release 缺少 SHA-256");
  });

  it.each([
    ["prerelease tag", { tag_name: "v2.1.0-rc.1" }, "GitHub Release tag"],
    ["missing checksum", { body: "No checksum" }, "缺少 SHA-256"],
    ["wrong asset name", { assets: [{ name: "vspi.tgz", browser_download_url: assetUrl("2.1.0") }] }, "受信任的安装包"],
    [
      "malicious asset URL",
      { assets: [{ name: "vspi-2.1.0.tgz", browser_download_url: "https://example.test/vspi-2.1.0.tgz" }] },
      "受信任的安装包",
    ],
    [
      "wrong repository URL",
      { assets: [{ name: "vspi-2.1.0.tgz", browser_download_url: `${githubOrigin}/other/VSPi/releases/download/v2.1.0/vspi-2.1.0.tgz` }] },
      "受信任的安装包",
    ],
    [
      "duplicate trusted asset",
      { assets: [releaseAsset("2.1.0"), releaseAsset("2.1.0")] },
      "唯一受信任的安装包",
    ],
  ])("rejects %s", async (_label, override, message) => {
    await expect(
      updateVspi("2.0.0", {
        fetch: vi.fn(async () => response({ ...release("2.1.0", "a".repeat(64)), ...override }, RELEASE_API_URL)),
      }),
    ).rejects.toThrow(message);
  });

  it("rejects an untrusted API URL and API redirects", async () => {
    await expect(
      updateVspi("2.0.0", { releaseApiUrl: "https://example.test/latest", fetch: vi.fn() }),
    ).rejects.toThrow("API 地址不受信任");
    await expect(
      updateVspi("2.0.0", {
        fetch: vi.fn(async () => response(undefined, RELEASE_API_URL, 302, { location: RELEASE_API_URL })),
      }),
    ).rejects.toThrow("API 不允许重定向");
  });

  it.each([
    [404, {}, "未找到 VSPi Release"],
    [403, { "x-ratelimit-remaining": "0" }, "请求频率受限"],
    [429, { "retry-after": "60" }, "60 秒后重试"],
    [500, {}, "HTTP 500"],
  ])("reports GitHub API HTTP %s", async (status, headers, message) => {
    await expect(
      updateVspi("2.0.0", { fetch: vi.fn(async () => response(undefined, RELEASE_API_URL, status, headers)) }),
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
      .mockResolvedValueOnce(response(release("2.1.0", "a".repeat(64)), RELEASE_API_URL))
      .mockResolvedValueOnce(response(undefined, assetUrl("2.1.0"), 302, { location }));
    await expect(updateVspi("2.0.0", { fetch })).rejects.toThrow(message);
  });

  it("rejects missing redirect locations, too many redirects, and an untrusted final response URL", async () => {
    const value = release("2.1.0", "a".repeat(64));
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchSequence(response(value, RELEASE_API_URL), response(undefined, assetUrl("2.1.0"), 302)),
      }),
    ).rejects.toThrow("缺少 Location");

    const redirects = Array.from({ length: 6 }, (_, index) =>
      response(undefined, `${assetCdnOrigin}/asset-${index}`, 302, { location: `${assetCdnOrigin}/asset-${index + 1}` }),
    );
    await expect(
      updateVspi("2.0.0", { fetch: fetchSequence(response(value, RELEASE_API_URL), ...redirects) }),
    ).rejects.toThrow("重定向次数过多");

    await expect(
      updateVspi("2.0.0", {
        fetch: fetchSequence(
          response(value, RELEASE_API_URL),
          response("package", "https://example.test/package.tgz"),
        ),
      }),
    ).rejects.toThrow("地址不受信任");
  });

  it("rejects checksum mismatch and declared or actual oversized packages", async () => {
    const asset = assetUrl("2.1.0");
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchPair(release("2.1.0", "a".repeat(64)), response("wrong", asset)),
      }),
    ).rejects.toThrow("SHA-256");
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchPair(
          release("2.1.0", "a".repeat(64)),
          response("small", asset, 200, { "content-length": String(64 * 1024 * 1024 + 1) }),
        ),
      }),
    ).rejects.toThrow("64 MiB");
    const oversized = Buffer.alloc(64 * 1024 * 1024 + 1);
    await expect(
      updateVspi("2.0.0", {
        fetch: fetchPair(release("2.1.0", sha256(oversized)), response(oversized, asset)),
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
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "install", "--global", "--no-audit", "--no-fund", expect.any(String)],
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

function release(version: string, checksum: string): Record<string, unknown> {
  return {
    ...releaseFixture,
    tag_name: `v${version}`,
    body: `SHA-256: \`${checksum}\``,
    assets: [releaseAsset(version)],
  };
}

function releaseAsset(version: string): Record<string, unknown> {
  return { name: `vspi-${version}.tgz`, browser_download_url: assetUrl(version) };
}

function assetUrl(version: string): string {
  return `${githubOrigin}/HypoxanthineOvO/VSPi/releases/download/v${version}/vspi-${version}.tgz`;
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

function fetchPair(releaseValue: unknown, packageResponse: Response): typeof globalThis.fetch {
  return fetchSequence(response(releaseValue, RELEASE_API_URL), packageResponse);
}

function fetchSequence(...responses: Response[]): typeof globalThis.fetch {
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
