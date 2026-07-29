import { cp, readFile, rm } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const PATCHED_VERSION = "5.0.8";
const VULNERABLE_VERSION = "5.0.7";

async function packageRoot(specifier, expectedName) {
  let cursor = dirname(fileURLToPath(import.meta.resolve(specifier)));
  const filesystemRoot = parse(cursor).root;
  while (cursor !== filesystemRoot) {
    try {
      const manifest = JSON.parse(await readFile(join(cursor, "package.json"), "utf8"));
      if (manifest.name === expectedName) return { path: cursor, version: manifest.version };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    cursor = dirname(cursor);
  }
  throw new Error(`Cannot locate package root for ${expectedName}`);
}

const source = await packageRoot("brace-expansion", "brace-expansion");
if (source.version !== PATCHED_VERSION) {
  throw new Error(`Expected brace-expansion ${PATCHED_VERSION}, found ${source.version}`);
}

const pi = await packageRoot("@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent");
const nested = join(pi.path, "node_modules", "brace-expansion");
let nestedVersion;
try {
  nestedVersion = JSON.parse(await readFile(join(nested, "package.json"), "utf8")).version;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

// npm may deduplicate the patched direct dependency. Only replace Pi's known bad
// shrinkwrapped copy; an unexpected version should be reviewed instead of overwritten.
if (nestedVersion === undefined || nestedVersion === PATCHED_VERSION) process.exit(0);
if (nestedVersion !== VULNERABLE_VERSION) {
  throw new Error(`Refusing to replace unexpected Pi brace-expansion ${nestedVersion}`);
}

await rm(nested, { recursive: true, force: true });
await cp(source.path, nested, { recursive: true });
console.log(`Patched Pi brace-expansion ${VULNERABLE_VERSION} -> ${PATCHED_VERSION}`);
