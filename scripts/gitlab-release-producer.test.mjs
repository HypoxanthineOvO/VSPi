import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

import { prepareGitHubRelease, produceGitHubRelease } from './github-release-producer.mjs';
import { mirrorGitLabRelease, readGitHubSource } from './gitlab-release-producer.mjs';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(version = '2.0.0') {
  const directory = await mkdtemp(join(tmpdir(), 'vspi-release-producer-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const packageJsonPath = join(directory, 'package.json');
  const assetPath = join(directory, `vspi-${version}.tgz`);
  const latestAssetPath = join(directory, 'vspi-latest.tgz');
  const metadataPath = join(directory, 'metadata.json');
  const assetBytes = Buffer.from('offline-vspi-package');
  await writeFile(packageJsonPath, JSON.stringify({ name: 'vspi', version }));
  await writeFile(assetPath, assetBytes);
  await writeFile(latestAssetPath, assetBytes);
  return { packageJsonPath, assetPath, latestAssetPath, metadataPath, assetBytes };
}

function environment(overrides = {}) {
  return {
    GITHUB_REF_NAME: 'v2.0.0',
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_REPOSITORY: 'example/vspi',
    GITHUB_TOKEN: 'test-github-token',
    GITLAB_API_URL: 'https://gitlab.vsplab.cn/api/v4',
    GITLAB_PROJECT_ID: '42',
    GITLAB_PROJECT_URL: 'https://gitlab.vsplab.cn/heyx/vspi',
    GITLAB_TOKEN: 'test-gitlab-token',
    ...overrides,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function githubRelease(bytes, overrides = {}) {
  const checksum = sha256(bytes);
  return {
    id: 7,
    tag_name: 'v2.0.0',
    name: 'VSPi 2.0.0 Alpha',
    body: `SHA-256: \`${checksum}\``,
    draft: false,
    prerelease: true,
    upload_url: 'https://uploads.github.test/releases/7/assets{?name,label}',
    assets: [
      { name: 'vspi-2.0.0.tgz', url: 'https://api.github.test/assets/1' },
      { name: 'vspi-latest.tgz', url: 'https://api.github.test/assets/2' },
    ],
    ...overrides,
  };
}

function mockGitHubProducer(bytes, initialRelease) {
  const requests = [];
  let release = initialRelease;
  let nextAssetId = 1;
  const assetBytes = new Map();
  if (release) {
    for (const asset of release.assets ?? []) assetBytes.set(asset.url, bytes);
  }
  const fetch = async (urlValue, init = {}) => {
    const url = String(urlValue);
    const method = init.method ?? 'GET';
    requests.push({ url, method, headers: init.headers, body: init.body });
    if (url === 'https://api.github.test/repos/example/vspi/releases/tags/v2.0.0' && method === 'GET') {
      return release && !release.draft ? Response.json(release) : new Response('', { status: 404 });
    }
    if (url === 'https://api.github.test/repos/example/vspi/releases?per_page=100' && method === 'GET') {
      return Response.json(release ? [release] : []);
    }
    if (url === 'https://api.github.test/repos/example/vspi/releases' && method === 'POST') {
      const payload = JSON.parse(init.body);
      release = { id: 7, ...payload, upload_url: 'https://uploads.github.test/releases/7/assets{?name,label}', assets: [] };
      return Response.json(release, { status: 201 });
    }
    if (url.startsWith('https://uploads.github.test/releases/7/assets?name=') && method === 'POST') {
      const name = new URL(url).searchParams.get('name');
      const assetUrl = `https://api.github.test/assets/${nextAssetId++}`;
      release.assets.push({ name, url: assetUrl });
      assetBytes.set(assetUrl, Buffer.from(init.body));
      return Response.json(release.assets.at(-1), { status: 201 });
    }
    if (url === 'https://api.github.test/repos/example/vspi/releases/7' && method === 'PATCH') {
      release = { ...release, ...JSON.parse(init.body) };
      return Response.json(release);
    }
    if (assetBytes.has(url) && method === 'GET') {
      assert.equal(init.headers.accept, 'application/octet-stream');
      return new Response(assetBytes.get(url));
    }
    return new Response('', { status: 500 });
  };
  return { requests, fetch, release: () => release, assetBytes };
}

function gitlabRelease(checksum) {
  return {
    tag_name: 'v2.0.0',
    name: 'VSPi 2.0.0 Alpha',
    description: `SHA-256: \`${checksum}\``,
    assets: {
      links: [{
        name: 'vspi-2.0.0.tgz',
        url: 'https://gitlab.vsplab.cn/api/v4/projects/42/packages/generic/vspi/2.0.0/vspi-2.0.0.tgz',
        direct_asset_path: '/vspi-2.0.0.tgz',
        link_type: 'package',
        direct_asset_url: 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/v2.0.0/downloads/vspi-2.0.0.tgz',
      }],
    },
  };
}

function mockMirror(bytes, options = {}) {
  const requests = [];
  let release = options.release;
  let packageBytes = options.packageBytes;
  const github = githubRelease(bytes, options.githubOverrides);
  const fetch = async (urlValue, init = {}) => {
    const url = String(urlValue);
    const method = init.method ?? 'GET';
    requests.push({ url, method, headers: init.headers, body: init.body });
    if (url === 'https://api.github.test/repos/example/vspi/releases/tags/v2.0.0') return Response.json(github);
    if (url === 'https://api.github.test/assets/1') return new Response(options.versionedBytes ?? bytes);
    if (url === 'https://api.github.test/assets/2') return new Response(options.latestBytes ?? bytes);
    if (url.endsWith('/projects/42/releases/v2.0.0') && method === 'GET') {
      return release ? Response.json(release) : new Response('', { status: 404 });
    }
    if (url.endsWith('/projects/42/releases') && method === 'POST') {
      const payload = JSON.parse(init.body);
      release = {
        ...payload,
        assets: { links: [{ ...payload.assets.links[0], direct_asset_url: 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/v2.0.0/downloads/vspi-2.0.0.tgz' }] },
      };
      return Response.json(release, { status: options.postStatus ?? 201 });
    }
    if (url.includes('/packages/generic/vspi/2.0.0/vspi-2.0.0.tgz')) {
      if (method === 'PUT') {
        if (!packageBytes) packageBytes = Buffer.from(init.body);
        return new Response('', { status: options.uploadStatus ?? 201 });
      }
      return packageBytes ? new Response(packageBytes) : new Response('', { status: 404 });
    }
    if (url === 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/v2.0.0/downloads/vspi-2.0.0.tgz') {
      return packageBytes ? new Response(packageBytes) : new Response('', { status: 404 });
    }
    return new Response('', { status: 500 });
  };
  return { requests, fetch, release: () => release, packageBytes: () => packageBytes };
}

void test('prepares the exact GitHub release contract and rejects non-identical assets', async () => {
  const files = await fixture();
  const prepared = await prepareGitHubRelease({ environment: environment(), ...files });
  assert.equal(prepared.title, 'VSPi 2.0.0 Alpha');
  assert.equal(prepared.body, `SHA-256: \`${sha256(files.assetBytes)}\``);
  assert.deepEqual(prepared.assets.map(({ name }) => name), ['vspi-2.0.0.tgz', 'vspi-latest.tgz']);
  await writeFile(files.latestAssetPath, 'different');
  await assert.rejects(prepareGitHubRelease({ environment: environment(), ...files }), /identical bytes/);
});

void test('creates one draft GitHub release, uploads both byte-identical assets, and publishes it', async () => {
  const files = await fixture();
  const github = mockGitHubProducer(files.assetBytes);
  const metadata = await produceGitHubRelease({ environment: environment(), fetch: github.fetch, ...files });
  assert.deepEqual(metadata, { tag: 'v2.0.0', checksum: sha256(files.assetBytes), assets: ['vspi-2.0.0.tgz', 'vspi-latest.tgz'] });
  assert.equal(github.requests.filter(({ method }) => method === 'POST').length, 3);
  assert.equal(github.requests.filter(({ method }) => method === 'PATCH').length, 1);
  assert.equal(github.release().draft, false);
  assert.equal(github.release().prerelease, true);
  assert.ok([...github.assetBytes.values()].every((value) => value.equals(files.assetBytes)));
});

void test('reuses an exact GitHub release and refuses metadata or asset conflicts', async () => {
  const files = await fixture();
  const exact = mockGitHubProducer(files.assetBytes, githubRelease(files.assetBytes));
  await produceGitHubRelease({ environment: environment(), fetch: exact.fetch, ...files });
  assert.equal(exact.requests.filter(({ method }) => method === 'POST' || method === 'PATCH').length, 0);
  const wrongTitle = mockGitHubProducer(files.assetBytes, githubRelease(files.assetBytes, { name: 'Other' }));
  await assert.rejects(produceGitHubRelease({ environment: environment(), fetch: wrongTitle.fetch, ...files }), /title conflicts/);
  const wrongBytes = mockGitHubProducer(Buffer.from('different'), githubRelease(files.assetBytes));
  await assert.rejects(produceGitHubRelease({ environment: environment(), fetch: wrongBytes.fetch, ...files }), /package bytes/);
});

void test('reads only a published GitHub prerelease with two identical checksum-verified assets', async () => {
  const bytes = Buffer.from('source');
  const valid = mockMirror(bytes);
  const source = await readGitHubSource({ environment: environment(), fetch: valid.fetch });
  assert.equal(source.checksum, sha256(bytes));
  assert.ok(source.assetBytes.equals(bytes));
  await assert.rejects(readGitHubSource({ environment: environment(), fetch: mockMirror(bytes, { latestBytes: Buffer.from('other') }).fetch }), /identical bytes/);
  await assert.rejects(readGitHubSource({ environment: environment(), fetch: mockMirror(bytes, { githubOverrides: { body: `SHA-256: \`${'0'.repeat(64)}\`` } }).fetch }), /checksum conflicts/);
  await assert.rejects(readGitHubSource({ environment: environment(), fetch: mockMirror(bytes, { githubOverrides: { assets: [githubRelease(bytes).assets[0]] } }).fetch }), /assets conflict/);
});

void test('mirrors GitHub bytes to GitLab and emits updater-compatible minimal metadata', async () => {
  const files = await fixture();
  const mirror = mockMirror(files.assetBytes);
  const metadata = await mirrorGitLabRelease({ environment: environment(), fetch: mirror.fetch, metadataPath: files.metadataPath });
  assert.deepEqual(metadata, {
    version: '2.0.0',
    checksum: sha256(files.assetBytes),
    downloadUrl: 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/v2.0.0/downloads/vspi-2.0.0.tgz',
  });
  assert.deepEqual(JSON.parse(await readFile(files.metadataPath, 'utf8')), metadata);
  assert.ok(mirror.packageBytes().equals(files.assetBytes));
  assert.equal(mirror.release().assets.links.length, 1);
  assert.equal(mirror.requests.filter(({ method }) => method === 'PUT').length, 1);
  assert.equal(mirror.requests.filter(({ method }) => method === 'POST').length, 1);
  const gitlabMutations = mirror.requests.filter(({ method }) => method === 'PUT' || method === 'POST');
  assert.ok(gitlabMutations.every(({ headers }) => headers['PRIVATE-TOKEN'] === 'test-gitlab-token'));
});

void test('reuses an exact GitLab mirror and rejects package or release conflicts without mutation', async () => {
  const files = await fixture();
  const checksum = sha256(files.assetBytes);
  const exact = mockMirror(files.assetBytes, { packageBytes: files.assetBytes, release: gitlabRelease(checksum) });
  await mirrorGitLabRelease({ environment: environment(), fetch: exact.fetch, metadataPath: files.metadataPath });
  assert.equal(exact.requests.filter(({ method }) => method === 'PUT' || method === 'POST').length, 0);
  const wrongPackage = mockMirror(files.assetBytes, { packageBytes: Buffer.from('different') });
  await assert.rejects(mirrorGitLabRelease({ environment: environment(), fetch: wrongPackage.fetch, metadataPath: files.metadataPath }), /GitHub release bytes/);
  assert.equal(wrongPackage.requests.filter(({ method }) => method === 'PUT' || method === 'POST').length, 0);
  const wrongRelease = mockMirror(files.assetBytes, { packageBytes: files.assetBytes, release: { ...gitlabRelease(checksum), name: 'Other' } });
  await assert.rejects(mirrorGitLabRelease({ environment: environment(), fetch: wrongRelease.fetch, metadataPath: files.metadataPath }), /title conflicts/);
  assert.equal(wrongRelease.requests.filter(({ method }) => method === 'PUT' || method === 'POST').length, 0);
});

void test('rejects every tag except v2.0.0 before HTTP and does not leak tokens in HTTP errors', async () => {
  let requests = 0;
  await assert.rejects(readGitHubSource({ environment: environment({ GITHUB_REF_NAME: 'v2.0.1' }), fetch: async () => { requests += 1; } }), /must be v2\.0\.0/);
  assert.equal(requests, 0);
  const token = 'secret-github-token';
  await assert.rejects(readGitHubSource({ environment: environment({ GITHUB_TOKEN: token }), fetch: async () => new Response('sensitive', { status: 500 }) }), (error) => {
    assert.doesNotMatch(error.message, new RegExp(`${token}|sensitive|https?://`));
    return true;
  });
});

void test('workflow is exact-tag, single-build, Node 24, byte-identical, and GitLab CI never rebuilds', async () => {
  const workflow = await readFile(resolve('.github/workflows/vspi-2.0.0-release.yml'), 'utf8');
  assert.match(workflow, /tags:\n\s+- v2\.0\.0/);
  assert.doesNotMatch(workflow, /v2\.\*/);
  assert.match(workflow, /permissions:\n\s+contents: write/);
  assert.match(workflow, /node-version-file: \.nvmrc/);
  assert.equal(workflow.match(/package:pack/gu)?.length, 1);
  assert.match(workflow, /package:verify/);
  assert.match(workflow, /cp .*vspi-2\.0\.0\.tgz.*vspi-latest\.tgz/);
  assert.match(workflow, /cmp .*vspi-2\.0\.0\.tgz.*vspi-latest\.tgz/);
  assert.match(workflow, /github-release-producer\.mjs/);
  assert.match(workflow, /gitlab-release-producer\.mjs/);
  assert.match(workflow, /secrets\.VSPI_GITLAB_TOKEN/);
  const gitlabCi = await readFile(resolve('.gitlab-ci.yml'), 'utf8');
  assert.doesNotMatch(gitlabCi, /vspi-release:/);
  assert.doesNotMatch(gitlabCi, /package:pack|pnpm install|CI_COMMIT_TAG/);
  assert.match(gitlabCi, /node --test scripts\/gitlab-release-producer\.test\.mjs/);
});
