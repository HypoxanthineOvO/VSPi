import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { once } from 'node:events';
import { EnvHttpProxyAgent, getGlobalDispatcher } from 'undici';
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUpdateTransport,
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VSPi GitHub self-update contract", () => {
  it('uses a private environment dispatcher by default and leaves injected fetch untouched', async () => {
    const globalDispatcher = getGlobalDispatcher();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(latestRedirect('2.1.0'));
    await updateVspi('2.1.0');
    expect((fetch.mock.calls[0]?.[1] as RequestInit & { dispatcher: unknown }).dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    expect(getGlobalDispatcher()).toBe(globalDispatcher);
    fetch.mockClear();
    const injected = fetchSequence(latestRedirect('2.1.0'));
    await updateVspi('2.1.0', { fetch: injected });
    expect(fetch).not.toHaveBeenCalled();
    expect(injected.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher');
  });

  it('honors environment proxies and NO_PROXY without changing the global dispatcher', async () => {
    const origin = createServer((_request, response) => { response.end('local fixture'); });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const address = origin.address();
    if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
    let tunnels = 0;
    const proxy = createServer();
    proxy.on('connect', (_request, client, head) => {
      tunnels++;
      const upstream = connectSocket(address.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      client.on('close', () => upstream.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing local proxy address');
    const url = `http://127.0.0.1:${address.port}/`;
    const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
    const transports = [
      createUpdateTransport({ http_proxy: proxyUrl, HTTP_PROXY: 'http://127.0.0.1:1', no_proxy: '' }),
      createUpdateTransport({ HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1' }),
      createUpdateTransport({}),
    ];
    const globalDispatcher = getGlobalDispatcher();
    try {
      for (const [index, transport] of transports.entries()) {
        expect(await (await transport.fetch(url)).text()).toBe('local fixture');
        expect(tunnels).toBe(1);
        if (index === 0) expect(getGlobalDispatcher()).toBe(globalDispatcher);
      }
    } finally {
      await Promise.all(transports.map(transport => transport.close()));
      origin.closeAllConnections(); proxy.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => origin.close(() => { resolve(); })), new Promise<void>(resolve => proxy.close(() => { resolve(); }))]);
    }
  });

  it('does not expose proxy credentials when the proxy configuration is invalid', () => {
    expect(() => createUpdateTransport({ HTTPS_PROXY: 'http://private-user:private-password@example.test:invalid/private-path' })).toThrow('更新代理配置无效');
    try { createUpdateTransport({ HTTPS_PROXY: 'http://private-user:private-password@example.test:invalid/private-path' }); }
    catch (error) { expect(String(error)).not.toMatch(/private-user|private-password|private-path/u); }
  });

  it('allows a continuously progressing package stream to exceed the former 60 second limit', async () => {
    vi.useFakeTimers();
    const bytes = Buffer.from('package');
    const installPackage = vi.fn(async () => undefined);
    const progress: Array<{ stage: string; bytes: number }> = [];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const fetch = fetchSequence(latestRedirect('2.1.0'), response(checksumText('2.1.0', bytes), checksumUrl('2.1.0')), response(timedStream(['pa', 'ck', 'ag', 'e'], 20_000), assetUrl('2.1.0')));
    const update = updateVspi('2.0.0', { fetch, installPackage, onProgress: value => { progress.push(value); if (value.stage === 'package') started(); } });
    await ready;
    await vi.advanceTimersByTimeAsync(80_001);
    await expect(update).resolves.toMatchObject({ status: 'updated' });
    expect(installPackage).toHaveBeenCalledOnce();
    expect(progress.filter(value => value.stage === 'package').map(value => value.bytes)).toEqual([0, 2, 4, 6, 7]);
    expect(progress.map(value => value.stage)).toContain('verify');
  });

  it('bounds total package duration even while bytes continue arriving', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const fetch = fetchSequence(latestRedirect('2.1.0'), response(checksumText('2.1.0', Buffer.from('package')), checksumUrl('2.1.0')), response(timedStream(Array.from({ length: 20 }, () => 'data'), 20_000), assetUrl('2.1.0')));
    const installPackage = vi.fn();
    const update = updateVspi('2.0.0', { fetch, installPackage, onProgress: value => { if (value.stage === 'package') started(); } });
    const failure = expect(update).rejects.toThrow(/下载更新包失败.*已下载.*超过总下载时限.*vspi update/u);
    await ready;
    await vi.advanceTimersByTimeAsync(300_001);
    await failure;
    expect(installPackage).not.toHaveBeenCalled();
  });

  it('reports downloaded bytes and cancels a stalled body without installing', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let heartbeat: NodeJS.Timeout;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('part'));
        heartbeat = setInterval(() => { controller.enqueue(new Uint8Array()); }, 5_000);
      },
      cancel() { clearInterval(heartbeat); cancel(); },
    });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const installPackage = vi.fn();
    const update = updateVspi('2.0.0', { fetch: fetchSequence(latestRedirect('2.1.0'), response(checksumText('2.1.0', Buffer.from('package')), checksumUrl('2.1.0')), response(body, assetUrl('2.1.0'))), installPackage, onProgress: value => { if (value.stage === 'package' && value.bytes > 0) started(); } });
    const failure = expect(update).rejects.toThrow(/下载更新包失败.*已下载 4 字节.*30 秒没有下载进展.*vspi update/u);
    await ready;
    await vi.advanceTimersByTimeAsync(30_001);
    await failure;
    expect(cancel).toHaveBeenCalledOnce();
    expect(installPackage).not.toHaveBeenCalled();
  });

  it('reports the metadata stage when release discovery times out or the network fails', async () => {
    vi.useFakeTimers();
    const stuckBody = new ReadableStream({ cancel: () => new Promise<void>(() => {}) });
    for (const fetch of [vi.fn(() => new Promise<Response>(() => {})), fetchSequence(response(stuckBody, LATEST_RELEASE_URL, 302, { location: `${githubOrigin}/HypoxanthineOvO/VSPi/releases/tag/v2.1.0` }))]) {
      const update = updateVspi('2.0.0', { fetch });
      const failure = expect(update).rejects.toThrow(/检查最新版本失败.*已下载 0 字节.*总下载时限/u);
      await vi.advanceTimersByTimeAsync(15_001);
      await failure;
    }
    const networkError = await updateVspi('2.0.0', { fetch: vi.fn(async () => { throw new Error('https://private-user:private-password@example.test/private-token'); }) }).catch(error => error as Error);
    if (!(networkError instanceof Error)) throw new Error('Expected a network failure');
    expect(networkError.message).toContain('网络连接失败');
    expect(networkError.message).not.toMatch(/private-user|private-password|private-token/u);
    expect(networkError).not.toHaveProperty('cause');
  });

  it('cancels an in-progress update and cleans its temporary files without touching installation', async () => {
    const root = await temporaryDirectory('vspi-cancel-update-');
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(Buffer.from('part')); }, cancel });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const installPackage = vi.fn();
    const update = updateVspi('2.0.0', { fetch: fetchSequence(latestRedirect('2.1.0'), response(checksumText('2.1.0', Buffer.from('package')), checksumUrl('2.1.0')), response(body, assetUrl('2.1.0'))), signal: controller.signal, temporaryRoot: root, installPackage, onProgress: value => { if (value.stage === 'package' && value.bytes > 0) started(); } });
    const failure = expect(update).rejects.toThrow(/更新已取消/u);
    await ready; controller.abort(); await failure;
    expect(cancel).toHaveBeenCalledOnce();
    expect(installPackage).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects already canceled updates before making requests', async () => {
    const fetch = vi.fn();
    await expect(updateVspi('2.0.0', { fetch, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

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
    body instanceof ReadableStream
      ? body
      : body instanceof Uint8Array
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

function timedStream(parts: string[], interval: number): ReadableStream<Uint8Array> {
  const timers: NodeJS.Timeout[] = [];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part, index) => timers.push(setTimeout(() => {
        controller.enqueue(Buffer.from(part));
        if (index === parts.length - 1) controller.close();
      }, interval * (index + 1))));
    },
    cancel() { for (const timer of timers) clearTimeout(timer); },
  });
}
