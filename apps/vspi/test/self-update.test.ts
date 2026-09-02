import { createHash } from "node:crypto";
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
const origin = "https://gitlab.vsplab.cn";


afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VSPi self-update contract", () => {
	it("accepts the exact stable release asset, checksum, and same-origin redirect", async () => {
		const bytes = Buffer.from("package");
		const version = "2.1.0";
		const asset = `${origin}/heyx/vspi/-/releases/v${version}/downloads/vspi-${version}.tgz`;
		const installPackage = vi.fn(async () => undefined);
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(response(release(version, asset, sha256(bytes)), RELEASE_API_URL))
			.mockResolvedValueOnce(response(undefined, asset, 302, { location: "/trusted-package" }))
			.mockResolvedValueOnce(response(bytes, `${origin}/trusted-package`, 200, { "content-length": String(bytes.length) }));
		await expect(updateVspi("2.0.0", { fetch, installPackage })).resolves.toEqual({
			status: "updated",
			currentVersion: "2.0.0",
			latestVersion: version,
		});
		expect(fetch.mock.calls.map((call) => call[1]?.redirect)).toEqual(["manual", "manual", "manual"]);
		expect(installPackage).toHaveBeenCalledOnce();
	});

	it.each([
		["prerelease tag", "v2.1.0-rc.1", "GitLab Release tag"],
		["wrong asset URL", "v2.1.0", "受信任的安装包"],
	])("rejects %s", async (_label, tag, message) => {
		const version = "2.1.0";
		const asset = `${origin}/heyx/vspi/-/releases/v${version}/downloads/vspi-${version}.tgz`;
		const value = release(version, tag === "v2.1.0" ? `${origin}/other.tgz` : asset, "a".repeat(64));
		value.tag_name = tag;
		await expect(updateVspi("2.0.0", { fetch: vi.fn(async () => response(value, RELEASE_API_URL)) })).rejects.toThrow(message);
	});

	it("rejects untrusted initial URLs and cross-origin redirects", async () => {
		await expect(
			updateVspi("2.0.0", { releaseApiUrl: "https://example.test/latest", fetch: vi.fn() }),
		).rejects.toThrow("地址不受信任");
		const bytes = Buffer.from("package");
		const asset = `${origin}/heyx/vspi/-/releases/v2.1.0/downloads/vspi-2.1.0.tgz`;
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(response(release("2.1.0", asset, sha256(bytes)), RELEASE_API_URL))
			.mockResolvedValueOnce(response(undefined, asset, 302, { location: "https://example.test/package.tgz" }));
		await expect(updateVspi("2.0.0", { fetch })).rejects.toThrow("地址不受信任");
	});

	it("rejects checksum mismatch and declared or actual oversized packages", async () => {
		const asset = `${origin}/heyx/vspi/-/releases/v2.1.0/downloads/vspi-2.1.0.tgz`;
		await expect(
			updateVspi("2.0.0", {
				fetch: fetchPair(release("2.1.0", asset, "a".repeat(64)), response("wrong", asset)),
			}),
		).rejects.toThrow("SHA-256");
		await expect(
			updateVspi("2.0.0", {
				fetch: fetchPair(
					release("2.1.0", asset, "a".repeat(64)),
					response("small", asset, 200, { "content-length": String(64 * 1024 * 1024 + 1) }),
				),
			}),
		).rejects.toThrow("64 MiB");
		const oversized = Buffer.alloc(64 * 1024 * 1024 + 1);
		await expect(
			updateVspi("2.0.0", {
				fetch: fetchPair(release("2.1.0", asset, sha256(oversized)), response(oversized, asset)),
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

function release(version: string, asset: string, checksum: string) {
	const filename = `vspi-${version}.tgz`;
	return {
		tag_name: `v${version}`,
		description: `SHA-256: \`${checksum}\``,
		assets: { links: [{ name: filename, direct_asset_url: asset }] },
	};
}

function response(body: unknown, url: string, status = 200, headers: Record<string, string> = {}): Response {
	const bytes = body instanceof Uint8Array ? Buffer.from(body) : typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body);
	const value = new Response(bytes, { status, headers });
	Object.defineProperty(value, "url", { value: url });
	return value;
}

function fetchPair(releaseValue: unknown, packageResponse: Response): typeof globalThis.fetch {
	return vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(releaseValue, RELEASE_API_URL)).mockResolvedValueOnce(packageResponse);
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}
