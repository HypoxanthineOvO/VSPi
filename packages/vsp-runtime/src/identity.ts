import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import { resolveRuntimePaths } from './paths.js';

const RUNTIME_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function getRuntimeId(homeDir: string): Promise<string> {
  const paths = resolveRuntimePaths(homeDir);
  const uuidPath = join(paths.serverDir, 'runtime-id');
  let persisted: string | undefined;
  try {
    persisted = await readFile(uuidPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let uuid: string;
  if (persisted === undefined) {
    uuid = await persistRuntimeUuid(uuidPath);
  } else {
    uuid = persisted.trim();
    if (!RUNTIME_UUID_PATTERN.test(uuid)) throw new Error('VSP runtime identity file is malformed');
  }
  const canonicalHome = await realpath(paths.homeDir);
  const user = process.getuid?.() ?? userInfo().username;
  return createHash('sha256').update(JSON.stringify([uuid, hostname(), user, canonicalHome])).digest('hex');
}

async function persistRuntimeUuid(path: string): Promise<string> {
  const uuid = randomUUID();
  const temporaryPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let handle: FileHandle | undefined;
  let completed = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${uuid}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    completed = true;
    return uuid;
  } finally {
    await handle?.close().catch(() => {});
    if (!completed) await rm(temporaryPath, { force: true });
  }
}
