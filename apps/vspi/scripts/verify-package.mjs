import { builtinModules } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { npmCommand } from '../src/v1/update/npm-command.mjs';

const exec = promisify(execFile);
const isWindows = process.platform === 'win32';

async function runNpm(args, options) {
  const invocation = npmCommand(args);
  return exec(invocation.command, invocation.args, options);
}

async function runInstalled(executable, args, options) {
  const invocation = isWindows ? { command: process.execPath, args: [join(dirname(executable), '..', 'vspi', 'dist', 'main.mjs'), ...args] } : { command: executable, args };
  return exec(invocation.command, invocation.args, options);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const tarball = resolve(process.argv[2] ?? join(packageRoot, '.tmp', 'package-artifacts', `vspi-${sourceManifest.version}.tgz`));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'vspi-package-verify-'));
const extractRoot = join(temporaryRoot, 'extract');
const prefix = join(temporaryRoot, 'prefix');
const cache = join(temporaryRoot, 'npm-cache');
const expectedFiles = [
  'package/LICENSE',
  'package/THIRD_PARTY_NOTICES',
  'package/README.md',
  'package/dist/main.mjs',
  'package/dist/search-worker.mjs',
  'package/dist/text-build-worker.mjs',
  'package/package.json',
  'package/skills/vspi-self/SKILL.md',
];
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

try {
  await mkdir(extractRoot, { recursive: true });
  const { stdout: listing } = await exec('tar', ['-tzf', tarball]);
  const files = listing.split(/\r?\n/u).filter(Boolean).map((name) => name.replace(/\/$/u, '')).filter((name) => name !== 'package');
  assert(JSON.stringify(files.sort()) === JSON.stringify([...expectedFiles].sort()), `unexpected tarball contents: ${files.join(', ')}`);
  await exec('tar', ['-xzf', tarball, '-C', extractRoot]);

  const manifest = JSON.parse(await readFile(join(extractRoot, 'package', 'package.json'), 'utf8'));
  assert(manifest.name === 'vspi', 'package name must be vspi');
  assert(manifest.version === sourceManifest.version, 'package version must match source manifest');
  assert(manifest.license === 'MIT', 'package license must be MIT');
  assert(manifest.type === 'module', 'package type must be module');
  assert(manifest.bin?.vspi === 'dist/main.mjs', 'package bin must point to dist/main.mjs');
  assert(manifest.engines?.node === '>=22.19.0', 'package Node.js engine must be >=22.19.0');
  for (const field of ['private', 'dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    assert(!(field in manifest), `package manifest must not contain ${field}`);
  }

  for (const name of ['main.mjs', 'search-worker.mjs', 'text-build-worker.mjs']) {
    await verifyImports(join(extractRoot, 'package', 'dist', name));
  }
  const selfSkill = await readFile(join(extractRoot, 'package', 'skills', 'vspi-self', 'SKILL.md'), 'utf8');
  for (const expected of ['${KIMI_SESSION_DIR}', 'default_model', 'secondary_model', 'vspi config reload']) {
    assert(selfSkill.includes(expected), `vspi-self skill must include ${expected}`);
  }
  for (const forbidden of ['KIMI_CODE_HOME', '~/.kimi-code', 'kimi doctor']) {
    assert(!selfSkill.includes(forbidden), `vspi-self skill must not include ${forbidden}`);
  }

  const environment = {
    ...process.env,
    HOME: join(temporaryRoot, 'home'),
    USERPROFILE: join(temporaryRoot, 'home'),
    VSPI_HOME: join(temporaryRoot, 'vspi-home'),
    npm_config_cache: cache,
    npm_config_prefix: prefix,
    npm_config_update_notifier: 'false',
  };
  await runNpm(['install', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { env: environment, timeout: 180_000 });
  const executable = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'vspi.cmd' : 'vspi');
  const { stdout } = await runInstalled(executable, ['--version'], { env: environment, timeout: 30_000 });
  assert(stdout.trim() === sourceManifest.version, `installed vspi reported ${stdout.trim() || '<empty>'}`);
  const rootHelp = await runInstalled(executable, ['--help'], { env: environment, timeout: 30_000 });
  assert(rootHelp.stderr === '', `vspi --help wrote stderr: ${rootHelp.stderr}`);
  assert(rootHelp.stdout.startsWith(`VSPi ${sourceManifest.version}`), 'vspi --help must print root usage');
  const configHelp = await runInstalled(executable, ['config', '--help'], { env: environment, timeout: 30_000 });
  assert(configHelp.stderr === '', `vspi config --help wrote stderr: ${configHelp.stderr}`);
  assert(configHelp.stdout.startsWith('Usage: vspi config'), 'vspi config --help must print config usage');
  const configPath = await runInstalled(executable, ['config', 'path'], { env: environment, timeout: 30_000 });
  assert(configPath.stderr === '', `vspi config path wrote stderr: ${configPath.stderr}`);
  assert(configPath.stdout.trim() === join(environment.VSPI_HOME, 'config.toml'), 'vspi config path must honor VSPI_HOME');
  await assertFailsWithoutRuntime(executable, ['--unknown'], environment, 'Unknown option: --unknown');
  await assertFailsWithoutRuntime(executable, ['unknown'], environment, 'Unknown command: unknown');
  await assertFailsWithoutRuntime(executable, ['config', '--unknown'], environment, 'Unknown option for vspi config: --unknown');
  const help = await runInstalled(executable, ['exec', '--help'], { env: environment, timeout: 30_000 });
  assert(help.stderr === '', `vspi exec --help wrote stderr: ${help.stderr}`);
  assert(help.stdout.startsWith('Usage: vspi exec [options]'), 'vspi exec --help must print exec usage');
  const vspiHomeEntries = await readdir(environment.VSPI_HOME).catch(() => []);
  assert(vspiHomeEntries.length === 0, 'vspi exec --help must not start or initialize the daemon');
  const workspace = join(temporaryRoot, 'workspace');
  await mkdir(join(workspace, '.git'), { recursive: true });
  const runtimeOptions = { env: environment, cwd: workspace, timeout: 30_000 };
  try {
    const started = await runInstalled(executable, ['daemon', 'start'], runtimeOptions);
    assert(started.stdout.includes('VSP runtime started at pid '), 'installed vspi must start its daemon');
    const status = await runInstalled(executable, ['daemon', 'status'], runtimeOptions);
    assert(status.stdout.includes('VSP runtime is ready'), 'installed vspi must connect to its daemon');
    const runtimeIdentity = JSON.parse(await readFile(join(environment.VSPI_HOME, 'server', 'vspi-runtime.json'), 'utf8'));
    assert(runtimeIdentity.nodeVersion === process.versions.node, 'daemon must run under the Node.js version being verified');
    assert(runtimeIdentity.version === sourceManifest.version, 'daemon must run the installed VSPi version');
    await runInstalled(executable, ['config', 'reload'], runtimeOptions);
  } finally {
    await runInstalled(executable, ['daemon', 'stop'], runtimeOptions);
  }
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

async function assertFailsWithoutRuntime(executable, args, env, expectedMessage) {
  try {
    await runInstalled(executable, args, { env, timeout: 30_000 });
  } catch (error) {
    assert(error.stderr?.includes(expectedMessage), `vspi ${args.join(' ')} did not report ${expectedMessage}`);
    return;
  }
  throw new Error(`vspi ${args.join(' ')} unexpectedly succeeded`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
