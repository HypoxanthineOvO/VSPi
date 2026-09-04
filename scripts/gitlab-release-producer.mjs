import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = 'v2.0.1';
const RELEASE_VERSION = '2.0.1';
const RELEASE_TITLE = 'VSPi 2.0.1';
const VERSIONED_ASSET = 'vspi-2.0.1.tgz';
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

function parseChecksum(body) {
  const value = typeof body === 'string' ? /^SHA-256: `([a-f0-9]{64})`$/iu.exec(body)?.[1]?.toLowerCase() : undefined;
  if (!value) throw new Error('GitHub release body must contain only the VSPi SHA-256 checksum');
  return value;
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

async function downloadGitHubAsset(fetchImpl, headers, asset, operation) {
  if (!asset || typeof asset.url !== 'string') throw new Error(`${operation} is missing from the GitHub release`);
  const response = await request(
    fetchImpl,
    asset.url,
    { method: 'GET', headers: { ...headers, accept: 'application/octet-stream' }, redirect: 'follow' },
    operation,
  );
  return Buffer.from(await response.arrayBuffer());
}

export async function readGitHubSource({ environment, fetch = globalThis.fetch }) {
  if (!fetch) throw new Error('Global fetch is unavailable');
  const tag = required(environment, 'GITHUB_REF_NAME');
  if (tag !== RELEASE_TAG) throw new Error(`GITHUB_REF_NAME must be ${RELEASE_TAG}: ${tag}`);
  const apiUrl = trimTrailingSlash(required(environment, 'GITHUB_API_URL'));
  const repository = required(environment, 'GITHUB_REPOSITORY');
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${required(environment, 'GITHUB_TOKEN')}`,
    'x-github-api-version': '2022-11-28',
  };
  const releaseUrl = `${apiUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await request(fetch, releaseUrl, { method: 'GET', headers }, 'GitHub release lookup');
  const release = await responseJson(response, 'GitHub release lookup');
  if (release.tag_name !== RELEASE_TAG) throw new Error('GitHub release tag conflicts with the mirror source');
  if (release.name !== RELEASE_TITLE) throw new Error('GitHub release title conflicts with the mirror source');
  if (release.draft || !release.prerelease) throw new Error('GitHub release must be a published prerelease');
  const expectedChecksum = parseChecksum(release.body);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const expectedNames = [VERSIONED_ASSET, LATEST_ASSET];
  if (assets.length !== expectedNames.length || expectedNames.some((name) => !assets.some((asset) => asset?.name === name))) {
    throw new Error('GitHub release assets conflict with the mirror contract');
  }
  const versionedBytes = await downloadGitHubAsset(
    fetch,
    headers,
    assets.find((asset) => asset?.name === VERSIONED_ASSET),
    `GitHub asset ${VERSIONED_ASSET}`,
  );
  const latestBytes = await downloadGitHubAsset(
    fetch,
    headers,
    assets.find((asset) => asset?.name === LATEST_ASSET),
    `GitHub asset ${LATEST_ASSET}`,
  );
  if (!versionedBytes.equals(latestBytes)) throw new Error('GitHub release assets do not contain identical bytes');
  if (checksum(versionedBytes) !== expectedChecksum) throw new Error('GitHub release checksum conflicts with its asset bytes');
  return { tag, version: RELEASE_VERSION, title: RELEASE_TITLE, checksum: expectedChecksum, assetBytes: versionedBytes };
}

export function prepareGitLabMirror({ environment, source }) {
  const apiUrl = trimTrailingSlash(required(environment, 'GITLAB_API_URL'));
  const projectId = encodeURIComponent(required(environment, 'GITLAB_PROJECT_ID'));
  const projectUrl = trimTrailingSlash(required(environment, 'GITLAB_PROJECT_URL'));
  const genericPackageUrl = `${apiUrl}/projects/${projectId}/packages/generic/vspi/${encodeURIComponent(source.version)}/${encodeURIComponent(VERSIONED_ASSET)}`;
  const directAssetPath = `/${VERSIONED_ASSET}`;
  const releasePayload = {
    tag_name: source.tag,
    name: source.title,
    description: `SHA-256: \`${source.checksum}\``,
    assets: {
      links: [{ name: VERSIONED_ASSET, url: genericPackageUrl, direct_asset_path: directAssetPath, link_type: 'package' }],
    },
  };
  const releaseUrl = `${apiUrl}/projects/${projectId}/releases`;
  return {
    ...source,
    genericPackageUrl,
    releaseUrl,
    releaseReadUrl: `${releaseUrl}/${encodeURIComponent(source.tag)}`,
    directAssetUrl: `${projectUrl}/-/releases/${source.tag}/downloads/${VERSIONED_ASSET}`,
    releasePayload,
  };
}

export function parseLegacyGitLabRelease(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('GitLab Release metadata is invalid');
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error('GitLab Release tag is invalid');
  const version = tag.slice(1);
  const expectedChecksum =
    typeof release.description === 'string'
      ? /SHA-256:\s*`([a-f0-9]{64})`/iu.exec(release.description)?.[1]?.toLowerCase()
      : undefined;
  if (!expectedChecksum) throw new Error('GitLab Release checksum is missing');
  const filename = `vspi-${version}.tgz`;
  const expectedUrl = `https://gitlab.vsplab.cn/heyx/vspi/-/releases/${tag}/downloads/${filename}`;
  const links = Array.isArray(release.assets?.links) ? release.assets.links : [];
  const matched = links.find((link) => link?.name === filename && link.direct_asset_url === expectedUrl);
  if (!matched) throw new Error('GitLab Release trusted asset is missing');
  return { version, checksum: expectedChecksum, downloadUrl: expectedUrl };
}

function validateRelease(release, prepared) {
  const validated = parseLegacyGitLabRelease(release);
  if (release.tag_name !== prepared.tag) throw new Error('Existing GitLab release tag conflicts with the mirror source');
  if (release.name !== prepared.title) throw new Error('Existing GitLab release title conflicts with the mirror source');
  if (release.description !== prepared.releasePayload.description || validated.checksum !== prepared.checksum) {
    throw new Error('Existing GitLab release checksum conflicts with the mirror source');
  }
  const links = Array.isArray(release.assets?.links) ? release.assets.links : [];
  const expectedLink = prepared.releasePayload.assets.links[0];
  if (links.length !== 1) throw new Error('Existing GitLab release assets conflict with the mirror contract');
  const link = links[0];
  if (
    link?.name !== expectedLink.name ||
    link.url !== expectedLink.url ||
    link.direct_asset_path !== expectedLink.direct_asset_path ||
    link.direct_asset_url !== prepared.directAssetUrl ||
    validated.downloadUrl !== prepared.directAssetUrl
  ) {
    throw new Error('Existing GitLab release asset URL conflicts with the mirror contract');
  }
  return validated;
}

async function verifyBytes(response, prepared, operation) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (checksum(bytes) !== prepared.checksum || !bytes.equals(prepared.assetBytes)) {
    throw new Error(`${operation} conflicts with the GitHub release bytes`);
  }
}

async function readPackage(fetchImpl, headers, prepared, operation) {
  const response = await request(
    fetchImpl,
    prepared.genericPackageUrl,
    { method: 'GET', headers, redirect: 'error' },
    operation,
    [404],
  );
  if (response.status === 404) return false;
  await verifyBytes(response, prepared, operation);
  return true;
}

async function waitForPackage(fetchImpl, headers, prepared) {
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    if (await readPackage(fetchImpl, headers, prepared, 'Generic Package readback')) return;
    if (attempt + 1 < READBACK_ATTEMPTS) await delay(READBACK_DELAY_MS);
  }
  throw new Error('Generic Package readback failed: HTTP 404');
}

async function readRelease(fetchImpl, headers, prepared, operation) {
  const response = await request(fetchImpl, prepared.releaseReadUrl, { method: 'GET', headers }, operation, [404]);
  if (response.status === 404) return undefined;
  return validateRelease(await responseJson(response, operation), prepared);
}

async function verifyReleaseAsset(fetchImpl, validated, prepared) {
  const response = await request(
    fetchImpl,
    validated.downloadUrl,
    { method: 'GET', redirect: 'error' },
    'GitLab release asset readback',
  );
  await verifyBytes(response, prepared, 'GitLab release asset readback');
}

async function waitForRelease(fetchImpl, headers, prepared) {
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    const validated = await readRelease(fetchImpl, headers, prepared, 'GitLab release readback');
    if (validated) {
      await verifyReleaseAsset(fetchImpl, validated, prepared);
      return validated;
    }
    if (attempt + 1 < READBACK_ATTEMPTS) await delay(READBACK_DELAY_MS);
  }
  return undefined;
}

export async function mirrorGitLabRelease({
  environment = process.env,
  metadataPath = resolve('vspi-release-metadata.json'),
  fetch = globalThis.fetch,
}) {
  if (!fetch) throw new Error('Global fetch is unavailable');
  const source = await readGitHubSource({ environment, fetch });
  const prepared = prepareGitLabMirror({ environment, source });
  const headers = { 'PRIVATE-TOKEN': required(environment, 'GITLAB_TOKEN') };
  const existingRelease = await readRelease(fetch, headers, prepared, 'GitLab release lookup');
  if (existingRelease) {
    await verifyReleaseAsset(fetch, existingRelease, prepared);
    await writeFile(metadataPath, `${JSON.stringify(existingRelease, null, 2)}\n`);
    return existingRelease;
  }
  if (!(await readPackage(fetch, headers, prepared, 'Generic Package lookup'))) {
    try {
      await fetch(prepared.genericPackageUrl, {
        method: 'PUT',
        headers: { ...headers, 'If-None-Match': '*' },
        body: prepared.assetBytes,
      });
    } catch {
      // Readback resolves an ambiguous upload result without rebuilding or overwriting the package.
    }
    await waitForPackage(fetch, headers, prepared);
  }
  const concurrentRelease = await readRelease(fetch, headers, prepared, 'GitLab release lookup');
  let validated = concurrentRelease;
  if (!validated) {
    let creationStatus;
    try {
      const creation = await fetch(prepared.releaseUrl, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(prepared.releasePayload),
      });
      creationStatus = creation.status;
    } catch {
      creationStatus = undefined;
    }
    validated = await waitForRelease(fetch, headers, prepared);
    if (!validated) {
      if (creationStatus === undefined) throw new Error('GitLab release creation failed: network error');
      throw httpError('GitLab release creation', creationStatus);
    }
  } else {
    await verifyReleaseAsset(fetch, validated, prepared);
  }
  await writeFile(metadataPath, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const metadata = await mirrorGitLabRelease({ metadataPath: resolve(process.argv[2] ?? 'vspi-release-metadata.json') });
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
