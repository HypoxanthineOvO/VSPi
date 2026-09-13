import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, utimes, writeFile, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  compareReleaseVersions,
  verifyDistributionManifest,
  MAX_DISTRIBUTION_PACKAGE,
  type DistributionManifest,
} from './v1/update/distribution-contract.js';
import { readPrivateFile, readRegularFile } from './v1/utils/private-file.js';

const output = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

function verifyPackageVersion(bytes: Buffer, version: string): void {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  let manifests = 0;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const rawSize = header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('Invalid package tar header');
    const size = Number.parseInt(rawSize, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length)
      throw new Error('Truncated package archive');
    if (name === 'package/package.json') {
      if (size > 65536) throw new Error('Oversized package manifest');
      const manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString()) as {
        name?: string;
        version?: string;
      };
      if (manifest.name !== 'vspi' || manifest.version !== version)
        throw new Error('Package identity does not match release metadata');
      manifests++;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (manifests !== 1) throw new Error('Package must have one vspi manifest');
}

async function durableWrite(path: string, bytes: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o644);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(resolve(path, '..'), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'keygen' && args.length === 1) {
  const root = resolve(args[0]!);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await writeFile(
    join(root, 'release-private.pem'),
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(join(root, 'distribution.json'), JSON.stringify({ publicKey }, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  output(
    `Public-key SHA256: ${createHash('sha256')
      .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')}`,
  );
} else if (command === 'publish' && args.length === 4) {
  const [tarball, version, rootArg, keyPath] = args as [string, string, string, string];
  compareReleaseVersions(version, version);
  const root = resolve(rootArg);
  const file = await open(tarball, 'r');
  let bytes: Buffer;
  try {
    const size = (await file.stat()).size;
    if (size <= 0 || size > MAX_DISTRIBUTION_PACKAGE) throw new Error('Invalid package size');
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  if (bytes.length > MAX_DISTRIBUTION_PACKAGE) throw new Error('Package grew beyond the limit');
  verifyPackageVersion(bytes, version);
  const keyLocation = await realpath(keyPath);
  await mkdir(root, { recursive: true, mode: 0o755 });
  const within = relative(await realpath(root), keyLocation);
  if (within === '' || (!within.startsWith(`..${sep}`) && !isAbsolute(within)))
    throw new Error('The private signing key must not be inside the download root');
  const key = createPrivateKey(await readPrivateFile(keyLocation, 16384));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 release key');
  const publicKey = createPublicKey(key);
  const latest = join(root, 'vspi', 'latest.json');
  try {
    const previous = JSON.parse((await readRegularFile(latest, 64 * 1024)).toString()) as {
      payload: string;
    };
    const previousManifest = JSON.parse(
      Buffer.from(previous.payload, 'base64').toString('utf8'),
    ) as { version: string };
    if (compareReleaseVersions(version, previousManifest.version) < 0)
      throw new Error('Refusing to publish an older version as latest');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const directory = join(root, 'vspi', 'releases', version);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const name = `vspi-${version}.tgz`;
  const target = join(directory, name);
  const hash = createHash('sha256').update(bytes).digest('hex');
  try {
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      createHash('sha256')
        .update(await readRegularFile(target, MAX_DISTRIBUTION_PACKAGE))
        .digest('hex') !== hash
    )
      throw error;
  }
  const manifest: DistributionManifest = {
    schemaVersion: 1,
    product: 'vspi',
    version,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    artifact: { path: `/vspi/releases/${version}/${name}`, bytes: bytes.length, sha256: hash },
  };
  const payload = Buffer.from(JSON.stringify(manifest));
  const envelope = {
    payload: payload.toString('base64'),
    signature: sign(null, payload, key).toString('base64'),
  };
  const artifactFile = await open(target, 'r');
  try {
    await artifactFile.sync();
  } finally {
    await artifactFile.close();
  }
  await durableWrite(latest, JSON.stringify(envelope));
  output(
    JSON.stringify({
      version,
      sha256: hash,
      bytes: bytes.length,
      latest,
      publicKeyFingerprint: createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
    }),
  );
} else if (command === 'promote' && args.length === 3) {
  const [source, rootArg, trustPath] = args as [string, string, string];
  const root = resolve(rootArg);
  const trust = JSON.parse((await readPrivateFile(trustPath, 16384)).toString()) as {
    publicKey: string;
  };
  const envelope = await readRegularFile(join(source, 'vspi/latest.json'), 64 * 1024);
  const manifest = verifyDistributionManifest(envelope, trust);
  const target = join(root, manifest.artifact.path.slice(1));
  const bytes = await readRegularFile(
    join(source, manifest.artifact.path.slice(1)),
    MAX_DISTRIBUTION_PACKAGE,
  );
  if (
    bytes.length !== manifest.artifact.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== manifest.artifact.sha256
  )
    throw new Error('Staged package checksum mismatch');
  verifyPackageVersion(bytes, manifest.version);
  const latest = join(root, 'vspi/latest.json');
  let previousVersion: string | undefined;
  try {
    const prior = JSON.parse((await readRegularFile(latest, 64 * 1024)).toString()) as {
      payload: string;
    };
    previousVersion = JSON.parse(Buffer.from(prior.payload, 'base64').toString()).version;
    if (
      compareReleaseVersions(
        manifest.version,
        JSON.parse(Buffer.from(prior.payload, 'base64').toString()).version,
      ) < 0
    )
      throw new Error('Refusing publication rollback');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o755 });
  try {
    const existing = await readRegularFile(target, MAX_DISTRIBUTION_PACKAGE);
    if (!existing.equals(bytes)) throw new Error('Existing version has different bytes');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await durableWrite(target, bytes);
  if (previousVersion && previousVersion !== manifest.version) {
    const now = new Date();
    await utimes(join(root, 'vspi/releases', previousVersion), now, now).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  await durableWrite(latest, envelope);
  output(
    `Promoted verified VSPi ${manifest.version}; private key was not needed on the serving host.`,
  );
} else if (command === 'prune' && (args.length === 2 || args.length === 3 && args[2] === '--confirm-delete-old')) {
  const root = resolve(args[0]!);
  const trust = JSON.parse((await readPrivateFile(args[1]!, 16384)).toString()) as { publicKey: string };
  const latest = verifyDistributionManifest(await readRegularFile(join(root, 'vspi/latest.json'), 64 * 1024), trust);
  const directory = join(root, 'vspi/releases');
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 1000) throw new Error('Inspect excessive release entries manually');
  const versions = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\d+\.\d+\.\d+$/.test(entry.name)).map(entry => entry.name).filter(version => compareReleaseVersions(version, latest.version) < 0).sort((a, b) => compareReleaseVersions(b, a));
  const candidates: string[] = [];
  for (const version of versions.slice(1)) {
    const path = join(directory, version);
    if (Date.now() - (await lstat(path)).mtimeMs < 86400000) continue;
    const files = await readdir(path, { withFileTypes: true });
    if (files.length !== 1 || files[0]?.name !== `vspi-${version}.tgz` || !files[0].isFile()) throw new Error('Unexpected files in an old release; preserve and inspect manually');
    candidates.push(version);
  }
  output(JSON.stringify({ latest: latest.version, retainedPrevious: versions[0], oldVersions: candidates, deleting: args[2] === '--confirm-delete-old' }));
  if (args[2] === '--confirm-delete-old') for (const version of candidates) await rm(join(directory, version), { recursive: true });
} else {
  output(
    'Usage:\n  node distribution-admin.mjs keygen <private-key-directory>\n  node distribution-admin.mjs publish <verified-vspi.tgz> <version> <staging-root> <private-key.pem>\n  node distribution-admin.mjs promote <signed-staging-root> <download-root> <verified-trust.json>\n  node distribution-admin.mjs prune <download-root> <verified-trust.json> [--confirm-delete-old]\nRepeat publish with the identical version/package to refresh the 30-day signed manifest; never place the private key in the download root.',
  );
  if (command && command !== '--help') process.exitCode = 2;
}
