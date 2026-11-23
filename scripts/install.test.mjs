import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const installer = await readFile(new URL('./install.sh', import.meta.url));
const providedTarball = process.env.VSPI_INSTALL_TEST_TARBALL;

async function makeFixture(directory, env) {
  const source = join(directory, 'fixture');
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'vspi', version: '0.0.1', bin: { vspi: './cli.js' }, engines: { node: '>=22.19.0' },
  }));
  await writeFile(join(source, 'cli.js'), '#!/usr/bin/env node\nif (process.argv[2] !== "--version") process.exit(1);\nconsole.log("0.0.1");\n', { mode: 0o755 });
  const { stdout } = await exec('npm', ['pack', source, '--pack-destination', directory, '--ignore-scripts'], { cwd: directory, env });
  return join(directory, stdout.trim());
}

await test('install.sh over HTTP with isolated npm and HOME', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vspi-install-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: 'C',
    HOME: directory,
    npm_config_globalconfig: join(directory, 'global-npmrc'),
    npm_config_userconfig: join(directory, 'user-npmrc'),
    npm_config_offline: 'true',
  };
  const tarball = providedTarball ? resolve(providedTarball) : await makeFixture(directory, baseEnv);
  const bytes = await readFile(tarball);
  const { stdout: manifest } = await exec('tar', ['-xOzf', tarball, 'package/package.json']);
  const { name, version } = JSON.parse(manifest);
  assert.equal(name, 'vspi');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    switch (req.url) {
      case '/install.sh': res.end(installer); break;
      case '/release/vspi-latest.tgz':
      case '/tampered/vspi-latest.tgz': res.end(bytes); break;
      case '/release/SHA256SUMS': res.end(`${sha}  vspi-${version}.tgz\n${sha}  vspi-latest.tgz\n`); break;
      case '/tampered/SHA256SUMS': res.end(`${sha}  vspi-${version}.tgz\n${'0'.repeat(64)}  vspi-latest.tgz\n`); break;
      default: res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function isolatedRun(caseName, release = 'release') {
    const home = join(directory, caseName);
    const prefix = join(home, 'npm-global');
    const env = {
      ...baseEnv,
      HOME: home,
      TMPDIR: join(home, 'tmp'),
      npm_config_prefix: prefix,
      VSPI_DIST_BASE: `${origin}/${release}/`,
    };
    await mkdir(env.TMPDIR, { recursive: true });
    return {
      home, prefix, env,
      run: () => exec('sh', ['-c', 'curl -fsSL "$1" | sh', 'install-test', `${origin}/install.sh`], {
        cwd: home, env, timeout: 30000,
      }),
    };
  }

  await t.test(`installs vspi ${version} into the writable npm global prefix`, async () => {
    const { prefix, run } = await isolatedRun('writable-prefix');
    const { stdout } = await run();
    assert.ok(stdout.includes(version), stdout);
    assert.match(stdout, /Run vspi to get started/);
    await access(join(prefix, 'bin/vspi'));
    assert.deepEqual(requests.splice(0), ['/install.sh', '/release/vspi-latest.tgz', '/release/SHA256SUMS']);
  });

  await t.test('falls back to ~/.local and warns about a running daemon', async () => {
    const { home, prefix, env, run } = await isolatedRun("fallback prefix's HOME");
    await writeFile(prefix, 'Blocks npm global directory creation even when tests run as root.');
    env.VSPI_HOME = join(home, 'custom-vspi-home');
    await mkdir(join(env.VSPI_HOME, 'server'), { recursive: true });
    const state = join(env.VSPI_HOME, 'server/runtime.json');
    const metadata = JSON.stringify({ pid: process.pid });
    await writeFile(state, metadata);
    const { stdout, stderr } = await run();
    const localBin = join(home, '.local/bin/vspi');
    assert.ok(stdout.includes(version), stdout);
    assert.match(stdout, /not writable/);
    assert.match(stderr, /daemon appears to be running.*vspi daemon stop/);
    assert.equal(await readFile(state, 'utf8'), metadata);
    const exportPath = stdout.split('\n').find((line) => line.startsWith('  export PATH='));
    assert.ok(exportPath);
    const result = await exec('sh', ['-c', `${exportPath}\ncommand -v vspi`], { cwd: home, env });
    assert.equal(result.stdout.trim(), localBin);
    assert.deepEqual(requests.splice(0), ['/install.sh', '/release/vspi-latest.tgz', '/release/SHA256SUMS']);
  });

  await t.test('rejects a mismatched checksum before installation', async () => {
    const { home, prefix, run } = await isolatedRun('checksum-mismatch', 'tampered');
    await assert.rejects(run(), { code: 1, stderr: /SHA-256 mismatch; nothing was installed/ });
    await assert.rejects(access(prefix), { code: 'ENOENT' });
    await assert.rejects(access(join(home, '.local')), { code: 'ENOENT' });
    assert.deepEqual(requests.splice(0), ['/install.sh', '/tampered/vspi-latest.tgz', '/tampered/SHA256SUMS']);
  });

  await t.test('rejects Node.js 22.18.0 before downloading release assets', async () => {
    const { home, prefix, env, run } = await isolatedRun('old-node');
    const bin = join(home, 'old-node-bin');
    await mkdir(bin);
    await writeFile(join(bin, 'node'), '#!/bin/sh\n[ "$*" = "-p process.versions.node" ] || exit 2\nprintf "22.18.0\\n"\n', { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    await assert.rejects(run(), {
      code: 1, stderr: /Node\.js >= 22\.19\.0 \(current: 22\.18\.0\)\.[\s\S]*fnm install 22[\s\S]*nvm install 22/,
    });
    await assert.rejects(access(prefix), { code: 'ENOENT' });
    assert.deepEqual(requests.splice(0), ['/install.sh']);
  });
});
