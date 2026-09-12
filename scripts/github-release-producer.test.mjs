import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { produceGitHubRelease } from './github-release-producer.mjs';

await test('publishes a platform-limited stable release without promoting the shared latest channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspi-publish-test-'));
  const bytes = Buffer.from('example-package');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const assetPath = join(root, 'vspi-1.2.3.tgz');
  const latestAssetPath = join(root, 'vspi-latest.tgz');
  const checksumsPath = join(root, 'SHA256SUMS');
  const packageJsonPath = join(root, 'package.json');
  const api = 'https://api.example.test/repos/example/vspi/releases';
  let release;
  let publication;
  const uploaded = new Map();
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    if (url === `${api}/tags/v1.2.3`) return release ? json(release) : new Response('', { status: 404 });
    if (url === `${api}?per_page=100`) return json(release ? [release] : []);
    if (url === api && init.method === 'POST') {
      release = { ...JSON.parse(init.body), id: 1, upload_url: 'https://uploads.example.test/assets{?name,label}', assets: [] };
      return json(release);
    }
    if (url.startsWith('https://uploads.example.test/assets?') && init.method === 'POST') {
      const name = new URL(url).searchParams.get('name');
      const asset = { name, url: `https://api.example.test/assets/${encodeURIComponent(name)}` };
      uploaded.set(asset.url, Buffer.from(init.body));
      release.assets.push(asset);
      return json(asset);
    }
    if (uploaded.has(url)) return new Response(uploaded.get(url));
    if (url === `${api}/1` && init.method === 'PATCH') {
      publication = JSON.parse(init.body);
      release = { ...release, ...publication };
      return json(release);
    }
    throw new Error(`Unexpected mock request: ${init.method} ${url}`);
  };
  try {
    await Promise.all([
      writeFile(assetPath, bytes), writeFile(latestAssetPath, bytes),
      writeFile(checksumsPath, `${hash}  vspi-1.2.3.tgz\n${hash}  vspi-latest.tgz\n`),
      writeFile(packageJsonPath, JSON.stringify({ version: '1.2.3' })),
    ]);
    const options = {
      environment: { GITHUB_REF_NAME: 'v1.2.3', GITHUB_API_URL: 'https://api.example.test', GITHUB_REPOSITORY: 'example/vspi', GITHUB_TOKEN: 'YOUR_API_KEY', GITHUB_RELEASE_MAKE_LATEST: 'false', GITHUB_RELEASE_NOTES: 'Linux first; Windows verification pending.' },
      packageJsonPath, assetPath, latestAssetPath, checksumsPath, metadataPath: join(root, 'result.json'), fetch,
    };
    const result = await produceGitHubRelease(options);
    assert.deepEqual(publication, { draft: false, prerelease: false, make_latest: 'false' });
    assert.equal(release.body, `SHA-256: \`${hash}\`\n\nLinux first; Windows verification pending.`);
    assert.equal(result.checksum, hash);
    assert.equal(uploaded.size, 3);
    assert.deepEqual(await produceGitHubRelease(options), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('rejects an invalid latest policy before contacting the release service', async () => {
  await assert.rejects(produceGitHubRelease({
    environment: { GITHUB_REF_NAME: 'v1.2.3', GITHUB_RELEASE_MAKE_LATEST: 'invalid' },
    assetPath: 'vspi-1.2.3.tgz', latestAssetPath: 'vspi-latest.tgz', checksumsPath: 'SHA256SUMS',
    fetch: async () => { assert.fail('Invalid release policy must not contact the network'); },
  }), /GITHUB_RELEASE_MAKE_LATEST/);
});
