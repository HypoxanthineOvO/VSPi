import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = 'v2.0.0';
const RELEASE_VERSION = '2.0.0';
const RELEASE_TITLE = 'VSPi 2.0.0 Alpha';
const VERSIONED_ASSET = 'vspi-2.0.0.tgz';
const LATEST_ASSET = 'vspi-latest.tgz';
const READBACK_ATTEMPTS = 5;
const READBACK_DELAY_MS = 100;

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

function releaseBody(expectedChecksum) {
  return `SHA-256: \`${expectedChecksum}\``;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function httpError(operation, status) {
  return new Error(`${operation} failed: HTTP ${status}`);
}

async function request(fetchImpl, url, init, operation, allowedStatuses = []) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new Error(`${operation} failed: network error`);
  }
  if (!response.ok && !allowedStatuses.includes(response.status)) throw httpError(operation, response.status);
  return response;
}

async function responseJson(response, operation) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} failed: invalid JSON`);
  }
}

export async function prepareGitHubRelease({ environment, packageJsonPath, assetPath, latestAssetPath }) {
  const tag = required(environment, 'GITHUB_REF_NAME');
  if (tag !== RELEASE_TAG) throw new Error(`GITHUB_REF_NAME must be ${RELEASE_TAG}: ${tag}`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (packageJson.version !== RELEASE_VERSION) {
    throw new Error(`Tag/package version mismatch: ${tag} != ${String(packageJson.version)}`);
  }
  if (basename(assetPath) !== VERSIONED_ASSET) throw new Error(`Release asset must be named ${VERSIONED_ASSET}`);
  if (basename(latestAssetPath) !== LATEST_ASSET) throw new Error(`Compatibility asset must be named ${LATEST_ASSET}`);
  const assetBytes = await readFile(assetPath);
  const latestBytes = await readFile(latestAssetPath);
  if (!assetBytes.equals(latestBytes)) throw new Error('GitHub release assets must contain identical bytes');
  const expectedChecksum = checksum(assetBytes);
  const apiUrl = trimTrailingSlash(required(environment, 'GITHUB_API_URL'));
  const repository = required(environment, 'GITHUB_REPOSITORY');
  const releaseApiUrl = `${apiUrl}/repos/${repository}/releases`;
  return {
    tag,
    title: RELEASE_TITLE,
    body: releaseBody(expectedChecksum),
    checksum: expectedChecksum,
    assetBytes,
    assets: [
      { name: VERSIONED_ASSET, path: assetPath },
      { name: LATEST_ASSET, path: latestAssetPath },
    ],
    releaseApiUrl,
    releaseReadUrl: `${releaseApiUrl}/tags/${encodeURIComponent(tag)}`,
  };
}

function validateReleaseMetadata(release, prepared) {
  if (release.tag_name !== prepared.tag) throw new Error('Existing GitHub release tag conflicts with the expected release');
  if (release.name !== prepared.title) throw new Error('Existing GitHub release title conflicts with the expected release');
  if (release.body !== prepared.body) throw new Error('Existing GitHub release checksum conflicts with the package bytes');
  if (!release.prerelease) throw new Error('Existing GitHub release is not marked as a prerelease');
  if (!release.id || typeof release.upload_url !== 'string') throw new Error('Existing GitHub release metadata is incomplete');
  return release;
}

async function readRelease(fetchImpl, headers, prepared, operation) {
  const response = await request(fetchImpl, prepared.releaseReadUrl, { method: 'GET', headers }, operation, [404]);
  if (response.status !== 404) return validateReleaseMetadata(await responseJson(response, operation), prepared);
  const listOperation = `${operation} draft fallback`;
  const listResponse = await request(
    fetchImpl,
    `${prepared.releaseApiUrl}?per_page=100`,
    { method: 'GET', headers },
    listOperation,
  );
  const releases = await responseJson(listResponse, listOperation);
  if (!Array.isArray(releases)) throw new Error(`${listOperation} failed: invalid JSON`);
  const matches = releases.filter((release) => release?.tag_name === prepared.tag);
  if (matches.length > 1) throw new Error('GitHub release tag has multiple matching releases');
  return matches[0] ? validateReleaseMetadata(matches[0], prepared) : undefined;
}

async function waitForRelease(fetchImpl, headers, prepared) {
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    const release = await readRelease(fetchImpl, headers, prepared, 'GitHub release readback');
    if (release) return release;
    if (attempt + 1 < READBACK_ATTEMPTS) await delay(READBACK_DELAY_MS);
  }
  return undefined;
}

async function verifyAssetResponse(response, prepared, operation) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (checksum(bytes) !== prepared.checksum || !bytes.equals(prepared.assetBytes)) {
    throw new Error(`${operation} conflicts with the package bytes`);
  }
}

async function validateExistingAssets(fetchImpl, headers, release, prepared) {
  const remoteAssets = Array.isArray(release.assets) ? release.assets : [];
  const expectedNames = new Set(prepared.assets.map(({ name }) => name));
  if (remoteAssets.some((asset) => !expectedNames.has(asset?.name)) || new Set(remoteAssets.map((asset) => asset?.name)).size !== remoteAssets.length) {
    throw new Error('Existing GitHub release assets conflict with the release contract');
  }
  const existing = new Map(remoteAssets.map((asset) => [asset?.name, asset]));
  for (const asset of prepared.assets) {
    const remote = existing.get(asset.name);
    if (!remote) continue;
    if (typeof remote.url !== 'string') throw new Error(`Existing GitHub asset ${asset.name} metadata is incomplete`);
    const response = await request(
      fetchImpl,
      remote.url,
      { method: 'GET', headers: { ...headers, accept: 'application/octet-stream' }, redirect: 'error' },
      `GitHub asset ${asset.name} readback`,
    );
    await verifyAssetResponse(response, prepared, `Existing GitHub asset ${asset.name}`);
  }
  return existing;
}

async function uploadMissingAssets(fetchImpl, headers, release, prepared) {
  let existing = await validateExistingAssets(fetchImpl, headers, release, prepared);
  for (const asset of prepared.assets) {
    if (existing.has(asset.name)) continue;
    const uploadUrl = release.upload_url.replace(/\{.*$/u, '');
    let uploadStatus;
    try {
      const response = await fetchImpl(`${uploadUrl}?name=${encodeURIComponent(asset.name)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/gzip' },
        body: prepared.assetBytes,
      });
      uploadStatus = response.status;
    } catch {
      uploadStatus = undefined;
    }
    release = await readRelease(fetchImpl, headers, prepared, 'GitHub release lookup after asset upload');
    if (!release) throw new Error('GitHub release disappeared after asset upload');
    existing = await validateExistingAssets(fetchImpl, headers, release, prepared);
    if (!existing.has(asset.name)) {
      if (uploadStatus === undefined) throw new Error(`GitHub asset ${asset.name} upload failed: network error`);
      throw httpError(`GitHub asset ${asset.name} upload`, uploadStatus);
    }
  }
  return release;
}

async function createDraftRelease(fetchImpl, headers, prepared) {
  let creationStatus;
  try {
    const response = await fetchImpl(prepared.releaseApiUrl, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ tag_name: prepared.tag, name: prepared.title, body: prepared.body, draft: true, prerelease: true }),
    });
    creationStatus = response.status;
  } catch {
    creationStatus = undefined;
  }
  const release = await waitForRelease(fetchImpl, headers, prepared);
  if (release) return release;
  if (creationStatus === undefined) throw new Error('GitHub release creation failed: network error');
  throw httpError('GitHub release creation', creationStatus);
}

export async function produceGitHubRelease({
  environment = process.env,
  packageJsonPath = resolve('apps/vspi/package.json'),
  assetPath,
  latestAssetPath,
  metadataPath = resolve('vspi-github-release.json'),
  fetch = globalThis.fetch,
}) {
  if (!assetPath || !latestAssetPath) {
    throw new Error('Usage: node scripts/github-release-producer.mjs <vspi-2.0.0.tgz> <vspi-latest.tgz> [metadata.json]');
  }
  if (!fetch) throw new Error('Global fetch is unavailable');
  const prepared = await prepareGitHubRelease({ environment, packageJsonPath, assetPath, latestAssetPath });
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${required(environment, 'GITHUB_TOKEN')}`,
    'x-github-api-version': '2022-11-28',
  };
  let release = await readRelease(fetch, headers, prepared, 'GitHub release lookup');
  if (!release) release = await createDraftRelease(fetch, headers, prepared);
  release = await uploadMissingAssets(fetch, headers, release, prepared);
  if (release.draft) {
    const response = await request(
      fetch,
      `${prepared.releaseApiUrl}/${encodeURIComponent(String(release.id))}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ draft: false, prerelease: true }),
      },
      'GitHub release publication',
    );
    validateReleaseMetadata(await responseJson(response, 'GitHub release publication'), prepared);
  } else if (!release.prerelease) {
    throw new Error('Existing GitHub release is not marked as a prerelease');
  }
  const published = await readRelease(fetch, headers, prepared, 'Published GitHub release readback');
  if (!published || published.draft || !published.prerelease) throw new Error('GitHub release publication readback failed');
  const assets = await validateExistingAssets(fetch, headers, published, prepared);
  for (const asset of prepared.assets) {
    if (!assets.has(asset.name)) throw new Error(`Published GitHub release is missing ${asset.name}`);
  }
  const metadata = { tag: prepared.tag, checksum: prepared.checksum, assets: prepared.assets.map(({ name }) => name) };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const metadata = await produceGitHubRelease({
      assetPath: process.argv[2],
      latestAssetPath: process.argv[3],
      metadataPath: resolve(process.argv[4] ?? 'vspi-github-release.json'),
    });
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
