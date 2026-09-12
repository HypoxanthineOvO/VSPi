import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const PAYLOAD_FILES = ['main.mjs', 'search-worker.mjs', 'text-build-worker.mjs'];

export async function runtimeBuildId(entry: string): Promise<string> {
  const hash = createHash('sha256').update(await readFile(entry));
  if (basename(entry) === 'main.mjs') {
    for (const name of PAYLOAD_FILES.slice(1)) {
      const bytes = await readFile(join(dirname(entry), name)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (bytes) hash.update(name).update(bytes);
    }
    const skill = await readFile(join(dirname(entry), '..', 'skills', 'vspi-self', 'SKILL.md')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (skill) hash.update('vspi-self').update(skill);
  }
  return hash.digest('hex');
}

export async function stageRuntimeBuild(entry: string, homeDir: string, buildId: string): Promise<string> {
  if (basename(entry) !== 'main.mjs') return entry;
  const root = join(homeDir, 'server', 'builds');
  const target = join(root, buildId);
  const targetEntry = join(target, 'dist', 'main.mjs');
  const existing = await runtimeBuildId(targetEntry).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing !== undefined) {
    if (existing !== buildId) throw new Error('Runtime build snapshot failed integrity validation');
    return targetEntry;
  }
  const temporary = join(root, `.${buildId}.${randomUUID()}`);
  await mkdir(join(temporary, 'dist'), { recursive: true, mode: 0o700 });
  try {
    for (const name of PAYLOAD_FILES) await cp(join(dirname(entry), name), join(temporary, 'dist', name));
    await cp(join(dirname(entry), '..', 'skills'), join(temporary, 'skills'), { recursive: true });
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'vspi', private: true, type: 'module' }), { mode: 0o600 });
    if (await runtimeBuildId(join(temporary, 'dist', 'main.mjs')) !== buildId) throw new Error('VSPi files changed while staging the runtime; retry after installation completes');
    try { await rename(temporary, target); }
    catch (error) {
      if (await runtimeBuildId(targetEntry).catch(() => undefined) !== buildId) throw error;
    }
    return targetEntry;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
