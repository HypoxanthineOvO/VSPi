import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

import { prepareGitLabRelease, preflightGitLabRelease, produceGitLabRelease } from './gitlab-release-producer.mjs';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(version = '2.0.0') {
  const directory = await mkdtemp(join(tmpdir(), 'vspi-release-producer-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const packageJsonPath = join(directory, 'package.json');
  const assetPath = join(directory, `vspi-${version}.tgz`);
  const metadataPath = join(directory, 'metadata.json');
  const assetBytes = Buffer.from('offline-vspi-package');
  await writeFile(packageJsonPath, JSON.stringify({ name: 'vspi', version }));
  await writeFile(assetPath, assetBytes);
  return { packageJsonPath, assetPath, metadataPath, assetBytes };
}

function environment(overrides = {}) {
  return {
    CI_COMMIT_TAG: 'v2.0.0',
    CI_API_V4_URL: 'http://127.0.0.1:1/api/v4',
    CI_SERVER_URL: 'https://gitlab.vsplab.cn',
    CI_PROJECT_ID: '42',
    CI_PROJECT_PATH: 'heyx/vspi',
    CI_JOB_TOKEN: 'test-job-token',
    ...overrides,
  };
}

function releaseMetadata(checksum, apiUrl = 'http://127.0.0.1:1/api/v4') {
  return {
    tag_name: 'v2.0.0', name: 'VSPi 2.0.0 Alpha', description: `SHA-256: \`${checksum}\``,
    assets: { links: [{ name: 'vspi-2.0.0.tgz', url: `${apiUrl}/projects/42/packages/generic/vspi/2.0.0/vspi-2.0.0.tgz`, direct_asset_path: '/vspi-2.0.0.tgz', link_type: 'package', direct_asset_url: 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/v2.0.0/downloads/vspi-2.0.0.tgz' }] },
  };
}

async function mockGitLab({ release, packageBytes, releaseDelay = 0, uploadStatus = 201, postStatus = 201 } = {}) {
  const requests = [];
  let storedPackage = packageBytes;
  let storedRelease = release;
  let releaseReads = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url?.includes('/releases/v2.0.0')) {
        if (request.method === 'GET' && storedRelease && releaseReads++ >= releaseDelay) {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(storedRelease)); return;
        }
        response.writeHead(404); response.end(); return;
      }
      if (request.url?.endsWith('/releases') && request.method === 'POST') {
        storedRelease = { ...JSON.parse(body), assets: { links: [{ ...JSON.parse(body).assets.links[0], direct_asset_url: 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/v2.0.0/downloads/vspi-2.0.0.tgz' }] } };
        response.writeHead(postStatus); response.end('{}'); return;
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (!storedPackage) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'content-type': 'application/octet-stream' }); if (request.method !== 'HEAD') response.end(storedPackage); else response.end(); return;
      }
      if (request.method === 'PUT') { if (!storedPackage) storedPackage = body; response.writeHead(uploadStatus); response.end(); return; }
      response.writeHead(500); response.end();
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const apiUrl = `http://127.0.0.1:${address.port}/api/v4`;
  if (storedRelease) storedRelease = { ...storedRelease, assets: { ...storedRelease.assets, links: storedRelease.assets.links.map((link) => ({ ...link, url: `${apiUrl}/projects/42/packages/generic/vspi/2.0.0/vspi-2.0.0.tgz` })) } };
  return {
    requests,
    apiUrl,
    fetch: async (url, init) => {
      if (String(url).startsWith('https://gitlab.vsplab.cn/')) {
        if (!storedPackage) return new Response('', { status: 404 });
        return new Response(storedPackage, { status: 200 });
      }
      return globalThis.fetch(url, init);
    },
  };
}

void test('rejects every tag except the one-time v2.0.0 release before HTTP', async () => {
  const files = await fixture();
  let requestCount = 0;
  await assert.rejects(
    produceGitLabRelease({
      environment: environment({ CI_COMMIT_TAG: 'v2.0.1' }),
      ...files,
      fetch: async () => {
        requestCount += 1;
        throw new Error('unexpected request');
      },
    }),
    /CI_COMMIT_TAG must be v2\.0\.0: v2\.0\.1/,
  );
  assert.equal(requestCount, 0);
});

void test('reuses an exact existing release and writes only validated metadata', async () => {
  const files = await fixture();
  const checksum = createHash('sha256').update(files.assetBytes).digest('hex');
  const gitlab = await mockGitLab({ release: releaseMetadata(checksum), packageBytes: files.assetBytes });
  const metadata = await produceGitLabRelease({ environment: environment({ CI_API_V4_URL: gitlab.apiUrl }), fetch: gitlab.fetch, ...files });
  assert.deepEqual(metadata, { version: '2.0.0', checksum, downloadUrl: 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/v2.0.0/downloads/vspi-2.0.0.tgz' });
  assert.deepEqual(JSON.parse(await readFile(files.metadataPath, 'utf8')), metadata);
  assert.equal(gitlab.requests.filter(({ method }) => method === 'POST' || method === 'PUT').length, 0);
});

void test('uploads, verifies bytes, creates, and reads back with the exact contract', async () => {
  const files = await fixture();
  const gitlab = await mockGitLab({ packageBytes: undefined });
  const metadata = await produceGitLabRelease({ environment: environment({ CI_API_V4_URL: gitlab.apiUrl }), fetch: gitlab.fetch, ...files });
  assert.equal(metadata.version, '2.0.0');
  assert.deepEqual(gitlab.requests.find(({ method }) => method === 'PUT')?.body, files.assetBytes);
  assert.equal(gitlab.requests.filter(({ method }) => method === 'POST').length, 1);
});

void test('rejects conflicting existing release or package without writing', async () => {
  const files = await fixture();
  const checksum = createHash('sha256').update(files.assetBytes).digest('hex');
  const releaseGitlab = await mockGitLab({ release: { ...releaseMetadata(checksum), name: 'Other' }, packageBytes: files.assetBytes });
  await assert.rejects(produceGitLabRelease({ environment: environment({ CI_API_V4_URL: releaseGitlab.apiUrl }), ...files }), /title conflicts/);
  assert.equal(releaseGitlab.requests.filter(({ method }) => method === 'POST' || method === 'PUT').length, 0);
  const packageGitlab = await mockGitLab({ packageBytes: Buffer.from('different') });
  await assert.rejects(produceGitLabRelease({ environment: environment({ CI_API_V4_URL: packageGitlab.apiUrl }), ...files }), /conflicts with the package bytes/);
  assert.equal(packageGitlab.requests.filter(({ method }) => method === 'POST' || method === 'PUT').length, 0);
});

void test('recovers after upload and POST failures and retries delayed readback', async () => {
  const files = await fixture();
  const gitlab = await mockGitLab({ packageBytes: undefined, releaseDelay: 2, postStatus: 500 });
  const metadata = await produceGitLabRelease({ environment: environment({ CI_API_V4_URL: gitlab.apiUrl }), fetch: gitlab.fetch, ...files });
  assert.equal(metadata.version, '2.0.0');
  assert.equal(gitlab.requests.filter(({ method }) => method === 'POST').length, 1);
});

void test('preflight requires a token and performs only read requests', async () => {
  await assert.rejects(preflightGitLabRelease({ environment: environment({ CI_JOB_TOKEN: '' }), fetch: async () => { throw new Error('unexpected'); } }), /CI_JOB_TOKEN/);
  const gitlab = await mockGitLab();
  await preflightGitLabRelease({ environment: environment({ CI_API_V4_URL: gitlab.apiUrl }), fetch: globalThis.fetch });
  assert.ok(gitlab.requests.every(({ method }) => method === 'GET' || method === 'HEAD'));
});

void test('HTTP failures report only operation and status without leaking token or response details', async () => {
  const files = await fixture();
  const token = 'secret-job-token';
  await assert.rejects(produceGitLabRelease({ environment: environment({ CI_JOB_TOKEN: token }), ...files, fetch: async () => new Response('sensitive body', { status: 500 }) }), (error) => {
    assert.doesNotMatch(error.message, new RegExp(`${token}|sensitive body|https?://`));
    return true;
  });
});

void test('prepares lowercase checksum, exact title, asset, and direct path without network access', async () => {
  const files = await fixture();
  const prepared = await prepareGitLabRelease({ environment: environment(), ...files });
  assert.equal(prepared.releasePayload.name, 'VSPi 2.0.0 Alpha');
  assert.match(prepared.releasePayload.description, /^SHA-256: `[a-f0-9]{64}`$/);
  assert.equal(prepared.releasePayload.assets.links[0].name, 'vspi-2.0.0.tgz');
  assert.equal(prepared.releasePayload.assets.links[0].direct_asset_path, '/vspi-2.0.0.tgz');
  assert.equal(prepared.releaseReadUrl, 'http://127.0.0.1:1/api/v4/projects/42/releases/v2.0.0');
});

void test('CI limits release to v2.0.0 and uses the VSPi staging package commands', async () => {
  const ci = await readFile(resolve('.gitlab-ci.yml'), 'utf8');
  const releaseJob = ci.slice(ci.indexOf('vspi-release:'));
  assert.match(releaseJob, /if: '\$CI_COMMIT_TAG == "v2\.0\.0"'/);
  assert.doesNotMatch(releaseJob, /CI_COMMIT_TAG =~/);
  assert.match(releaseJob, /pnpm lint/);
  assert.match(releaseJob, /pnpm sherif/);
  assert.match(releaseJob, /pnpm --filter @moonshot-ai\/agent-core-v2 test/);
  assert.match(releaseJob, /pnpm --filter @moonshot-ai\/klient test/);
  assert.match(releaseJob, /pnpm --filter @moonshot-ai\/kap-server test/);
  assert.match(releaseJob, /pnpm --filter @vsp\/vsp-runtime test/);
  assert.match(releaseJob, /pnpm --filter vspi test/);
  assert.match(releaseJob, /pnpm --filter vspi package:pack/);
  assert.match(releaseJob, /pnpm --filter vspi package:verify "\$CI_PROJECT_DIR\/apps\/vspi\/\.tmp\/package-artifacts\/vspi-2\.0\.0\.tgz"/);
  assert.match(releaseJob, /gitlab-release-producer\.mjs "\$CI_PROJECT_DIR\/apps\/vspi\/\.tmp\/package-artifacts\/vspi-2\.0\.0\.tgz"/);
  assert.doesNotMatch(releaseJob, /pnpm --filter vspi pack /);
});
