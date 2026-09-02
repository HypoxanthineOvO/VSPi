import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseVspiRelease } from "./release-contract.mjs";

const PROJECT_ORIGIN = "https://gitlab.vsplab.cn";
const PROJECT_PATH = "heyx/vspi";
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
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

export interface PackageInstallerInvocation {
  command: string;
  args: string[];
  manager: "npm" | "volta";
}

export interface PackageInstallerOptions {
  environment?: NodeJS.ProcessEnv;
  entryPath?: string;
  platform?: NodeJS.Platform;
  execute?: (invocation: PackageInstallerInvocation, environment: NodeJS.ProcessEnv) => Promise<void>;
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

function trustedUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== PROJECT_ORIGIN) throw new Error("VSPi 更新地址不受信任");
  return url;
}

async function fetchChecked(fetchImpl: typeof globalThis.fetch, value: string, timeoutMs: number): Promise<Response> {
  let url = trustedUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) throw new Error(`请求 ${url.href} 失败：HTTP ${response.status}`);
      if (response.url) trustedUrl(response.url);
      return response;
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("VSPi 更新重定向缺少 Location");
    if (redirects === MAX_REDIRECTS) throw new Error("VSPi 更新重定向次数过多");
    url = trustedUrl(new URL(location, url).href);
  }
  throw new Error("VSPi 更新重定向次数过多");
}

function pathIsWithin(path: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function resolvePackageInstaller(
  tarballPath: string,
  entryPath = process.argv[1],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PackageInstallerInvocation {
  const voltaHome = environment.VOLTA_HOME;
  if (entryPath && voltaHome && pathIsWithin(entryPath, join(voltaHome, "tools", "image", "packages", "vspi"))) {
    return {
      command: join(voltaHome, "bin", platform === "win32" ? "volta.exe" : "volta"),
      args: ["install", `vspi@${resolve(tarballPath)}`],
      manager: "volta",
    };
  }
  const npmArgs = ["install", "--global", "--no-audit", "--no-fund", resolve(tarballPath)];
  if (platform === "win32") {
    return {
      command: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...npmArgs],
      manager: "npm",
    };
  }
  return {
    command: "npm",
    args: npmArgs,
    manager: "npm",
  };
}

async function executeInstaller(invocation: PackageInstallerInvocation, environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        env: { ...environment, npm_config_update_notifier: "false" },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180_000,
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim().split("\n").at(-1);
        const label = invocation.manager === "volta" ? "Volta" : "npm";
        reject(new Error(detail ? `${label} 安装失败：${detail}` : `${label} 安装失败：${error.message}`));
      },
    );
  });
}

async function entryPackageVersion(entryPath: string): Promise<string | undefined> {
  try {
    let directory = dirname(await realpath(entryPath));
    for (let depth = 0; depth < 5; depth += 1) {
      try {
        const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const manifest = value as Record<string, unknown>;
          if (manifest.name === "vspi" && typeof manifest.version === "string") return manifest.version;
        }
      } catch {
        // The executable may be a package-manager symlink several levels below its manifest.
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function installVspiPackage(
  tarballPath: string,
  expectedVersion: string,
  options: PackageInstallerOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const entryPath = options.entryPath ?? process.argv[1];
  if (!entryPath) throw new Error("无法识别当前 VSPi 安装位置");
  const invocation = resolvePackageInstaller(tarballPath, entryPath, environment, options.platform);
  await (options.execute ?? executeInstaller)(invocation, environment);
  const installedVersion = await entryPackageVersion(entryPath);
  if (installedVersion !== expectedVersion) {
    const actual = installedVersion ? `仍为 ${installedVersion}` : "无法读取版本";
    throw new Error(`安装命令已结束，但当前 VSPi ${actual}；请检查是否存在多个全局安装位置`);
  }
}

export async function updateVspi(currentVersion: string, options: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  parseVersion(currentVersion);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("当前 Node.js 不支持 fetch，无法检查更新");

  const releaseResponse = await fetchChecked(fetchImpl, options.releaseApiUrl ?? RELEASE_API_URL, 15_000);
  const release = parseVspiRelease(await releaseResponse.json());
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
    if (options.installPackage) await options.installPackage(tarballPath);
    else await installVspiPackage(tarballPath, release.version);
    return { status: "updated", currentVersion, latestVersion: release.version };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
