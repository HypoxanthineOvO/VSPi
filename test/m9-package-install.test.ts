import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const ROOT = resolve(import.meta.dirname, "..");

interface PackDescription {
  filename: string;
  files: Array<{ path: string }>;
}

async function npm(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return execFile("npm", args, { cwd, env, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
}

function parsePack(stdout: string): PackDescription {
  const parsed = JSON.parse(stdout) as PackDescription[];
  const pack = parsed[0];
  if (!pack) throw new Error("npm pack returned no package description");
  return pack;
}

describe("M9 npm package artifact", () => {
  it("dry-runs and creates a minimal tarball with the declared bin and release docs", async () => {
    const dry = parsePack((await npm(["pack", "--dry-run", "--json", "--ignore-scripts"], ROOT)).stdout);
    const dryPaths = dry.files.map((entry) => entry.path);
    expect(dryPaths).toEqual(expect.arrayContaining(["package.json", "README.md", "Docs/tui-v1.md", "dist/index.js"]));
    expect(dryPaths.some((path) => /^(?:src|test|\.pipeline|tmp)\//.test(path))).toBe(false);
    expect(dryPaths.some((path) => /^dist\/update\//.test(path))).toBe(false);

    const output = await mkdtemp(join(tmpdir(), "vspi-m9-pack-"));
    const packed = parsePack(
      (await npm(["pack", ROOT, "--pack-destination", output, "--json", "--ignore-scripts"], ROOT)).stdout,
    );
    const tarball = join(output, packed.filename);
    const listing = (await execFile("tar", ["-tf", tarball], { timeout: 30_000 })).stdout.trim().split("\n").sort();
    expect(listing).toContain("package/dist/index.js");
    expect(listing).toContain("package/package.json");
    expect(listing.some((path) => path.includes("/test/") || path.includes("/.pipeline/"))).toBe(false);
    expect(listing.some((path) => path.includes("/dist/update/"))).toBe(false);
  }, 150_000);

  it("installs the real tarball in an empty project and runs its bin smoke explicitly in Fixture mode", async () => {
    const output = await mkdtemp(join(tmpdir(), "vspi-m9-install-pack-"));
    const packed = parsePack(
      (await npm(["pack", ROOT, "--pack-destination", output, "--json", "--ignore-scripts"], ROOT)).stdout,
    );
    const tarball = join(output, packed.filename);
    const project = await mkdtemp(join(tmpdir(), "vspi-m9-consumer-"));
    await npm(["init", "--yes"], project);
    await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], project);

    const bin = join(project, "node_modules", ".bin", "vspi");
    await chmod(bin, 0o700);
    const home = await mkdtemp(join(tmpdir(), "vspi-m9-consumer-home-"));
    const result = await execFile(bin, ["--render-once"], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        NO_COLOR: "1",
        VSPi_FIXTURE: "1",
        VSPi_REDUCED_MOTION: "1",
      },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const outputText = `${result.stdout}\n${result.stderr}`;
    expect(outputText).toContain("VSPi");
    expect(outputText).toMatch(/Offline Fixture|Backend Fixture/);
    expect(outputText).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|UnhandledPromiseRejection/);

    const installedPackage = JSON.parse(
      await readFile(join(project, "node_modules", "vspi", "package.json"), "utf8"),
    ) as {
      bin?: Record<string, string>;
    };
    expect(installedPackage.bin).toEqual({ vspi: "dist/index.js" });
  }, 150_000);
});
