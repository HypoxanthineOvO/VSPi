import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function createReleasePayload(checksumPath, env = process.env) {
  const version = env.VERSION;
  const filename = env.FILENAME;
  const packageUrl = env.PACKAGE_URL;
  const tag = env.CI_COMMIT_TAG;
  if (!version || !filename || !packageUrl || !tag) throw new Error("release environment is incomplete");
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match v${version}`);

  const checksumLine = readFileSync(checksumPath, "utf8").trim();
  const [sha256, checksumFilename] = checksumLine.split(/\s+/, 2);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !checksumFilename.endsWith(filename)) {
    throw new Error("invalid SHA256SUMS entry");
  }

  const directAssetUrl = `${env.CI_PROJECT_URL}/-/releases/${tag}/downloads/${filename}`;
  const description = [
    `Install the prebuilt VSPi ${version} package:`,
    "",
    "```bash",
    `npm install -g '${directAssetUrl}'`,
    "```",
    "",
    `SHA-256: \`${sha256}\``,
  ].join("\n");

  return {
    name: `VSPi ${version}`,
    tag_name: tag,
    description,
    assets: { links: [{ name: filename, url: packageUrl, link_type: "package" }] },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(createReleasePayload(process.argv[2])));
}
