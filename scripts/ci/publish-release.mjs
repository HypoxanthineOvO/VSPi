import { readFileSync } from "node:fs";
import process from "node:process";

import { createReleasePayload } from "./create-release-payload.mjs";

const [checksumPath, tarballPath] = process.argv.slice(2);
const jobToken = process.env.CI_JOB_TOKEN;
const packageUrl = process.env.PACKAGE_URL;
const latestPackageUrl = process.env.LATEST_PACKAGE_URL;
const releasesUrl = `${process.env.CI_API_V4_URL}/projects/${process.env.CI_PROJECT_ID}/releases`;
if (!checksumPath || !tarballPath || !jobToken || !packageUrl || !latestPackageUrl) {
  throw new Error("release upload arguments or CI environment are incomplete");
}

async function request(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 2_000);
    throw new Error(`${init.method} ${url} failed with HTTP ${response.status}: ${body}`);
  }
  return response;
}

const packageBytes = readFileSync(tarballPath);
for (const url of [packageUrl, latestPackageUrl]) {
  await request(url, {
    method: "PUT",
    headers: { "JOB-TOKEN": jobToken, "Content-Type": "application/octet-stream" },
    body: packageBytes,
  });
}

const payload = createReleasePayload(checksumPath);
await request(releasesUrl, {
  method: "POST",
  headers: { "JOB-TOKEN": jobToken, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

console.log(`published ${process.env.CI_COMMIT_TAG}`);
