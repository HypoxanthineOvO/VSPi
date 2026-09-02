import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseVspiRelease } from '../apps/vspi/src/v1/update/release-contract.mjs';

const RELEASE_TAG = 'v2.0.0';
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

export async function prepareGitLabRelease({ environment, packageJsonPath, assetPath }) {
  const tag = required(environment, 'CI_COMMIT_TAG');
  if (tag !== RELEASE_TAG) throw new Error(`CI_COMMIT_TAG must be ${RELEASE_TAG}: ${tag}`);
  const version = RELEASE_TAG.slice(1);
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (packageJson.version !== version) {
    throw new Error(`Tag/package version mismatch: ${tag} != ${String(packageJson.version)}`);
  }

  const assetName = `vspi-${version}.tgz`;
  if (basename(assetPath) !== assetName) throw new Error(`Release asset must be named ${assetName}`);
  const assetBytes = await readFile(assetPath);
  const expectedChecksum = checksum(assetBytes);
  const apiUrl = trimTrailingSlash(required(environment, 'CI_API_V4_URL'));
  const projectId = encodeURIComponent(required(environment, 'CI_PROJECT_ID'));
  const genericPackageUrl = `${apiUrl}/projects/${projectId}/packages/generic/vspi/${encodeURIComponent(version)}/${encodeURIComponent(assetName)}`;
  const directAssetPath = `/${assetName}`;
  const title = `VSPi ${version} Alpha`;
  const releasePayload = {
    tag_name: tag,
    name: title,
    description: `SHA-256: \`${expectedChecksum}\``,
    assets: {
      links: [{ name: assetName, url: genericPackageUrl, direct_asset_path: directAssetPath, link_type: 'package' }],
    },
  };
  const releaseUrl = `${apiUrl}/projects/${projectId}/releases`;
  return {
    tag,
    title,
    assetName,
    assetBytes,
    checksum: expectedChecksum,
    genericPackageUrl,
    releaseUrl,
    releaseReadUrl: `${releaseUrl}/${encodeURIComponent(tag)}`,
    releasePayload,
  };
}

function validateRelease(release, prepared) {
  const validated = parseVspiRelease(release);
  if (release.tag_name !== prepared.tag) throw new Error('Existing GitLab release tag conflicts with the expected release');
  if (release.name !== prepared.title) throw new Error('Existing GitLab release title conflicts with the expected release');
  if (release.description !== prepared.releasePayload.description || validated.checksum !== prepared.checksum) {
    throw new Error('Existing GitLab release checksum conflicts with the package bytes');
  }
  const links = Array.isArray(release.assets?.links) ? release.assets.links : [];
  const link = links.find((candidate) => candidate?.name === prepared.assetName);
  const expectedLink = prepared.releasePayload.assets.links[0];
  if (
    !link ||
    link.url !== expectedLink.url ||
    link.direct_asset_path !== expectedLink.direct_asset_path ||
    link.direct_asset_url !== validated.downloadUrl
  ) {
    throw new Error('Existing GitLab release asset URL conflicts with the expected release');
  }
  return validated;
}

async function verifyBytes(response, prepared, operation) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (checksum(bytes) !== prepared.checksum || !bytes.equals(prepared.assetBytes)) {
    throw new Error(`${operation} conflicts with the package bytes`);
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
  let release;
  try {
    release = await response.json();
  } catch {
    throw new Error(`${operation} failed: invalid JSON`);
  }
  return validateRelease(release, prepared);
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

export async function preflightGitLabRelease({ environment = process.env, fetch = globalThis.fetch }) {
  if (!fetch) throw new Error('Global fetch is unavailable');
  const token = required(environment, 'CI_JOB_TOKEN');
  const apiUrl = trimTrailingSlash(required(environment, 'CI_API_V4_URL'));
  const projectId = encodeURIComponent(required(environment, 'CI_PROJECT_ID'));
  const version = RELEASE_TAG.slice(1);
  const assetName = `vspi-${version}.tgz`;
  const releaseReadUrl = `${apiUrl}/projects/${projectId}/releases/${encodeURIComponent(RELEASE_TAG)}`;
  const genericPackageUrl = `${apiUrl}/projects/${projectId}/packages/generic/vspi/${encodeURIComponent(version)}/${encodeURIComponent(assetName)}`;
  const headers = { 'JOB-TOKEN': token };
  await request(fetch, releaseReadUrl, { method: 'GET', headers }, 'GitLab release endpoint preflight', [404]);
  await request(
    fetch,
    genericPackageUrl,
    { method: 'HEAD', headers, redirect: 'error' },
    'Generic Package endpoint preflight',
    [404],
  );
  return { status: 'ok' };
}

export async function produceGitLabRelease({
  environment = process.env,
  packageJsonPath = resolve('apps/vspi/package.json'),
  assetPath,
  metadataPath = resolve('vspi-release-metadata.json'),
  fetch = globalThis.fetch,
}) {
  if (!assetPath) throw new Error('Usage: node scripts/gitlab-release-producer.mjs <vspi-x.y.z.tgz> [metadata.json]');
  if (!fetch) throw new Error('Global fetch is unavailable');
  const prepared = await prepareGitLabRelease({ environment, packageJsonPath, assetPath });
  const headers = { 'JOB-TOKEN': required(environment, 'CI_JOB_TOKEN') };

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
      // The readback below resolves an ambiguous upload result without exposing transport details.
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
    if (process.argv[2] === '--preflight') {
      const result = await preflightGitLabRelease({ assetPath: process.argv[3] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const metadata = await produceGitLabRelease({
        assetPath: process.argv[2],
        metadataPath: resolve(process.argv[3] ?? 'vspi-release-metadata.json'),
      });
      process.stdout.write(`${JSON.stringify(metadata)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
