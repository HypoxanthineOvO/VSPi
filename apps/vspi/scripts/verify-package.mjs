import { builtinModules } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const tarball = resolve(process.argv[2] ?? join(packageRoot, '.tmp', 'package-artifacts', `vspi-${sourceManifest.version}.tgz`));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'vspi-package-verify-'));
const extractRoot = join(temporaryRoot, 'extract');
const prefix = join(temporaryRoot, 'prefix');
const cache = join(temporaryRoot, 'npm-cache');
const expectedFiles = [
  'package/LICENSE',
  'package/README.md',
  'package/dist/main.mjs',
  'package/dist/search-worker.mjs',
  'package/dist/text-build-worker.mjs',
  'package/package.json',
];
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

try {
  await mkdir(extractRoot, { recursive: true });
  const { stdout: listing } = await exec('tar', ['-tzf', tarball]);
  const files = listing.split('\n').filter(Boolean).map((name) => name.replace(/\/$/u, '')).filter((name) => name !== 'package');
  assert(JSON.stringify(files.sort()) === JSON.stringify([...expectedFiles].sort()), `unexpected tarball contents: ${files.join(', ')}`);
  await exec('tar', ['-xzf', tarball, '-C', extractRoot]);

  const manifest = JSON.parse(await readFile(join(extractRoot, 'package', 'package.json'), 'utf8'));
  assert(manifest.name === 'vspi', 'package name must be vspi');
  assert(manifest.version === sourceManifest.version, 'package version must match source manifest');
  assert(manifest.license === 'MIT', 'package license must be MIT');
  assert(manifest.type === 'module', 'package type must be module');
  assert(manifest.bin?.vspi === 'dist/main.mjs', 'package bin must point to dist/main.mjs');
  assert(manifest.engines?.node === '>=24.15.0', 'package Node.js engine must be >=24.15.0');
  for (const field of ['private', 'dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    assert(!(field in manifest), `package manifest must not contain ${field}`);
  }

  for (const name of ['main.mjs', 'search-worker.mjs', 'text-build-worker.mjs']) {
    await verifyImports(join(extractRoot, 'package', 'dist', name));
  }

  const environment = {
    ...process.env,
    HOME: join(temporaryRoot, 'home'),
    VSPI_HOME: join(temporaryRoot, 'vspi-home'),
    npm_config_cache: cache,
    npm_config_prefix: prefix,
    npm_config_update_notifier: 'false',
  };
  await exec('npm', ['install', '--global', '--no-audit', '--no-fund', tarball], { env: environment, timeout: 180_000 });
  const executable = process.platform === 'win32' ? join(prefix, 'vspi.cmd') : join(prefix, 'bin', 'vspi');
  const { stdout } = await exec(executable, ['--version'], { env: environment, timeout: 30_000 });
  assert(stdout.trim() === sourceManifest.version, `installed vspi reported ${stdout.trim() || '<empty>'}`);
  const help = await exec(executable, ['exec', '--help'], { env: environment, timeout: 30_000 });
  assert(help.stderr === '', `vspi exec --help wrote stderr: ${help.stderr}`);
  assert(help.stdout.startsWith('Usage: vspi exec [options]'), 'vspi exec --help must print exec usage');
  const vspiHomeEntries = await readdir(environment.VSPI_HOME).catch(() => []);
  assert(vspiHomeEntries.length === 0, 'vspi exec --help must not start or initialize the daemon');
  process.stdout.write(`verified ${basename(tarball)} (${sourceManifest.version}) with isolated prefix ${prefix}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifyImports(path) {
  const source = await readFile(path, 'utf8');
  const specifiers = [];
  for (const line of source.split('\n')) {
    if (/^(?:import|export)\s/u.test(line)) {
      const match = /(?:from\s+)?["']([^"']+)["'];?$/u.exec(line);
      if (match?.[1]) specifiers.push(match[1]);
    }
    if (!/^\s*(?:\/\/|\*|\/\*)/u.test(line)) {
      for (const match of line.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/gu)) {
        if (match[1]) specifiers.push(match[1]);
      }
    }
  }
  for (const specifier of specifiers) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || builtins.has(specifier)) continue;
    throw new Error(`${path} has external runtime import ${specifier}`);
  }
  const siblings = await readdir(dirname(path));
  assert(siblings.includes(basename(path)), `${path} is missing`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
