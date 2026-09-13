import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DISTRIBUTION_ORIGINS,
  downloadDistributionRelease,
  selectDistributionRelease,
  verifyDistributionManifest,
  withDistributionTrust,
  type DistributionManifest,
} from '../src/v1/update/distribution.js';
import { updateVspi } from '../src/v1/update/self-update.js';

const cleanups: Array<() => Promise<void>> = [];
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
function fixture() {
  const key = generateKeyPairSync('ed25519');
  const trust = { publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const bytes = Buffer.from('example release bytes');
  const manifest: DistributionManifest = {
    schemaVersion: 1,
    product: 'vspi',
    version: '2.4.0',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    artifact: {
      path: '/vspi/releases/2.4.0/vspi-2.4.0.tgz',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const envelope = (value: DistributionManifest = manifest) => {
    const payload = Buffer.from(JSON.stringify(value));
    return Buffer.from(
      JSON.stringify({
        payload: payload.toString('base64'),
        signature: sign(null, payload, key.privateKey).toString('base64'),
      }),
    );
  };
  return { bytes, manifest, trust, envelope };
}

describe('signed dual-entry distribution', () => {
  it('prefers the internal entry when its signed manifest is valid', async () => {
    const r = fixture();
    const requested: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requested.push(requestUrl(input));
      return new Response(r.envelope());
    };
    const release = await selectDistributionRelease(r.trust, {
      fetch: fetcher,
      minimumVersion: '2.3.0',
    });
    expect(release.source).toBe('internal');
    expect(requested).toEqual([`${DISTRIBUTION_ORIGINS.internal}/vspi/latest.json`]);
  });

  it('uses the public entry when the internal network is unreachable', async () => {
    const r = fixture();
    const fetcher: typeof fetch = async (input) => {
      if (requestUrl(input).startsWith(DISTRIBUTION_ORIGINS.internal)) throw new Error('unreachable');
      return new Response(r.envelope());
    };
    expect((await selectDistributionRelease(r.trust, { fetch: fetcher })).source).toBe('public');
  });

  it.each(['signature', 'expired', 'rollback', 'path'])(
    'rejects a manifest with an invalid %s',
    (defect) => {
      const r = fixture();
      let bytes = r.envelope();
      let minimum = '2.3.0';
      if (defect === 'signature') {
        const envelope = JSON.parse(bytes.toString());
        envelope.signature = Buffer.alloc(64).toString('base64');
        bytes = Buffer.from(JSON.stringify(envelope));
      }
      if (defect === 'expired')
        bytes = r.envelope({
          ...r.manifest,
          issuedAt: '2020-01-01T00:00:00Z',
          expiresAt: '2020-01-02T00:00:00Z',
        });
      if (defect === 'rollback') minimum = '2.5.0';
      if (defect === 'path')
        bytes = r.envelope({
          ...r.manifest,
          artifact: { ...r.manifest.artifact, path: '/../../private' },
        });
      expect(() => verifyDistributionManifest(bytes, r.trust, minimum)).toThrow();
    },
  );

  it('retries the identical signed artifact at the other entry after corrupted bytes', async () => {
    const r = fixture();
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      paths.push(requestUrl(input));
      return new Response(
        requestUrl(input).startsWith(DISTRIBUTION_ORIGINS.internal) ? 'bad' : r.bytes,
      );
    };
    expect(
      await downloadDistributionRelease(
        { source: 'internal', manifest: r.manifest },
        { fetch: fetcher },
      ),
    ).toEqual(r.bytes);
    expect(paths).toEqual([
      `${DISTRIBUTION_ORIGINS.internal}${r.manifest.artifact.path}`,
      `${DISTRIBUTION_ORIGINS.public}${r.manifest.artifact.path}`,
    ]);
  });

  it('does not install when both entries return corrupt package data', async () => {
    const r = fixture();
    let installed = false;
    const fetcher: typeof fetch = async (input) =>
      new Response(requestUrl(input).endsWith('latest.json') ? r.envelope() : Buffer.from('corrupt'));
    await expect(
      updateVspi('2.3.0', {
        distribution: { trust: r.trust },
        fetch: fetcher,
        installPackage: async () => {
          installed = true;
        },
      }),
    ).rejects.toThrow('校验');
    expect(installed).toBe(false);
  });

  it('passes only verified bytes to the existing installation boundary', async () => {
    const r = fixture();
    let received: Buffer | undefined;
    const result = await updateVspi('2.3.0', {
      distribution: { trust: r.trust },
      fetch: async (input) =>
        new Response(requestUrl(input).endsWith('latest.json') ? r.envelope() : r.bytes),
      installPackage: async (path) => {
        received = await readFile(path);
      },
    });
    expect(result).toMatchObject({ status: 'updated', latestVersion: '2.4.0' });
    expect(received).toEqual(r.bytes);
  });

  it('retains the highest observed version across checks', async () => {
    const r = fixture();
    const home = await mkdtemp(join(tmpdir(), 'vspi-trust-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, 'distribution.json'), JSON.stringify(r.trust), { mode: 0o600 });
    await withDistributionTrust(
      '2.3.0',
      async (_trust, minimum, remember) => {
        expect(minimum).toBe('2.3.0');
        await remember('2.4.0');
      },
      home,
    );
    await withDistributionTrust(
      '2.3.0',
      async (_trust, minimum) => {
        expect(minimum).toBe('2.4.0');
      },
      home,
    );
  });
});
