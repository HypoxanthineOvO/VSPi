import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { resolvePackagedRuntimeAssets } from '../src/runtime-workers.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('VSPi packaged runtime workers', () => {
  it('returns both sibling worker assets', async () => {
    const directory = await createDirectory();
    await Promise.all([
      writeFile(join(directory, 'main.mjs'), ''),
      writeFile(join(directory, 'search-worker.mjs'), ''),
      writeFile(join(directory, 'text-build-worker.mjs'), ''),
    ]);
    expect(resolvePackagedRuntimeAssets(pathToFileURL(join(directory, 'main.mjs')))).toEqual({
      searchWorkerPath: join(directory, 'search-worker.mjs'),
      textBuildWorkerPath: join(directory, 'text-build-worker.mjs'),
    });
  });

  it('allows source development with no packaged assets and rejects partial packages', async () => {
    const directory = await createDirectory();
    const entry = pathToFileURL(join(directory, 'main.ts'));
    expect(resolvePackagedRuntimeAssets(entry)).toBeUndefined();
    await writeFile(join(directory, 'search-worker.mjs'), '');
    expect(() => resolvePackagedRuntimeAssets(entry)).toThrow(/must ship together/u);
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vspi-workers-'));
  directories.push(directory);
  return directory;
}
