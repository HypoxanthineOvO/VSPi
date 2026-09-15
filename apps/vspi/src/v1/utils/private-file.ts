import { constants } from 'node:fs';
import { link, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export async function createPrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}

export async function readPrivateFile(path: string, limit: number): Promise<Buffer> {
  return readFileUnderLimit(path, limit, true);
}

export async function readRegularFile(path: string, limit: number): Promise<Buffer> {
  return readFileUnderLimit(path, limit, false);
}

async function readFileUnderLimit(
  path: string,
  limit: number,
  privateOnly: boolean,
): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > limit ||
      (privateOnly &&
        process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new Error('File must be regular, within its size limit and satisfy its privacy policy');
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit || offset > info.size) throw new Error('File changed or exceeds size limit');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
