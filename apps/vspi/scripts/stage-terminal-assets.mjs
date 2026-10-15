import { cp, mkdir, access, readdir, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const appRoot = resolve(import.meta.dirname, '..');
const require = createRequire(join(appRoot, '../../packages/agent-core-v2/package.json'));
const ptyRoot = dirname(require.resolve('node-pty/package.json'));
const platform = `${process.platform}-${process.arch}`;
const destination = join(appRoot, 'dist/prebuilds');
const exists = path => access(path).then(() => true, () => false);
let current = join(ptyRoot, 'prebuilds', platform);
if (!await exists(join(current, 'pty.node'))) {
  current = join(ptyRoot, 'build/Release');
  if (!await exists(join(current, 'pty.node'))) {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'install'], { cwd: ptyRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  }
}
await mkdir(destination, { recursive: true });
for (const entry of await readdir(join(ptyRoot, 'prebuilds'), { withFileTypes: true })) {
  if (entry.isDirectory()) await cp(join(ptyRoot, 'prebuilds', entry.name), join(destination, entry.name), { recursive: true });
}
await mkdir(join(destination, platform), { recursive: true });
for (const entry of await readdir(current, { withFileTypes: true })) {
  if (entry.isFile() && (entry.name.endsWith('.node') || entry.name === 'spawn-helper')) {
    await cp(join(current, entry.name), join(destination, platform, entry.name));
  }
}
for (const entry of await readdir(destination)) {
  const helper = join(destination, entry, 'spawn-helper');
  if (await exists(helper)) await chmod(helper, 0o755);
}
