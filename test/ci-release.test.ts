import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CI release publisher", () => {
  it("uploads the package and creates a release from the same artifact metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vspi-release-"));
    const tarball = join(directory, "vspi-1.2.3.tgz");
    const checksums = join(directory, "SHA256SUMS");
    const tarballBody = Buffer.from("package bytes");
    const sha256 = "a".repeat(64);
    await writeFile(tarball, tarballBody);
    await writeFile(checksums, `${sha256}  .artifacts/vspi-1.2.3.tgz\n`);

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
            CI_COMMIT_TAG: "v1.2.3",
            CI_PROJECT_URL: "https://gitlab.example/heyx/vspi",
            CI_API_V4_URL: `${origin}/api/v4`,
            CI_PROJECT_ID: "107",
            CI_JOB_TOKEN: "job-token",
          },
        },
      );

      expect(result.stdout.trim()).toBe("published v1.2.3");
      expect(requests).toHaveLength(2);
      const uploadRequest = requests[0];
      const releaseRequest = requests[1];
      if (!uploadRequest || !releaseRequest) throw new Error("release publisher did not make both requests");
      expect(uploadRequest).toMatchObject({ method: "PUT", url: "/packages/vspi-1.2.3.tgz" });
      expect(uploadRequest.headers["job-token"]).toBe("job-token");
      expect(uploadRequest.body).toEqual(tarballBody);

      expect(releaseRequest).toMatchObject({ method: "POST", url: "/api/v4/projects/107/releases" });
      expect(releaseRequest.headers["job-token"]).toBe("job-token");
      const release = JSON.parse(releaseRequest.body.toString("utf8"));
      expect(release).toMatchObject({
        name: "VSPi 1.2.3",
        tag_name: "v1.2.3",
        assets: {
          links: [
            {
              name: "vspi-1.2.3.tgz",
              direct_asset_path: "/vspi-1.2.3.tgz",
              link_type: "package",
            },
          ],
        },
      });
      expect(release.description).toContain(sha256);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      await rm(directory, { force: true, recursive: true });
    }
  });
});
