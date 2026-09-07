import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ProjectPathScope {
  workspaceRoot: string;
  projectDir: string;
  target: string;
}

export async function inspectProjectPath(cwd: string, filename: string): Promise<ProjectPathScope> {
  const lexicalRoot = resolve(cwd);
  const rootStat = await lstat(lexicalRoot);
  if (!rootStat.isDirectory()) throw new Error("project scope 边界无效：workspace root 不是目录");
  const workspaceRoot = await realpath(lexicalRoot);
  const projectDir = join(lexicalRoot, ".vspi");
  const target = join(projectDir, filename);

  const directory = await lstatIfPresent(projectDir);
  if (!directory) return { workspaceRoot, projectDir, target };
  if (directory.isSymbolicLink()) throw new Error("project scope 拒绝 .vspi 符号链接 (symlink)");
  if (!directory.isDirectory()) throw new Error("project scope 边界无效：.vspi 不是目录");
  assertContained(workspaceRoot, await realpath(projectDir), ".vspi");
  await assertProjectEntrySafe(target, "project target");
  return { workspaceRoot, projectDir, target };
}

export async function prepareProjectPath(cwd: string, filename: string): Promise<ProjectPathScope> {
  const lexicalRoot = resolve(cwd);
  if (!(await lstatIfPresent(lexicalRoot))) await mkdir(lexicalRoot, { recursive: true, mode: 0o700 });
  let scope = await inspectProjectPath(cwd, filename);
  const directory = await lstatIfPresent(scope.projectDir);
  if (!directory) await mkdir(scope.projectDir, { mode: 0o700 });
  scope = await inspectProjectPath(cwd, filename);
  const verified = await lstat(scope.projectDir);
  if (!verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error("project scope 边界复验失败：.vspi 必须是非符号链接目录");
  }
  return scope;
}

export async function assertProjectEntrySafe(path: string, label: string): Promise<void> {
  const entry = await lstatIfPresent(path);
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new Error(`${label} 拒绝符号链接 (symlink)`);
  if (!entry.isFile()) throw new Error(`${label} 必须是普通文件`);
}

export async function verifyProjectParent(scope: ProjectPathScope): Promise<void> {
  const directory = await lstat(scope.projectDir);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("project scope 边界复验失败：.vspi 不再是安全目录");
  }
  assertContained(scope.workspaceRoot, await realpath(scope.projectDir), ".vspi");
}

function assertContained(root: string, candidate: string, label: string): void {
  const relation = relative(root, candidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return;
  throw new Error(`project scope 边界拒绝：${label} 位于 workspace 外部`);
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
