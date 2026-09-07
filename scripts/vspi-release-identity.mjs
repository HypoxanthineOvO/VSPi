import { readFile } from 'node:fs/promises';

export function releaseIdentity(version, tag = `v${version}`) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('VSPi release requires a stable semantic version');
  }
  if (tag !== `v${version}`) throw new Error(`Tag/package version mismatch: ${tag} != ${version}`);
  return { version, tag, title: `VSPi ${version}`, assetName: `vspi-${version}.tgz` };
}

export async function checkoutReleaseIdentity(tag, packageJsonPath = new URL('../apps/vspi/package.json', import.meta.url)) {
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  return releaseIdentity(manifest.version, tag);
}
