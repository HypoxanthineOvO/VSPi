import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function createReleasePayload(checksumPath, env = process.env) {
  const version = env.VERSION;
  const filename = env.FILENAME;
  const packageUrl = env.PACKAGE_URL;
  const latestPackageUrl = env.LATEST_PACKAGE_URL;
  const tag = env.CI_COMMIT_TAG;
  if (!version || !filename || !packageUrl || !latestPackageUrl || !tag)
    throw new Error("release environment is incomplete");
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match v${version}`);

  const checksumLine = readFileSync(checksumPath, "utf8").trim();
  const [sha256, checksumFilename] = checksumLine.split(/\s+/, 2);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !checksumFilename.endsWith(filename)) {
    throw new Error("invalid SHA256SUMS entry");
  }

  const directAssetUrl = `${env.CI_PROJECT_URL}/-/releases/${tag}/downloads/${filename}`;
  const latestFilename = "vspi-latest.tgz";
  const latestAssetUrl = `${env.CI_PROJECT_URL}/-/releases/permalink/latest/downloads/${latestFilename}`;
  const releaseNotes = env.RELEASE_NOTES_PATH ? readFileSync(env.RELEASE_NOTES_PATH, "utf8").trim() : "";
  const description = [
    ...(releaseNotes ? [releaseNotes, ""] : []),
    "## Install",
    "",
    "Windows PowerShell:",
    "",
    "```powershell",
    `npm install --global "${latestAssetUrl}"`,
    "vspi --version",
    "```",
    "",
    "Linux/macOS:",
    "",
    "```bash",
    `npm install -g '${latestAssetUrl}'`,
    "vspi --version",
    "```",
    "",
    `Pinned package: \`${directAssetUrl}\``,
    "",
    `SHA-256: \`${sha256}\``,
  ].join("\n");

  return {
    name: env.RELEASE_TITLE || `VSPi ${version}`,
    tag_name: tag,
    description,
    assets: {
      links: [
        { name: filename, url: packageUrl, direct_asset_path: `/${filename}`, link_type: "package" },
        {
          name: latestFilename,
          url: latestPackageUrl,
          direct_asset_path: `/${latestFilename}`,
          link_type: "package",
        },
      ],
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(createReleasePayload(process.argv[2])));
}
