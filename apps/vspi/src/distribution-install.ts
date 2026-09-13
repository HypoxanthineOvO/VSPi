import { createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveRuntimePaths } from '@vsp/vsp-runtime';
import {
  selectDistributionRelease,
  downloadDistributionRelease,
  withDistributionTrust,
  type DistributionSource,
  type DistributionTrust,
} from './v1/update/distribution.js';
import { installVspiUpdate } from './v1/update/self-update.js';
import { npmCommand } from './v1/update/npm-command.mjs';
import { readPrivateFile } from './v1/utils/private-file.js';

const output = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (
    !['--trust', '--source', '--mode'].includes(args[i] ?? '') ||
    !args[i + 1] ||
    values.has(args[i]!)
  )
    throw new Error(
      'Usage: node distribution-install.mjs --trust <independently-verified-distribution.json> [--source auto|internal|public] [--mode download|install]',
    );
  values.set(args[i]!, args[i + 1]!);
}
if (!values.has('--trust'))
  throw new Error('Provide an independently verified release public key using --trust');
const source = values.get('--source') ?? 'auto';
const mode = values.get('--mode') ?? 'download';
if (!['auto', 'internal', 'public'].includes(source) || !['download', 'install'].includes(mode))
  throw new Error('Invalid source or installation mode');
const trustBytes = await readPrivateFile(values.get('--trust')!, 16384);
const trust = JSON.parse(trustBytes.toString('utf8')) as DistributionTrust;
const exec = promisify(execFile);
const execute = (file: string, arguments_: string[]) =>
  exec(file, arguments_, {
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
if (
  typeof trust.publicKey !== 'string' ||
  createPublicKey(trust.publicKey).asymmetricKeyType !== 'ed25519'
)
  throw new Error('Expected a verified Ed25519 public key');
let entry: string | undefined;
let minimumVersion = '0.0.0';
if (mode === 'install') {
  const npm = npmCommand(['root', '--global']);
  const root = (await execute(npm.command, npm.args)).stdout.trim();
  try {
    const installed = JSON.parse(await readFile(join(root, 'vspi', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    if (installed.name !== 'vspi') throw new Error('Unexpected installed package');
    minimumVersion = installed.version;
    entry = join(root, 'vspi', 'dist', 'main.mjs');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
async function perform(
  minimum: string,
  remember: (version: string) => Promise<void>,
): Promise<void> {
  const release = await selectDistributionRelease(trust, {
    source: source as DistributionSource,
    minimumVersion: minimum,
  });
  await remember(release.manifest.version);
  const directory = await mkdtemp(join(tmpdir(), 'vspi-verified-install-'));
  const tarball = join(directory, `vspi-${release.manifest.version}.tgz`);
  let keepDownload = false;
  try {
    await writeFile(
      tarball,
      await downloadDistributionRelease(release, { source: source as DistributionSource }),
      { mode: 0o600 },
    );
    if (mode === 'download') {
      keepDownload = true;
      output(`Verified package: ${tarball}`);
    } else {
      if (entry) await installVspiUpdate(tarball, release.manifest.version, { entryPath: entry });
      else {
        const command = npmCommand([
          'install',
          '--global',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          tarball,
        ]);
        await execute(command.command, command.args);
        const rootCommand = npmCommand(['root', '--global']);
        const root = (await execute(rootCommand.command, rootCommand.args)).stdout.trim();
        const installed = JSON.parse(await readFile(join(root, 'vspi/package.json'), 'utf8')) as {
          version?: string;
        };
        if (installed.version !== release.manifest.version)
          throw new Error('Installed package version does not match the verified manifest');
      }
      output(
        `Installed VSPi ${release.manifest.version}; use KIMI_CODE_EXPERIMENTAL_VSPI_DISTRIBUTION=true for the new update source until release activation.`,
      );
    }
  } finally {
    if (!keepDownload) await rm(directory, { recursive: true, force: true });
  }
}

if (mode === 'install') {
  const home = resolveRuntimePaths().homeDir;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const configured = join(home, 'distribution.json');
  try {
    const previous = JSON.parse(
      (await readPrivateFile(configured, 16384)).toString(),
    ) as DistributionTrust;
    const fingerprint = (key: string) =>
      createPublicKey(key).export({ type: 'spki', format: 'der' });
    if (!fingerprint(previous.publicKey).equals(fingerprint(trust.publicKey)))
      throw new Error(
        'Existing distribution trust differs; review key rotation explicitly before installation',
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(configured, trustBytes, { flag: 'wx', mode: 0o600 });
  }
  await withDistributionTrust(
    minimumVersion,
    async (_trust, minimum, remember) => perform(minimum, remember),
    home,
  );
} else await perform(minimumVersion, async () => {});
