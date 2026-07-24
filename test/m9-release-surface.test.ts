import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_REGISTRY, resolveCommand } from "../src/domain/commands.js";

const ROOT = resolve(import.meta.dirname, "..");

async function filesBelow(root: string, extension: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(path, extension)));
    else if (entry.isFile() && entry.name.endsWith(extension)) output.push(path);
  }
  return output.sort();
}

async function joinedSources(paths: string[]): Promise<string> {
  const parts = await Promise.all(
    paths.map(async (path) => `\n--- ${relative(ROOT, path)} ---\n${await readFile(path, "utf8")}`),
  );
  return parts.join("");
}

describe("M9 production release surface", () => {
  it("contains no deferred Update implementation or demo Question/Tool/Provider surface", async () => {
    const production = await joinedSources(await filesBelow(join(ROOT, "src"), ".ts"));

    expect(production).not.toMatch(/\/update\b/);
    expect(production).not.toMatch(/(?:Demo|演示)\s*(?:Question|Tool|Provider)/i);
    expect(production).not.toMatch(/from\s+["'][^"']*\/update\//);
    expect(production).not.toMatch(/\bFixtureUpdateBackend\b|\bUpdateBackend\b|\bUpdateSnapshot\b/);
    expect(production).not.toMatch(/import\s*\{[^}]*\bQUESTIONS\b[^}]*\}\s*from\s*["'][^"']*fixtures/);
  });

  it("keeps the production command catalog truthful and fully wired", () => {
    for (const command of ["/update", "/demo-question", "/demo-tool", "/demo-provider"]) {
      expect(resolveCommand(command), `${command} must not resolve`).toBeUndefined();
    }

    for (const id of ["plan", "prompt", "policy"]) {
      expect(
        ACTION_REGISTRY.find((action) => action.id === id),
        `${id} was delivered before M9`,
      ).toMatchObject({
        availability: "enabled",
        handler: expect.any(String),
      });
    }
    expect(ACTION_REGISTRY.every((action) => action.availability === "enabled" || Boolean(action.disabledReason))).toBe(
      true,
    );
  });

  it("does not advertise removed surfaces or imply fixture fallback in release documentation", async () => {
    const docs = await joinedSources([join(ROOT, "README.md"), ...(await filesBelow(join(ROOT, "Docs"), ".md"))]);

    expect(docs).not.toMatch(/\/update\b/);
    expect(docs).not.toMatch(/(?:Demo|演示)\s*(?:Question|Tool|Provider)/i);
    expect(docs).toMatch(/VSPi_FIXTURE=1/);
    expect(docs).toMatch(/不(?:会|会静默)?(?:回退|切换)(?:.{0,40})Fixture/i);
    expect(docs).toMatch(/(?:setup error|配置错误|启动失败)/i);
  });
});
