import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

interface HarnessSource {
  family: string;
  sourceUrl: string;
  ref: { type: "commit" | "tag"; value: string };
  licensePolicy: string;
  applicableModels: string[];
  extractionPath: string;
  rewriteRationale: string;
  evaluation: { status: "unreviewed" | "reviewed" | "verified"; notes: string };
  lastReviewed: string;
}

interface HarnessManifest {
  schemaVersion: 1;
  sources: HarnessSource[];
}

const ROOT = join(import.meta.dirname, "..");
const HARNESS_ROOT = join(ROOT, "Docs", "harness");
const MANIFEST_PATH = join(HARNESS_ROOT, "sources.json");
const REQUIRED_FAMILIES = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshot",
  "z-ai",
  "xiaomi",
  "minimax",
  "tencent",
  "alibaba",
] as const;
const execFileAsync = promisify(execFile);

async function readManifest(): Promise<HarnessManifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as HarnessManifest;
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.set(relative(root, path), await readFile(path, "utf8"));
    }
  };
  await visit(root);
  return result;
}

describe("M7 official Harness source library", () => {
  it("provides a versioned source manifest with complete provenance and review metadata", async () => {
    const manifest = await readManifest();
    expect(manifest).toMatchObject({ schemaVersion: 1 });
    expect(new Set(manifest.sources.map((source) => source.family))).toEqual(new Set(REQUIRED_FAMILIES));

    for (const source of manifest.sources) {
      expect(source.sourceUrl).toMatch(/^https:\/\//);
      expect(["commit", "tag"]).toContain(source.ref.type);
      expect(source.ref.value.trim().length).toBeGreaterThan(0);
      expect(source.licensePolicy.trim().length).toBeGreaterThan(0);
      expect(source.applicableModels.length).toBeGreaterThan(0);
      expect(source.extractionPath).toMatch(/^Docs\/harness\//);
      expect(source.rewriteRationale.trim().length).toBeGreaterThan(0);
      expect(["unreviewed", "reviewed", "verified"]).toContain(source.evaluation.status);
      expect(source.evaluation.notes.trim().length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(source.lastReviewed))).toBe(false);
    }
  });

  it("records a concrete extraction location and explains applicability and rewrites for every family", async () => {
    const manifest = await readManifest();
    for (const source of manifest.sources) {
      expect(source.extractionPath.trim().length).toBeGreaterThan(0);
      expect(source.applicableModels.join(" ")).toMatch(new RegExp(source.family.replace("-", "[- ]?"), "i"));
      expect(source.rewriteRationale).toMatch(/rewrite|改写|adapt/i);
    }
    const guide = await readFile(join(HARNESS_ROOT, "README.md"), "utf8");
    expect(guide).toMatch(/Factory profiles|Factory Profile/i);
    expect(guide).toMatch(/not copied|不复制|paraphrase|改写/i);
  });

  it("registers a public harness:check script rather than hiding the checker behind the TUI", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["harness:check"]).toMatch(/harness.*check|check.*harness/i);
  });
});

describe("M7 harness:check read-only behavior", () => {
  it("prints an upstream-change report and does not mutate the manifest or extraction library", async () => {
    const before = await snapshotFiles(HARNESS_ROOT);
    const result = await execFileAsync("npm", ["run", "harness:check"], {
      cwd: ROOT,
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(`${result.stdout}\n${result.stderr}`).toMatch(/upstream.*change|上游.*变化/i);
    expect(await snapshotFiles(HARNESS_ROOT)).toEqual(before);
  });
});
