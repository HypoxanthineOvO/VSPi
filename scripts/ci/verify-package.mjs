import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(`package verification failed: ${message}`);
}

const metadataPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) fail("expected the npm pack JSON path");

const projectPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const projectLock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
if (!Array.isArray(metadata) || metadata.length !== 1) fail("npm pack must produce exactly one package");

const packed = metadata[0];
if (projectLock.name !== projectPackage.name || projectLock.version !== projectPackage.version) {
  fail("package-lock root identity differs from package.json");
}
if (
  projectLock.packages?.[""]?.name !== projectPackage.name ||
  projectLock.packages?.[""]?.version !== projectPackage.version
) {
  fail("package-lock workspace identity differs from package.json");
}
const expectedFilename = `${projectPackage.name}-${projectPackage.version}.tgz`;
if (packed.name !== projectPackage.name) fail(`unexpected package name ${packed.name}`);
if (packed.version !== projectPackage.version) fail(`unexpected package version ${packed.version}`);
if (packed.filename !== expectedFilename) fail(`unexpected filename ${packed.filename}`);

const tarball = resolve(dirname(metadataPath), packed.filename);
const packedPackage = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
if (packedPackage.name !== projectPackage.name || packedPackage.version !== projectPackage.version) {
  fail("packed package.json identity differs from the repository metadata");
}
if (packedPackage.bin?.vspi !== "dist/index.js") fail("packed CLI entry point is invalid");
if (Object.hasOwn(packedPackage.scripts ?? {}, "prepare")) fail("packed package must not define prepare");
if (
  packedPackage.scripts?.postinstall !==
  "node scripts/patch-pi-brace-expansion.mjs && node scripts/patch-pi-editor-performance.mjs"
) {
  fail("packed postinstall does not apply the guarded Pi dependency patches");
}

const files = new Map((packed.files ?? []).map((file) => [file.path, file]));
for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "Docs/usage.md",
  "dist/index.js",
  "dist/index.d.ts",
  "scripts/patch-pi-brace-expansion.mjs",
  "scripts/patch-pi-editor-performance.mjs",
]) {
  if (!files.has(required)) fail(`required file is missing: ${required}`);
}
if ((files.get("dist/index.js")?.mode & 0o111) === 0) fail("dist/index.js is not executable");

const allowed =
  /^(?:package\.json|README\.md|LICENSE$|dist\/|Docs\/(?:usage|tui-v1|testing-and-debugging)\.md$|Docs\/harness\/|scripts\/(?:patch-pi-brace-expansion|patch-pi-editor-performance)\.mjs$)/;
for (const path of files.keys()) {
  if (!allowed.test(path)) fail(`unexpected file in package: ${path}`);
  if (/^(?:src|test|node_modules|\.git)(?:\/|$)/.test(path)) fail(`private source leaked: ${path}`);
}

const tag = process.env.CI_COMMIT_TAG;
if (tag && tag !== `v${projectPackage.version}`) {
  fail(`tag ${tag} does not match package version v${projectPackage.version}`);
}

console.log(`verified ${packed.filename} (${files.size} files)`);
