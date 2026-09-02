import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const stagingRoot = resolve(process.argv[2] ?? join(packageRoot, '.package-stage'));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const packageManifest = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  license: manifest.license,
  type: 'module',
  bin: { vspi: 'dist/main.mjs' },
  engines: { node: '>=24.15.0' },
};

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(join(stagingRoot, 'dist'), { recursive: true });
await Promise.all([
  writeFile(join(stagingRoot, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`),
  cp(join(repositoryRoot, 'LICENSE'), join(stagingRoot, 'LICENSE')),
  cp(join(packageRoot, 'README.md'), join(stagingRoot, 'README.md')),
  ...['main.mjs', 'search-worker.mjs', 'text-build-worker.mjs'].map((name) =>
    cp(join(packageRoot, 'dist', name), join(stagingRoot, 'dist', name)),
  ),
]);
process.stdout.write(`${stagingRoot}\n`);
