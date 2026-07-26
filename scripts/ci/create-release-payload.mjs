import { readFileSync } from "node:fs";
import process from "node:process";

const version = process.env.VERSION;
const filename = process.env.FILENAME;
const packageUrl = process.env.PACKAGE_URL;
const tag = process.env.CI_COMMIT_TAG;
if (!version || !filename || !packageUrl || !tag) throw new Error("release environment is incomplete");
if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match v${version}`);

const checksumLine = readFileSync(process.argv[2], "utf8").trim();
const [sha256, checksumFilename] = checksumLine.split(/\s+/, 2);
if (!/^[a-f0-9]{64}$/.test(sha256) || !checksumFilename.endsWith(filename)) {
  throw new Error("invalid SHA256SUMS entry");
}

const directAssetUrl = `${process.env.CI_PROJECT_URL}/-/releases/${tag}/downloads/${filename}`;
const description = [
  `Install the prebuilt VSPi ${version} package:`,
  "",
  "```bash",
  `npm install -g '${directAssetUrl}'`,
  "```",
  "",
  `SHA-256: \`${sha256}\``,
].join("\n");

process.stdout.write(
  JSON.stringify({
    name: `VSPi ${version}`,
    tag_name: tag,
    description,
    assets: { links: [{ name: filename, url: packageUrl, link_type: "package" }] },
  }),
);
