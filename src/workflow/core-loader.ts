import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LoadedWorkflowCore, WorkflowBundleIdentity, WorkflowCoreModule } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REQUIRED_EXPORTS = [
  "createDeliveryStore",
  "createWorkstreamStore",
  "compileVspiIntegrationContract",
  "parseVspiIntegrationContract",
  "verifyPortableBundle",
] as const;

export interface WorkflowCoreLoaderOptions {
  root: string;
  archivePath: string;
  expectedSourceCommit: string;
  expectedArchiveSha256: string;
  expectedManifestSha256: string;
  expectedRuntimeManifestSha256: string;
}

export async function loadWorkflowCore(options: WorkflowCoreLoaderOptions): Promise<LoadedWorkflowCore> {
  if (!isAbsolute(options.root) || !isAbsolute(options.archivePath)) {
    throw new Error("Workflow Core root and archive must be absolute paths");
  }
  if (
    !COMMIT.test(options.expectedSourceCommit) ||
    !SHA256.test(options.expectedArchiveSha256) ||
    !SHA256.test(options.expectedManifestSha256) ||
    !SHA256.test(options.expectedRuntimeManifestSha256)
  ) {
    throw new Error("Workflow Core expected commit or artifact digest is invalid");
  }
  const root = await ordinaryDirectoryRealpath(options.root, "Workflow Core root");
  const archivePath = await ordinaryFileRealpath(options.archivePath, "Workflow Core archive");
  const archiveSha256 = sha256(await readFile(archivePath));
  if (archiveSha256 !== options.expectedArchiveSha256) {
    throw new Error("Workflow Core archive digest does not match the accepted bundle");
  }

  const descriptor = record(await readJson(root, "contracts/host/v1/installed-release.json"), "release descriptor");
  exactKeys(descriptor, ["schema_version", "contract_version", "release", "command_manifest"], "release descriptor");
  if (descriptor.schema_version !== "1" || descriptor.contract_version !== "1") {
    throw new Error("Workflow Core Host Contract version is unsupported");
  }
  const release = record(descriptor.release, "release identity");
  exactKeys(release, ["version", "source_commit"], "release identity");
  if (release.source_commit !== options.expectedSourceCommit || typeof release.version !== "string") {
    throw new Error("Workflow Core source commit does not match the accepted bundle");
  }

  const manifestPath = resolveWithin(root, "bundle-manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error("Workflow Core bundle manifest is unsafe");
  }
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== options.expectedManifestSha256) {
    throw new Error("Workflow Core bundle manifest digest does not match the accepted bundle");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Workflow Core bundle-manifest.json is malformed");
  }
  await verifyManifestBytes(root, manifest);
  await verifyRuntimeManifest(root, options.expectedRuntimeManifestSha256);
  const entry = resolveWithin(root, "core/src/index.js");
  const imported: unknown = await import(pathToFileURL(entry).href);
  const core = workflowCore(imported);
  const verified = await core.verifyPortableBundle({ root, manifest });
  if (!Array.isArray(verified.files) || !verified.files.includes("core/src/index.js")) {
    throw new Error("Workflow Core bundle verification did not cover the root export");
  }
  const contract = core.parseVspiIntegrationContract(
    core.compileVspiIntegrationContract({ generated_at: new Date().toISOString() }),
  );
  const contractRecord = record(contract, "VSPi integration contract");
  if (contractRecord.contract_version !== "1") throw new Error("Workflow Core VSPi contract version is unsupported");

  const identity: WorkflowBundleIdentity = {
    version: release.version,
    sourceCommit: release.source_commit,
    archiveSha256,
    contractVersion: String(contractRecord.contract_version),
    root,
  };
  return { core, identity };
}

export function workflowLoaderOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowCoreLoaderOptions | undefined {
  const root = env.VSPI_WORKFLOW_ROOT;
  const archivePath = env.VSPI_WORKFLOW_ARCHIVE;
  const expectedSourceCommit = env.VSPI_WORKFLOW_SOURCE_COMMIT;
  const expectedArchiveSha256 = env.VSPI_WORKFLOW_ARCHIVE_SHA256;
  const expectedManifestSha256 = env.VSPI_WORKFLOW_MANIFEST_SHA256;
  const expectedRuntimeManifestSha256 = env.VSPI_WORKFLOW_RUNTIME_MANIFEST_SHA256;
  if (
    !root &&
    !archivePath &&
    !expectedSourceCommit &&
    !expectedArchiveSha256 &&
    !expectedManifestSha256 &&
    !expectedRuntimeManifestSha256
  )
    return undefined;
  if (
    !root ||
    !archivePath ||
    !expectedSourceCommit ||
    !expectedArchiveSha256 ||
    !expectedManifestSha256 ||
    !expectedRuntimeManifestSha256
  ) {
    throw new Error(
      "Workflow Core requires root, archive, source commit, archive digest, bundle manifest digest, and runtime manifest digest together",
    );
  }
  return {
    root,
    archivePath,
    expectedSourceCommit,
    expectedArchiveSha256,
    expectedManifestSha256,
    expectedRuntimeManifestSha256,
  };
}

async function verifyRuntimeManifest(root: string, expectedSha256: string): Promise<void> {
  const path = resolveWithin(root, "runtime-manifest.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Workflow Core runtime manifest is unsafe");
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error("Workflow Core runtime manifest digest does not match the accepted installation");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Workflow Core runtime manifest is malformed");
  }
  const manifest = record(parsed, "runtime manifest");
  exactKeys(manifest, ["schema_version", "files"], "runtime manifest");
  if (manifest.schema_version !== "1" || !Array.isArray(manifest.files)) {
    throw new Error("Workflow Core runtime manifest is invalid");
  }
  const expected = new Set<string>();
  for (const raw of manifest.files) {
    const file = record(raw, "runtime manifest file");
    exactKeys(file, ["path", "sha256", "bytes"], "runtime manifest file");
    if (
      typeof file.path !== "string" ||
      !file.path.startsWith("node_modules/") ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256)
    ) {
      throw new Error("Workflow Core runtime manifest file is invalid");
    }
    if (expected.has(file.path)) throw new Error("Workflow Core runtime manifest contains a duplicate path");
    expected.add(file.path);
    const installed = resolveWithin(root, file.path);
    const installedMetadata = await lstat(installed);
    if (!installedMetadata.isFile() || installedMetadata.isSymbolicLink()) {
      throw new Error("Workflow Core runtime dependency is unsafe");
    }
    const installedBytes = await readFile(installed);
    if (file.bytes !== installedBytes.length || file.sha256 !== sha256(installedBytes)) {
      throw new Error("Workflow Core runtime dependency does not match its manifest");
    }
  }
  const actual = await runtimeFiles(root);
  if (actual.size !== expected.size || [...actual].some((file) => !expected.has(file))) {
    throw new Error("Workflow Core runtime dependency tree contains unbound files");
  }
}

async function runtimeFiles(root: string): Promise<Set<string>> {
  const output = new Set<string>();
  const modules = resolveWithin(root, "node_modules");
  let rootMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    rootMetadata = await lstat(modules);
  } catch (error) {
    if (isCode(error, "ENOENT")) return output;
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Workflow Core node_modules root is unsafe");
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Workflow Core runtime dependency contains a symlink");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.add(relative(root, absolute).replaceAll("\\", "/"));
      else throw new Error("Workflow Core runtime dependency contains an unsafe entry");
    }
  }
  await visit(modules);
  return output;
}

async function verifyManifestBytes(root: string, value: unknown): Promise<void> {
  const manifest = record(value, "bundle manifest");
  exactKeys(manifest, ["schema_version", "contract_version", "files"], "bundle manifest");
  if (manifest.schema_version !== "1" || manifest.contract_version !== "1" || !Array.isArray(manifest.files)) {
    throw new Error("Workflow Core bundle manifest is invalid");
  }
  const seen = new Set<string>();
  for (const raw of manifest.files) {
    const file = record(raw, "bundle manifest file");
    exactKeys(file, ["path", "sha256", "bytes"], "bundle manifest file");
    if (typeof file.path !== "string" || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw new Error("Workflow Core bundle manifest file is invalid");
    }
    if (seen.has(file.path)) throw new Error("Workflow Core bundle manifest contains a duplicate path");
    seen.add(file.path);
    const path = resolveWithin(root, file.path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Workflow Core bundle contains an unsafe file");
    const bytes = await readFile(path);
    if (file.bytes !== bytes.length || file.sha256 !== sha256(bytes)) {
      throw new Error("Workflow Core installed files do not match the bundle manifest");
    }
  }
  for (const required of ["contracts/host/v1/installed-release.json", "core/src/index.js"]) {
    if (!seen.has(required)) throw new Error(`Workflow Core bundle manifest does not bind ${required}`);
  }
}

async function readJson(root: string, path: string): Promise<unknown> {
  const absolute = resolveWithin(root, path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Workflow Core ${path} is unsafe`);
  try {
    return JSON.parse(await readFile(absolute, "utf8"));
  } catch {
    throw new Error(`Workflow Core ${path} is malformed`);
  }
}

function workflowCore(value: unknown): WorkflowCoreModule {
  const module = record(value, "Core module");
  for (const name of REQUIRED_EXPORTS) {
    if (typeof module[name] !== "function") throw new Error(`Workflow Core required export ${name} is missing`);
  }
  return module as unknown as WorkflowCoreModule;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Workflow Core ${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`Workflow Core ${label} contains unsupported fields`);
  }
}

function resolveWithin(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Workflow Core bundle path is unsafe");
  }
  const absolute = resolve(root, path);
  const relation = relative(root, absolute);
  if (!relation || relation.startsWith("..") || isAbsolute(relation))
    throw new Error("Workflow Core bundle path escapes root");
  return absolute;
}

async function ordinaryDirectoryRealpath(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be an ordinary directory`);
  return canonical;
}

async function ordinaryFileRealpath(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be an ordinary file`);
  return canonical;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
