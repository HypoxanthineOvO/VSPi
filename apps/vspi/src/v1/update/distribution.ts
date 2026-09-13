import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireRuntimeLease, resolveRuntimePaths } from '@vsp/vsp-runtime';
import { readPrivateFile } from '../utils/private-file.js';

import {
  DISTRIBUTION_ORIGINS,
  compareReleaseVersions,
  verifyDistributionManifest,
  type DistributionSource,
  type DistributionTrust,
  type DistributionRelease,
} from './distribution-contract.js';
export {
  DISTRIBUTION_ORIGINS,
  MAX_DISTRIBUTION_PACKAGE,
  compareReleaseVersions,
  verifyDistributionManifest,
  type DistributionSource,
  type DistributionTrust,
  type DistributionRelease,
  type DistributionManifest,
} from './distribution-contract.js';

export async function readBoundedHttp(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Empty HTTP response');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error('HTTP response exceeds size limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  headerTimeoutMs = timeoutMs,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers = new AbortController();
  const timer = setTimeout(() => headers.abort(), headerTimeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.any([timeout, headers.signal, ...(signal ? [signal] : [])]),
      headers: { accept: 'application/json, application/octet-stream' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Distribution HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function selectDistributionRelease(
  trust: DistributionTrust,
  options: {
    source?: DistributionSource;
    minimumVersion?: string;
    fetch?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<DistributionRelease> {
  const sources: Array<keyof typeof DISTRIBUTION_ORIGINS> =
    options.source && options.source !== 'auto' ? [options.source] : ['internal', 'public'];
  const failures: string[] = [];
  for (const source of sources) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      const response = await request(
        `${DISTRIBUTION_ORIGINS[source]}/vspi/latest.json`,
        source === 'internal' ? 1500 : 10000,
        options.fetch ?? fetch,
        options.signal,
      );
      const manifest = verifyDistributionManifest(
        await readBoundedHttp(response, 64 * 1024),
        trust,
        options.minimumVersion,
      );
      return { manifest, source };
    } catch {
      failures.push(source);
    }
  }
  if (options.signal?.aborted) throw options.signal.reason;
  throw new Error(`可信分发源不可用或清单校验失败（${failures.join(', ')}）；没有退回未验证下载`);
}

export async function downloadDistributionRelease(
  release: DistributionRelease,
  options: { source?: DistributionSource; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const first = release.source;
  const sources: Array<keyof typeof DISTRIBUTION_ORIGINS> =
    options.source && options.source !== 'auto'
      ? [options.source]
      : [first, first === 'internal' ? 'public' : 'internal'];
  for (const source of sources) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      const response = await request(
        `${DISTRIBUTION_ORIGINS[source]}${release.manifest.artifact.path}`,
        source === 'internal' ? 30000 : 120000,
        options.fetch ?? fetch,
        options.signal,
        source === 'internal' ? 1500 : 10000,
      );
      const bytes = await readBoundedHttp(response, release.manifest.artifact.bytes);
      if (
        bytes.length !== release.manifest.artifact.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== release.manifest.artifact.sha256
      )
        throw new Error('Release package checksum mismatch');
      return bytes;
    } catch {}
  }
  if (options.signal?.aborted) throw options.signal.reason;
  throw new Error('所有允许分发源下载失败或包校验不符；没有安装任何文件');
}

export async function withDistributionTrust<T>(
  currentVersion: string,
  run: (
    trust: DistributionTrust,
    minimumVersion: string,
    remember: (version: string) => Promise<void>,
  ) => Promise<T>,
  home?: string,
): Promise<T> {
  const paths = resolveRuntimePaths(home);
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  const trust = JSON.parse(
    (await readPrivateFile(join(paths.homeDir, 'distribution.json'), 16384)).toString('utf8'),
  ) as DistributionTrust;
  if (
    typeof trust.publicKey !== 'string' ||
    createPublicKey(trust.publicKey).asymmetricKeyType !== 'ed25519'
  )
    throw new Error('请先配置经独立核对的分发公钥');
  const lock = await acquireRuntimeLease(join(paths.homeDir, 'distribution.lock'));
  try {
    let minimumVersion = currentVersion;
    try {
      const state = JSON.parse(
        (await readPrivateFile(join(paths.homeDir, 'distribution-state.json'), 4096)).toString(
          'utf8',
        ),
      ) as { version: string };
      if (compareReleaseVersions(state.version, minimumVersion) > 0) minimumVersion = state.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return await run(trust, minimumVersion, async (version) => {
      if (compareReleaseVersions(version, minimumVersion) < 0)
        throw new Error('Refusing release metadata rollback');
      const temporary = join(paths.homeDir, `distribution-state.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ version }));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, join(paths.homeDir, 'distribution-state.json'));
        if (process.platform !== 'win32') {
          const dir = await open(paths.homeDir, 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    });
  } finally {
    await lock.release();
  }
}
