import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseReleaseChecksums, releaseVersionFromLatestRedirect } from "./release-contract.mjs";
import { npmCommand } from './npm-command.mjs';
import { acquireRuntimeLease, inspectRuntime, stopRuntime, resolveRuntimePaths } from '@vsp/vsp-runtime';

const RELEASE_DOWNLOAD_ORIGIN = "https://github.com";
const RELEASE_ASSET_ORIGINS = new Set([
  "https://github-releases.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
]);
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
export const LATEST_RELEASE_URL = "https://github.com/HypoxanthineOvO/VSPi/releases/latest";

export interface SelfUpdateResult {
  status: "up-to-date" | "updated";
  currentVersion: string;
  latestVersion: string;
  runtimeRestarted?: boolean;
}

export interface SelfUpdateOptions {
  fetch?: typeof globalThis.fetch;
  installPackage?: (tarballPath: string) => Promise<void>;
  latestReleaseUrl?: string;
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

function trustedLatestReleaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.href !== LATEST_RELEASE_URL) throw new Error("VSPi latest Release 地址不受信任");
  return url;
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("VSPi 更新地址必须使用 HTTPS");
  if (url.username || url.password) throw new Error("VSPi 更新地址不受信任");
  return url;
}

function trustedDownloadUrl(value: string): URL {
  const url = httpsUrl(value);
  if (url.origin !== RELEASE_DOWNLOAD_ORIGIN && !RELEASE_ASSET_ORIGINS.has(url.origin))
    throw new Error("VSPi 更新地址不受信任");
  return url;
}

function trustedRedirectUrl(value: string): URL {
  const url = httpsUrl(value);
  if (!RELEASE_ASSET_ORIGINS.has(url.origin)) throw new Error("VSPi 更新重定向地址不受信任");
  return url;
}

function githubReleaseError(response: Response, url: URL): Error {
  if (response.status === 404) return new Error("GitHub 上未找到 VSPi Release");
  const retryAfter = response.headers.get("retry-after");
  if (response.status === 429 && retryAfter) {
    return new Error(`GitHub Release 请求频率受限，请在 ${retryAfter} 秒后重试`);
  }
  return new Error(`请求 ${url.href} 失败：HTTP ${response.status}`);
}

async function fetchLatestVersion(fetchImpl: typeof globalThis.fetch, value: string): Promise<string> {
  const url = trustedLatestReleaseUrl(value);
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "VSPi-Updater" },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (response.status < 300 || response.status >= 400) {
    if (!response.ok) throw githubReleaseError(response, url);
    throw new Error("GitHub latest Release 缺少版本重定向");
  }
  const location = response.headers.get("location");
  if (!location) throw new Error("GitHub latest Release 重定向缺少 Location");
  return releaseVersionFromLatestRedirect(new URL(location, url).href);
}

function githubReleaseAssetUrl(version: string, filename: string): string {
  return `${RELEASE_DOWNLOAD_ORIGIN}/HypoxanthineOvO/VSPi/releases/download/v${version}/${filename}`;
}

async function fetchPackage(fetchImpl: typeof globalThis.fetch, value: string): Promise<Response> {
  let url = trustedDownloadUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) throw new Error(`请求 ${url.href} 失败：HTTP ${response.status}`);
      if (response.url && response.url !== url.href) throw new Error("VSPi 更新最终地址不受信任");
      return response;
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("VSPi 更新重定向缺少 Location");
    if (redirects === MAX_REDIRECTS) throw new Error("VSPi 更新重定向次数过多");
    url = trustedRedirectUrl(new URL(location, url).href);
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
      ...npmCommand(npmArgs, platform),
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
        env: { ...environment, npm_config_update_notifier: "false", npm_config_ignore_scripts: 'true' },
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

  const latestVersion = await fetchLatestVersion(fetchImpl, options.latestReleaseUrl ?? LATEST_RELEASE_URL);
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { status: "up-to-date", currentVersion, latestVersion };
  }
  const filename = `vspi-${latestVersion}.tgz`;
  const checksumsResponse = await fetchPackage(
    fetchImpl,
    githubReleaseAssetUrl(latestVersion, "SHA256SUMS"),
  );
  const checksumBytes = await readLimitedResponse(checksumsResponse, 64 * 1024);
  const expectedChecksum = parseReleaseChecksums(checksumBytes.toString("utf8"), latestVersion);

  const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "vspi-update-"));
  const tarballPath = join(directory, filename);
  try {
    const packageResponse = await fetchPackage(
      fetchImpl,
      githubReleaseAssetUrl(latestVersion, filename),
    );
    const declaredSize = Number(packageResponse.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PACKAGE_BYTES)
      throw new Error("VSPi 更新包超过 64 MiB 上限");
    const packageBytes = await readLimitedResponse(packageResponse, MAX_PACKAGE_BYTES);
    await writeFile(tarballPath, packageBytes, { mode: 0o600 });
    const actualChecksum = createHash("sha256")
      .update(packageBytes)
      .digest("hex");
    if (actualChecksum !== expectedChecksum) throw new Error("VSPi 更新包 SHA-256 校验失败");
    if (options.installPackage) {
      await options.installPackage(tarballPath);
      return { status: 'updated', currentVersion, latestVersion };
    }
    const runtimeRestarted = await installVspiUpdate(tarballPath, latestVersion);
    return { status: "updated", currentVersion, latestVersion, runtimeRestarted };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readLimitedResponse(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('更新下载没有响应体');
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) throw new Error(`VSPi 下载超过 ${limit >= 1024 * 1024 ? `${limit / (1024 * 1024)} MiB` : `${limit / 1024} KiB`} 上限`);
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, total);
  } finally { await reader.cancel(); }
}

function execute(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message, { cause: error }));
      else resolve(stdout);
    });
  });
}

export interface InstallUpdateOptions {
  entryPath?: string;
  homeDir?: string;
  install?: (path: string, version: string) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

export async function installVspiUpdate(tarball: string, version: string, options: InstallUpdateOptions = {}): Promise<boolean> {
  const entry = await realpath(options.entryPath ?? process.argv[1] ?? '');
  const packageRoot = dirname(dirname(entry));
  const installId = createHash('sha256').update(packageRoot).digest('hex').slice(0, 16);
  const lock = await acquireRuntimeLease(join(dirname(packageRoot), `.vspi-update-${installId}.lock`));
  try {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string; private?: boolean };
  if (manifest.name !== 'vspi' || manifest.private || !manifest.version) throw new Error('自动升级仅支持已安装的 VSPi 发行包；源码工作区请使用构建流程');
  const paths = resolveRuntimePaths(options.homeDir);
  const env = { ...(options.environment ?? process.env), VSPI_HOME: paths.homeDir, npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true' };
  const backupRoot = join(paths.serverDir, 'update-backups');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backup = await mkdtemp(join(backupRoot, 'update-'));
  let keepBackup = false;
  try {
  const pack = npmCommand(['pack', packageRoot, '--pack-destination', backup, '--ignore-scripts', '--json']);
  await execute(pack.command, pack.args, env);
  const previousPackage = join(backup, `vspi-${manifest.version}.tgz`);
  await readFile(previousPackage);
  const originalConfig = await readFile(paths.configPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (originalConfig) await writeFile(join(backup, 'config.toml'), originalConfig, { mode: 0o600 });
  const running = await inspectRuntime(paths.homeDir);
  if (running) {
    try { await stopRuntime(paths.homeDir, 30_000, { requireIdle: true }); }
    catch (error) { keepBackup = (await inspectRuntime(paths.homeDir)) === undefined; throw error; }
  }
  keepBackup = true;
  const install = options.install ?? ((path: string, expected: string) => installVspiPackage(path, expected, { entryPath: entry, environment: env }));
  try {
    await install(tarball, version);
    const actual = (await execute(process.execPath, [entry, '--version'], env)).trim();
    if (actual !== version) throw new Error(`新入口版本不符：${actual}`);
    if (running) await execute(process.execPath, [entry, 'daemon', 'start'], env);
    await writeFile(join(backup, 'result.json'), JSON.stringify({ previous: manifest.version, installed: version, runtimeRestarted: Boolean(running) }), { mode: 0o600 });
    return Boolean(running);
  } catch (error) {
    try {
      if (await inspectRuntime(paths.homeDir)) await stopRuntime(paths.homeDir, 30_000, { requireIdle: true });
      await install(previousPackage, manifest.version);
      const config = await readFile(paths.configPath).catch((failure: NodeJS.ErrnoException) => { if (failure.code === 'ENOENT') return undefined; throw failure; });
      const unchanged = originalConfig === undefined ? config === undefined : config?.equals(originalConfig) === true;
      if (running && unchanged) await execute(process.execPath, [entry, 'daemon', 'start'], env);
      throw new Error(`升级失败，已恢复旧安装包${running && !unchanged ? '；配置已变化，未自动覆盖或启动旧 Daemon' : ''}。备份：${backup}`, { cause: error });
    } catch (recoveryError) {
      if (recoveryError instanceof Error && recoveryError.cause === error) throw recoveryError;
      throw new AggregateError([error, recoveryError], `升级及自动恢复未完成；已保留备份：${backup}`);
    }
  }
  } finally { if (!keepBackup) await rm(backup, { recursive: true, force: true }); }
  } finally { await lock.release(); }
}
