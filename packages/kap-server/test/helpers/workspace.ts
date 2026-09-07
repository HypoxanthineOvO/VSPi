import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function isolateTestWorkspace(workspace: string): Promise<string> {
  await mkdir(join(workspace, '.git'));
  return workspace;
}

export function isolateTestWorkspaceSync(workspace: string): string {
  mkdirSync(join(workspace, '.git'));
  return workspace;
}
