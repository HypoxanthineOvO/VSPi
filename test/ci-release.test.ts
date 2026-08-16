import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("release metadata", () => {
  it("keeps package.json and both lockfile root identities aligned", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    const lockfile = JSON.parse(await readFile(resolve("package-lock.json"), "utf8"));
    expect({ name: lockfile.name, version: lockfile.version }).toEqual({
      name: manifest.name,
      version: manifest.version,
    });
    expect({ name: lockfile.packages?.[""]?.name, version: lockfile.packages?.[""]?.version }).toEqual({
      name: manifest.name,
      version: manifest.version,
    });
  });
});

describe("CI release publisher", () => {
  it("uploads the package and creates a release from the same artifact metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-release-"));
    const tarball = join(directory, "vspi-1.2.3.tgz");
    const checksums = join(directory, "SHA256SUMS");
    const releaseNotes = join(directory, "release-notes.md");
    const tarballBody = Buffer.from("package bytes");
    const sha256 = "a".repeat(64);
    await writeFile(tarball, tarballBody);
    await writeFile(checksums, `${sha256}  .artifacts/vspi-1.2.3.tgz\n`);
    await writeFile(releaseNotes, "## Fullscreen Runtime\n\nAgent Teams and Persistent Goals.");

    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: IncomingHttpHeaders;
      body: Buffer;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end("{}");
      });
    });

    try {
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
      const origin = `http://127.0.0.1:${address.port}`;

      const result = await execFileAsync(
        process.execPath,
        [resolve("scripts/ci/publish-release.mjs"), checksums, tarball],
        {
          env: {
            ...process.env,
            VERSION: "1.2.3",
            FILENAME: "vspi-1.2.3.tgz",
            PACKAGE_URL: `${origin}/packages/vspi-1.2.3.tgz`,
            LATEST_PACKAGE_URL: `${origin}/packages/vspi-latest.tgz`,
            CI_COMMIT_TAG: "v1.2.3",
            CI_PROJECT_URL: "https://gitlab.example/heyx/vspi",
            CI_API_V4_URL: `${origin}/api/v4`,
            CI_PROJECT_ID: "107",
            CI_JOB_TOKEN: "job-token",
            RELEASE_TITLE: "VSPi 1.2.3 - Fullscreen Runtime",
            RELEASE_NOTES_PATH: releaseNotes,
          },
        },
      );

      expect(result.stdout.trim()).toBe("published v1.2.3");
      expect(requests).toHaveLength(3);
      const uploadRequest = requests[0];
      const latestUploadRequest = requests[1];
      const releaseRequest = requests[2];
      if (!uploadRequest || !latestUploadRequest || !releaseRequest)
        throw new Error("release publisher did not make all requests");
      expect(uploadRequest).toMatchObject({ method: "PUT", url: "/packages/vspi-1.2.3.tgz" });
      expect(uploadRequest.headers["job-token"]).toBe("job-token");
      expect(uploadRequest.body).toEqual(tarballBody);
      expect(latestUploadRequest).toMatchObject({ method: "PUT", url: "/packages/vspi-latest.tgz" });
      expect(latestUploadRequest.headers["job-token"]).toBe("job-token");
      expect(latestUploadRequest.body).toEqual(tarballBody);

      expect(releaseRequest).toMatchObject({ method: "POST", url: "/api/v4/projects/107/releases" });
      expect(releaseRequest.headers["job-token"]).toBe("job-token");
      const release = JSON.parse(releaseRequest.body.toString("utf8"));
      expect(release).toMatchObject({
        name: "VSPi 1.2.3 - Fullscreen Runtime",
        tag_name: "v1.2.3",
        assets: {
          links: [
            {
              name: "vspi-1.2.3.tgz",
              direct_asset_path: "/vspi-1.2.3.tgz",
              link_type: "package",
            },
            {
              name: "vspi-latest.tgz",
              url: `${origin}/packages/vspi-latest.tgz`,
              direct_asset_path: "/vspi-latest.tgz",
              link_type: "package",
            },
          ],
        },
      });
      expect(release.description).toContain(sha256);
      expect(release.description).toContain("Agent Teams and Persistent Goals");
      expect(release.description).toContain("```powershell");
      expect(release.description).toContain(
        "https://gitlab.example/heyx/vspi/-/releases/permalink/latest/downloads/vspi-latest.tgz",
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      await rm(directory, { force: true, recursive: true });
    }
  });
});
