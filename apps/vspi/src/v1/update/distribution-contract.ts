import { createPublicKey, verify } from 'node:crypto';

export const DISTRIBUTION_ORIGINS = {
  internal: 'https://dist-internal.hypohub.cn',
  public: 'https://dist.hypohub.cn',
} as const;
export type DistributionSource = 'auto' | keyof typeof DISTRIBUTION_ORIGINS;
export interface DistributionManifest {
  schemaVersion: 1;
  product: 'vspi';
  version: string;
  issuedAt: string;
  expiresAt: string;
  artifact: { path: string; bytes: number; sha256: string };
}
export interface DistributionTrust {
  publicKey: string;
}
export interface DistributionRelease {
  manifest: DistributionManifest;
  source: keyof typeof DISTRIBUTION_ORIGINS;
}
export const MAX_DISTRIBUTION_PACKAGE = 64 * 1024 * 1024;

export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
      throw new Error('Invalid release version');
    const parts = value.split('.').map(Number);
    if (parts.some((p) => !Number.isSafeInteger(p))) throw new Error('Invalid release version');
    return parts;
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

export function verifyDistributionManifest(
  bytes: Buffer,
  trust: DistributionTrust,
  minimumVersion = '0.0.0',
  now = Date.now(),
): DistributionManifest {
  if (bytes.length > 64 * 1024) throw new Error('Release manifest exceeds limit');
  const envelope = JSON.parse(bytes.toString('utf8')) as { payload?: unknown; signature?: unknown };
  if (
    typeof envelope.payload !== 'string' ||
    typeof envelope.signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)
  )
    throw new Error('Invalid signed release envelope');
  const key = createPublicKey(trust.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release trust key must be Ed25519');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!verify(null, payload, key, Buffer.from(envelope.signature, 'base64')))
    throw new Error('Release signature verification failed');
  const manifest = JSON.parse(payload.toString('utf8')) as DistributionManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== 'vspi' ||
    compareReleaseVersions(manifest.version, minimumVersion) < 0
  )
    throw new Error('Invalid or rolled-back release manifest');
  const issued = Date.parse(manifest.issuedAt);
  const expires = Date.parse(manifest.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now + 300000 ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 90 * 86400000
  )
    throw new Error('Release manifest expired or has invalid validity period');
  const artifact = manifest.artifact;
  if (
    !artifact ||
    artifact.path !== `/vspi/releases/${manifest.version}/vspi-${manifest.version}.tgz` ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    artifact.bytes > MAX_DISTRIBUTION_PACKAGE ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    throw new Error('Invalid release artifact');
  return manifest;
}
