// Generated deployment files are checked through hashes, Bash, and the actual Caddy parser.
// Run: VSPI_TEST_CADDY=/path/to/caddy node --test scripts/prepare-vspi-admin.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareVspiAdmin } from './prepare-vspi-admin.mjs';

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vspi-admin-test-'));
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts);
  for (const file of [
    'feedback-server.mjs',
    'feedback-admin.mjs',
    'distribution-admin.mjs',
    'distribution-install.mjs',
  ])
    await writeFile(join(artifacts, file), 'export {};\n');
  return {
    root,
    options: {
      out: join(root, 'out'),
      artifactDirectory: artifacts,
      publicHost: 'download.example.test',
      internalHost: 'internal.example.test',
      edenAddress: '192.0.2.10',
      edenHostname: 'eden',
      publicHostname: 'public',
      caddyConfig: '/etc/caddy/Caddyfile',
      caddyService: 'caddy.service',
    },
  };
}

await test('admin package renders fixed routes and hashes every supplied deployment file', async () => {
  const f = await fixture();
  try {
    const out = await prepareVspiAdmin(f.options);
    for (const group of ['eden', 'hypo']) {
      for (const line of (await readFile(join(out, group, 'SHA256SUMS'), 'utf8'))
        .trim()
        .split('\n')) {
        const [hash, filename] = line.split('  ');
        assert.equal(
          createHash('sha256')
            .update(await readFile(join(out, group, filename)))
            .digest('hex'),
          hash,
        );
      }
    }
    const edge = await readFile(join(out, 'hypo/hypo.Caddyfile'), 'utf8');
    assert.match(edge, /tls_server_name internal\.example\.test/);
    assert.match(edge, /max_size 1048576/);
    assert.doesNotMatch(edge, /insecure_skip_verify|request_buffers|response_buffers|__\w+__/);
    const unit = await readFile(join(out, 'eden/vspi-feedback.service'), 'utf8');
    assert.match(unit, /Group=vspi-feedback\nSupplementaryGroups=vspi-feedback-read/);
    assert.match(unit, /flock --nonblock --no-fork/);
    assert.deepEqual(
      JSON.parse(await readFile(join(out, 'eden/server.example.json'), 'utf8')).submitters,
      [],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('admin package refuses shell-injecting target values before writing output', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareVspiAdmin({ ...f.options, caddyService: 'caddy.service;id' }));
    assert.deepEqual(await readdir(f.root), ['artifacts']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test(
  'generated public relay configuration adapts successfully with Caddy',
  { skip: !process.env.VSPI_TEST_CADDY && 'Set VSPI_TEST_CADDY to the deployment Caddy binary' },
  async () => {
    const f = await fixture();
    try {
      const out = await prepareVspiAdmin(f.options);
      const { stdout } = await exec(process.env.VSPI_TEST_CADDY, [
        'adapt',
        '--adapter',
        'caddyfile',
        '--config',
        join(out, 'hypo/hypo.Caddyfile'),
      ]);
      assert.ok(JSON.parse(stdout).apps.http.servers);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

await test(
  'generated administrative scripts pass bash syntax checks',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture();
    try {
      const out = await prepareVspiAdmin(f.options);
      for (const path of ['eden/eden-admin.sh', 'eden/hermes-readonly.sh', 'hypo/hypo-admin.sh'])
        await exec('bash', ['-n', join(out, path)]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

await test(
  'Hermes SSH wrapper refuses arbitrary commands and traversal',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture();
    try {
      const out = await prepareVspiAdmin(f.options);
      for (const command of [
        'id',
        'list; id',
        'show ../../server.json',
        'show 00000000-0000-4000-8000-000000000000; id',
      ]) {
        await assert.rejects(
          exec('bash', [join(out, 'eden/hermes-readonly.sh')], {
            env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
          }),
          (error) => error.code === 2,
        );
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
