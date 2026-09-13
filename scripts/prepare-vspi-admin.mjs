import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function prepareVspiAdmin(options) {
  const repo = resolve(import.meta.dirname, '..');
  const domain = (value) =>
    typeof value === 'string' &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) &&
    value.length <= 253;
  const safe = (value) => typeof value === 'string' && /^[A-Za-z0-9_./+-]+$/.test(value);
  const publicHost = options.publicHost ?? 'dist.hypohub.cn';
  const internalHost = options.internalHost ?? 'dist-internal.hypohub.cn';
  if (
    ![publicHost, internalHost, options.edenAddress].every(domain) ||
    ![
      options.edenHostname,
      options.publicHostname,
      options.caddyConfig,
      options.caddyService,
    ].every(safe) ||
    !options.caddyConfig.startsWith('/')
  )
    throw new Error(
      'Provide valid hostnames, an Eden address, an absolute Caddy config and service name',
    );
  if (
    ![options.edenHostname, options.publicHostname].every((value) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
    ) ||
    !/^[A-Za-z0-9_-]+\.service$/.test(options.caddyService)
  )
    throw new Error('Invalid machine or service identity');
  const out = resolve(options.out);
  await mkdir(out, { recursive: false, mode: 0o700 });
  const replacements = {
    __PUBLIC_HOST__: publicHost,
    __INTERNAL_HOST__: internalHost,
    __EDEN_ADDRESS__: options.edenAddress,
    __EDEN_HOSTNAME__: options.edenHostname,
    __PUBLIC_HOSTNAME__: options.publicHostname,
    __CADDY_CONFIG__: options.caddyConfig,
    __CADDY_SERVICE__: options.caddyService,
  };
  const groups = {
    eden: ['eden.nginx.conf', 'eden-admin.sh', 'vspi-feedback.service', 'hermes-readonly.sh'],
    hypo: ['hypo.Caddyfile', 'hypo-admin.sh'],
  };
  for (const [group, names] of Object.entries(groups)) {
    const directory = join(out, group);
    await mkdir(directory, { mode: 0o700 });
    for (const name of names) {
      let text = await readFile(join(repo, 'ops/vspi-services', name), 'utf8');
      for (const [key, value] of Object.entries(replacements)) text = text.replaceAll(key, value);
      await writeFile(join(directory, name), text, { mode: name.endsWith('.sh') ? 0o700 : 0o600 });
    }
    if (group === 'eden') {
      for (const name of [
        'feedback-server.mjs',
        'feedback-admin.mjs',
        'distribution-admin.mjs',
        'distribution-install.mjs',
      ]) {
        await copyFile(
          join(options.artifactDirectory ?? join(repo, 'apps/vspi/dist'), name),
          join(directory, name),
        );
        names.push(name);
      }
      await writeFile(
        join(directory, 'server.example.json'),
        JSON.stringify(
          { directory: '/var/lib/vsp-feedback', port: 18761, submitters: [] },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      names.push('server.example.json');
    }
    const hashes = [];
    for (const name of names)
      hashes.push(
        `${createHash('sha256')
          .update(await readFile(join(directory, name)))
          .digest('hex')}  ${name}`,
      );
    await writeFile(join(directory, 'SHA256SUMS'), `${hashes.join('\n')}\n`, { mode: 0o600 });
  }
  await copyFile(join(repo, 'ops/vspi-services/README.md'), join(out, 'README.md'));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const values = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    const names = {
      '--out': 'out',
      '--eden-address': 'edenAddress',
      '--eden-hostname': 'edenHostname',
      '--public-hostname': 'publicHostname',
      '--caddy-config': 'caddyConfig',
      '--caddy-service': 'caddyService',
    };
    if (!Object.hasOwn(names, key) || !value || Object.hasOwn(values, names[key]))
      throw new Error('Invalid admin-package argument');
    values[names[key]] = value;
  }
  process.stdout.write(`${await prepareVspiAdmin(values)}\n`);
}
