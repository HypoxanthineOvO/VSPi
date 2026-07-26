import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ORIGIN = "https://gitlab.vsplab.cn";
const PROJECT_PATH = "heyx/vspi";
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const RELEASE_API_URL = `${PROJECT_ORIGIN}/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/releases/permalink/latest`;

export interface SelfUpdateResult {
  status: "up-to-date" | "updated";
  currentVersion: string;
  latestVersion: string;
}

export interface SelfUpdateOptions {
  fetch?: typeof globalThis.fetch;
  installPackage?: (tarballPath: string) => Promise<void>;
  releaseApiUrl?: string;
  temporaryRoot?: string;
}

interface ParsedRelease {
  version: string;
  checksum: string;
  downloadUrl: string;
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`无效的 VSPi 版本：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效`);
  return value as Record<string, unknown>;
}

function parseRelease(value: unknown): ParsedRelease {
  const release = record(value, "GitLab Release");
  const tag = release.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("GitLab Release tag 不是稳定 SemVer");
  const version = tag.slice(1);
  parseVersion(version);

  const description = release.description;
  const checksum =
    typeof description === "string" ? /SHA-256:\s*`([a-f0-9]{64})`/i.exec(description)?.[1]?.toLowerCase() : undefined;
  if (!checksum) throw new Error(`VSPi ${version} Release 缺少 SHA-256`);

  const filename = `vspi-${version}.tgz`;
  const expectedUrl = `${PROJECT_ORIGIN}/${PROJECT_PATH}/-/releases/${tag}/downloads/${filename}`;
  const assets = record(release.assets, "GitLab Release assets");
  const links = assets.links;
  const matched = Array.isArray(links)
    ? links
        .map((link) => record(link, "GitLab Release asset"))
        .find((link) => link.name === filename && link.direct_asset_url === expectedUrl)
    : undefined;
  if (!matched) throw new Error(`VSPi ${version} Release 缺少受信任的安装包`);
  return { version, checksum, downloadUrl: expectedUrl };
}

async function fetchChecked(fetchImpl: typeof globalThis.fetch, url: string, timeoutMs: number): Promise<Response> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`请求 ${url} 失败：HTTP ${response.status}`);
  if (response.url && new URL(response.url).origin !== PROJECT_ORIGIN) {
    throw new Error("VSPi 更新下载被重定向到不受信任的地址");
  }
  return response;
}

async function npmInstallGlobal(tarballPath: string): Promise<void> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    execFile(
      npm,
      ["install", "--global", "--no-audit", "--no-fund", tarballPath],
      {
        env: { ...process.env, npm_config_update_notifier: "false" },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180_000,
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim().split("\n").at(-1);
        reject(new Error(detail ? `npm 安装失败：${detail}` : `npm 安装失败：${error.message}`));
      },
    );
  });
}

export async function updateVspi(currentVersion: string, options: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  parseVersion(currentVersion);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("当前 Node.js 不支持 fetch，无法检查更新");

  const releaseResponse = await fetchChecked(fetchImpl, options.releaseApiUrl ?? RELEASE_API_URL, 15_000);
  const release = parseRelease(await releaseResponse.json());
  if (compareVersions(release.version, currentVersion) <= 0) {
    return { status: "up-to-date", currentVersion, latestVersion: release.version };
  }

  const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "vspi-update-"));
  const tarballPath = join(directory, `vspi-${release.version}.tgz`);
  try {
    const packageResponse = await fetchChecked(fetchImpl, release.downloadUrl, 60_000);
    const declaredSize = Number(packageResponse.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PACKAGE_BYTES)
      throw new Error("VSPi 更新包超过 64 MiB 上限");
    const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
    if (packageBytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("VSPi 更新包超过 64 MiB 上限");
    await writeFile(tarballPath, packageBytes, { mode: 0o600 });
    const actualChecksum = createHash("sha256")
      .update(await readFile(tarballPath))
      .digest("hex");
    if (actualChecksum !== release.checksum) throw new Error("VSPi 更新包 SHA-256 校验失败");
    await (options.installPackage ?? npmInstallGlobal)(tarballPath);
    return { status: "updated", currentVersion, latestVersion: release.version };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
